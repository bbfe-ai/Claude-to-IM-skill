//! 推推渠道 adapter：WS 入站 → InboundMessage；HTTP 出站（文本/interactive 权限卡片）；
//! action 回调 → bridge 权限 broker；入站媒体下载为 FileAttachment。

import type {
  ChannelType, FileAttachment, InboundMessage, OutboundMessage, SendResult,
} from 'claude-to-im/src/lib/bridge/types.js';
import { BaseChannelAdapter, registerAdapterFactory } from 'claude-to-im/src/lib/bridge/channel-adapter.js';
import { getBridgeContext } from 'claude-to-im/src/lib/bridge/context.js';
import { downloadToAttachment, modifyInteractive, sendInteractive, sendText } from './tuitui/tuitui-api.js';
import { TuituiWsClient } from './tuitui/tuitui-ws.js';
import { decodeTuituiChatId, encodeTuituiChatId, type TuituiChatKind } from './tuitui/tuitui-ids.js';
import {
  DEFAULT_API_ENDPOINT, DEFAULT_CARD_URL,
  type InteractiveCard, type ParsedChatMessage, type ParsedFrame, type TuituiCredentials,
} from './tuitui/tuitui-types.js';

export class TuituiAdapter extends BaseChannelAdapter {
  readonly channelType: ChannelType = 'tuitui';

  private _running = false;
  private client: TuituiWsClient | null = null;
  private queue: InboundMessage[] = [];
  private waiters: Array<(msg: InboundMessage | null) => void> = [];
  private frameChain: Promise<void> = Promise.resolve();

  private credentials(): TuituiCredentials | null {
    const { store } = getBridgeContext();
    const appid = store.getSetting('bridge_tuitui_appid') || '';
    const secret = store.getSetting('bridge_tuitui_secret') || '';
    if (!appid || !secret) return null;
    return {
      appid,
      secret,
      apiBase: store.getSetting('bridge_tuitui_api_base') || DEFAULT_API_ENDPOINT,
      botName: store.getSetting('bridge_tuitui_bot_name') || '',
      cardUrl: store.getSetting('bridge_tuitui_card_url') || DEFAULT_CARD_URL,
      mediaEnabled: store.getSetting('bridge_tuitui_media_enabled') === 'true',
    };
  }

  async start(): Promise<void> {
    if (this._running) return;
    const creds = this.credentials();
    if (!creds) {
      console.log('[tuitui-adapter] 未配置推推凭据（bridge_tuitui_appid/secret），adapter 空转');
      return;
    }
    this._running = true;
    // 首次连接失败不阻塞启动——TuituiWsClient 的退避重连兜底；
    // 认证失败（401/403）由客户端熔断停止重连并打明确错误日志
    this.client = new TuituiWsClient(creds, (frame) => {
      this.handleFrame(frame);
    });
    this.client.start();
  }

  async stop(): Promise<void> {
    if (!this._running) return;
    this._running = false;
    this.client?.stop();
    this.client = null;
    this.queue = [];
    for (const waiter of this.waiters) waiter(null);
    this.waiters = [];
  }

  isRunning(): boolean {
    return this._running;
  }

  async consumeOne(): Promise<InboundMessage | null> {
    if (this.queue.length > 0) return this.queue.shift()!;
    if (!this._running) return null;
    return new Promise<InboundMessage | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  validateConfig(): string | null {
    const creds = this.credentials();
    if (!creds) {
      return '缺少推推凭据：请配置 CTI_TUITUI_APPID 和 CTI_TUITUI_SECRET。';
    }
    return null;
  }

  isAuthorized(): boolean {
    return true;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const creds = this.credentials();
    if (!creds) return { ok: false, error: 'Tuitui 未配置 appid/secret' };
    const decoded = decodeTuituiChatId(message.address.chatId);
    if (!decoded || decoded.appid !== creds.appid) {
      return { ok: false, error: 'Invalid tuitui chatId format' };
    }
    try {
      if (message.inlineButtons && message.inlineButtons.length > 0) {
        const result = await sendInteractive(creds, decoded.target, buildCardFromInlineButtons(message, creds.cardUrl));
        return result.ok ? { ok: true, messageId: result.messageId } : { ok: false, error: result.error };
      }
      const result = await sendText(creds, decoded.target, stripFormatting(message.text, message.parseMode), {
        referenceMsgid: message.replyToMessageId,
      });
      return result.ok ? { ok: true, messageId: result.messageId } : { ok: false, error: result.error };
    } catch (err) {
      // 兜底脱敏: postJson 已吞掉大部分错误，此处双保险防止凭据泄漏
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg.replaceAll(creds.appid, '***').replaceAll(creds.secret, '***') };
    }
  }

  // ── 内部 ────────────────────────────────────────────────

  private enqueue(message: InboundMessage): void {
    if (this.waiters.length > 0) {
      this.waiters.shift()!(message);
      return;
    }
    this.queue.push(message);
  }

  private handleFrame(frame: ParsedFrame): Promise<void> {
    // 串行化: 帧内媒体下载是 await, 必须保证帧间顺序（先图后文不交错）
    const next = this.frameChain.then(async () => {
      await this.processFrame(frame);
    });
    this.frameChain = next.catch((err) => {
      console.error('[tuitui-adapter] handleFrame error:', err instanceof Error ? err.message : err);
    });
    return this.frameChain;
  }

  private async processFrame(frame: ParsedFrame): Promise<void> {
    if (frame.chat && frame.chat.mentioned) {
      const msg = await this.chatToInbound(frame.chat);
      if (msg) this.enqueue(msg);
    } else if (frame.callback) {
      this.enqueue(this.callbackToInbound(frame.callback));
      void this.updateCardAfterCallback(frame.callback);
    }
  }

  private async chatToInbound(chat: ParsedChatMessage): Promise<InboundMessage | null> {
    const creds = this.credentials();
    if (!creds) return null;
    const kind: TuituiChatKind = chat.groupId ? 'group' : 'single';
    const target = chat.groupId ?? chat.senderId;
    const chatId = encodeTuituiChatId(creds.appid, kind, target);

    let attachments: FileAttachment[] | undefined;
    let failedCount = 0;
    if (creds.mediaEnabled) {
      attachments = [];
      for (const url of chat.imageUrls.slice(0, 9)) {
        const att = await downloadToAttachment(url, undefined);
        if (att) attachments.push(att);
        else { failedCount++; console.warn(`[tuitui-adapter] 图片下载失败: ${url.slice(0, 200)}`); }
      }
      const fileList = chat.files && chat.files.length > 0
        ? chat.files
        : chat.file ? [chat.file] : [];
      for (const f of fileList) {
        if (!f.url) continue;
        const att = await downloadToAttachment(f.url, f.name);
        if (att) attachments.push(att);
        else { failedCount++; console.warn(`[tuitui-adapter] 文件下载失败: ${f.url.slice(0, 200)}`); }
      }
      if (attachments.length === 0) attachments = undefined;
    }

    const text = chat.text.trim();
    if (!text && !attachments && failedCount === 0) return null;

    // 对齐 weixin adapter: 下载失败的消息不静默丢弃，透传 raw 标记让 bridge 回复失败提示
    const raw = failedCount > 0 && attachments === undefined && !text
      ? {
          appid: creds.appid,
          originalMessage: chat,
          attachmentDownloadFailed: true,
          failedCount,
          failedLabel: 'attachment(s)',
        }
      : chat;

    return {
      messageId: chat.msgId ?? `tuitui_${chat.senderId}_${Date.now()}`,
      address: {
        channelType: 'tuitui',
        chatId,
        userId: chat.senderId,
        displayName: chat.senderName ?? chat.senderId.slice(0, 12),
      },
      text,
      timestamp: Date.now(),
      raw,
      attachments,
    };
  }

  private callbackToInbound(callback: { msgId?: string; callbackData?: string; senderId: string; senderName?: string; groupId?: string }): InboundMessage {
    const creds = this.credentials();
    const kind: TuituiChatKind = callback.groupId ? 'group' : 'single';
    const target = callback.groupId ?? callback.senderId;
    const chatId = creds ? encodeTuituiChatId(creds.appid, kind, target) : `${kind}:${target}`;
    return {
      messageId: `tuitui_cb_${Date.now()}`,
      address: {
        channelType: 'tuitui',
        chatId,
        userId: callback.senderId,
        displayName: callback.senderName ?? callback.senderId.slice(0, 12),
      },
      text: '',
      timestamp: Date.now(),
      callbackData: callback.callbackData,
      callbackMessageId: callback.msgId,
      raw: callback,
    };
  }

  /** 按钮点击后把卡片更新为已批准/已拒绝（fire-and-forget，失败仅记日志）。 */
  private async updateCardAfterCallback(callback: { msgId?: string; callbackData?: string; groupId?: string; senderId: string }): Promise<void> {
    if (!callback.callbackData?.startsWith('perm:')) return;
    const creds = this.credentials();
    if (!creds || !callback.msgId) return;
    const kind: TuituiChatKind = callback.groupId ? 'group' : 'single';
    const target = callback.groupId ?? callback.senderId;
    const denied = callback.callbackData?.startsWith('perm:deny:') ?? false;
    const result = await modifyInteractive(
      creds,
      target,
      callback.msgId,
      buildDecisionCard(creds.cardUrl, denied ? '已拒绝' : '已批准', denied ? 'deny' : 'allow'),
    );
    if (!result.ok) console.warn(`[tuitui-adapter] 权限卡片更新失败: ${result.error}`);
  }
}

export function buildCardFromInlineButtons(message: OutboundMessage, cardUrl: string): InteractiveCard {
  const flatButtons = (message.inlineButtons ?? []).flat();
  const permId = flatButtons[0]?.callbackData.split(':').slice(2).join(':') ?? 'unknown';
  // 卡片中文化: 按钮文案按 callbackData 前缀映射（broker 的英文文案是上游共用，不动）
  const bodyContent = stripHtml(message.text)
    .replaceAll('Permission Required', '权限请求')
    .replaceAll('Choose an action:', '请选择操作：')
    .replaceAll('Permission response recorded.', '权限已记录。');
  return {
    id: `perm_${permId}`,
    url: cardUrl,
    mobileurl: cardUrl,
    head: { text: '权限请求', bgcolor: '#2C3E50', tcolor: '#FFFFFF' },
    body: { content: bodyContent },
    footer: [],
    action: flatButtons.map((btn, i) => ({
      text: buttonLabel(btn.callbackData) ?? btn.text,
      name: `perm_${i}_${permId}`,
      value: btn.callbackData,
      color: 'FFFFFF',
      bgcolor: bgForAction(btn.callbackData),
    })),
  };
}

/** 已知权限按钮的英文标签映射为中文；未知标签保持原样。 */
function buttonLabel(callbackData: string): string | undefined {
  if (callbackData.startsWith('perm:allow_session:')) return '允许本次会话';
  if (callbackData.startsWith('perm:deny:')) return '拒绝';
  if (callbackData.startsWith('perm:allow:')) return '允许';
  return undefined;
}

export function buildDecisionCard(cardUrl: string, statusText: string, action: 'allow' | 'deny'): InteractiveCard {
  return {
    id: `decision_${Date.now()}`,
    url: cardUrl,
    mobileurl: cardUrl,
    head: { text: action === 'allow' ? '已批准' : '已拒绝', bgcolor: action === 'allow' ? '#27AE60' : '#E74C3C', tcolor: '#FFFFFF' },
    body: { content: `权限请求已${action === 'allow' ? '批准' : '拒绝'}` },
    footer: [{ text: '状态', rtext: statusText }],
    action: [],
  };
}

function bgForAction(callbackData: string): string {
  if (callbackData.startsWith('perm:allow_session:')) return '2980B9';
  if (callbackData.startsWith('perm:deny:')) return 'E74C3C';
  return '27AE60';
}

export function stripHtml(text: string): string {
  return text
    .replace(/<([^>]+)>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}

function stripFormatting(text: string, parseMode?: 'HTML' | 'Markdown' | 'plain'): string {
  if (parseMode === 'HTML') return stripHtml(text);
  if (parseMode === 'Markdown') {
    return text
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/__(.*?)__/g, '$1')
      .replace(/\*(.*?)\*/g, '$1')
      .replace(/_(.*?)_/g, '$1')
      .replace(/`{3}[\s\S]*?`{3}/g, (match) => match.replace(/`{3}\w*\n?/g, '').replace(/`{3}/g, ''))
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  }
  return text;
}

registerAdapterFactory('tuitui', () => new TuituiAdapter());
