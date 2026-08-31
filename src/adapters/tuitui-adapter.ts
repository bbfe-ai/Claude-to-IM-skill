//! 推推渠道 adapter：WS 入站 → InboundMessage；HTTP 出站（文本/interactive 权限卡片）；
//! action 回调 → bridge 权限 broker；入站媒体下载为 FileAttachment。

import type {
  ChannelType, FileAttachment, InboundMessage, OutboundMessage, SendResult,
} from 'claude-to-im/src/lib/bridge/types.js';
import { BaseChannelAdapter, registerAdapterFactory } from 'claude-to-im/src/lib/bridge/channel-adapter.js';
import { getBridgeContext } from 'claude-to-im/src/lib/bridge/context.js';
import { downloadToAttachment, modifyInteractive, sendInteractive, sendText } from './tuitui/tuitui-api.js';
import { TuituiWsClient, testTuituiConnection } from './tuitui/tuitui-ws.js';
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
    const preflight = await testTuituiConnection(creds);
    if (!preflight.ok) {
      console.error(`[tuitui-adapter] 连接预检失败: ${preflight.error}`);
      return;
    }
    this._running = true;
    this.client = new TuituiWsClient(creds, (frame) => {
      // 单帧处理失败不能崩 daemon——记日志即可，WS 连接继续
      this.handleFrame(frame).catch((err) => {
        console.error('[tuitui-adapter] handleFrame error:', err instanceof Error ? err.message : err);
      });
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
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
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

  private async handleFrame(frame: ParsedFrame): Promise<void> {
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
    if (creds.mediaEnabled) {
      attachments = [];
      for (const url of chat.imageUrls.slice(0, 9)) {
        const att = await downloadToAttachment(url, undefined);
        if (att) attachments.push(att);
      }
      if (chat.file?.url) {
        const att = await downloadToAttachment(chat.file.url, chat.file.name);
        if (att) attachments.push(att);
      }
      if (attachments.length === 0) attachments = undefined;
    }

    const text = chat.text.trim();
    if (!text && !attachments) return null;

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
      raw: chat,
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
  return {
    id: `perm_${permId}`,
    url: cardUrl,
    mobileurl: cardUrl,
    head: { text: 'Permission Required', bgcolor: '#2C3E50', tcolor: '#FFFFFF' },
    body: { content: stripHtml(message.text) },
    footer: [],
    action: flatButtons.map((btn, i) => ({
      text: btn.text,
      name: `perm_${i}_${permId}`,
      value: btn.callbackData,
      color: 'FFFFFF',
      bgcolor: bgForAction(btn.callbackData),
    })),
  };
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
