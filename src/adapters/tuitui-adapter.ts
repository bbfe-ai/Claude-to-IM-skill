//! 推推渠道 adapter：WS 入站 → InboundMessage；HTTP 出站（文本/interactive 权限卡片）；
//! action 回调 → bridge 权限 broker；入站媒体下载为 FileAttachment。

import type {
  ChannelType, FileAttachment, InboundMessage, OutboundMessage, SendResult, ToolCallInfo,
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

/** 处理中状态卡的最小更新间隔（毫秒），防 modifyInteractive 刷接口。 */
const CARD_THROTTLE_MS = 1500;

/** 卡片正文截断长度（推推正文过长会被折叠）。 */
const CARD_BODY_MAX_CHARS = 400;

/** 卡片生命周期阶段。 */
export type ProcessingPhase = 'received' | 'streaming' | 'completed' | 'error' | 'interrupted';

interface ProcessingCardState {
  /** 发送目标（单聊 senderId / 群聊 groupId）。 */
  target: string;
  /** 已创建卡片的 messageId（modifyInteractive 更新用）。 */
  cardMsgId: string;
  /** 最近一次更新时刻，用于节流。 */
  lastUpdateAt: number;
  pendingText: string;
  throttleTimer: ReturnType<typeof setTimeout> | null;
  /** 当前活跃工具列表（footer 展示）。 */
  tools: ToolCallInfo[];
}

export class TuituiAdapter extends BaseChannelAdapter {
  readonly channelType: ChannelType = 'tuitui';

  private _running = false;
  private client: TuituiWsClient | null = null;
  private queue: InboundMessage[] = [];
  private waiters: Array<(msg: InboundMessage | null) => void> = [];
  private frameChain: Promise<void> = Promise.resolve();
  /** chatId → 处理中状态卡（同一会话同时只维护一张）。 */
  private processingCards = new Map<string, ProcessingCardState>();

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
    for (const state of this.processingCards.values()) {
      if (state.throttleTimer) clearTimeout(state.throttleTimer);
    }
    this.processingCards.clear();
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

  // ── 处理中状态卡（streaming card，参考 intent-os 流式状态反馈）──────────────

  /**
   * 消息被消费时先回一张"已收到，处理中"卡；若该会话已有活跃卡则跳过。
   * fire-and-forget，失败仅记日志。
   */
  private async notifyProcessing(chatId: string): Promise<void> {
    if (this.processingCards.has(chatId)) return;
    const creds = this.credentials();
    const decoded = decodeTuituiChatId(chatId);
    if (!creds || !decoded || decoded.appid !== creds.appid) return;

    const card = buildProcessingCard('received', '', [], creds.cardUrl);
    const result = await sendInteractive(creds, decoded.target, card);
    if (!result.ok || !result.messageId) {
      console.warn(`[tuitui-adapter] 处理中卡片发送失败: ${result.error ?? '无 messageId'}`);
      return;
    }
    this.processingCards.set(chatId, {
      target: decoded.target,
      cardMsgId: result.messageId,
      lastUpdateAt: 0,
      pendingText: '',
      throttleTimer: null,
      tools: [],
    });
  }

  /**
   * bridge 流式输出正文时更新卡片（节流 + trailing-edge，参考 feishu 实现）。
   */
  onStreamText(chatId: string, fullText: string): void {
    const state = this.processingCards.get(chatId);
    if (!state) return;
    state.pendingText = fullText.length > CARD_BODY_MAX_CHARS
      ? fullText.slice(0, CARD_BODY_MAX_CHARS) + '…'
      : fullText;
    this.scheduleCardUpdate(chatId, state);
  }

  /**
   * 工具调用状态变化时更新卡片 footer（当前工具名）。
   */
  onToolEvent(chatId: string, tools: ToolCallInfo[]): void {
    const state = this.processingCards.get(chatId);
    if (!state) return;
    state.tools = tools;
    this.scheduleCardUpdate(chatId, state);
  }

  /**
   * 处理结束：卡片 finalize 为完成/错误/中断状态。
   * 返回 false —— 正式正文仍由 bridge 以 sendText 发送（可引用、可复制）。
   */
  async onStreamEnd(chatId: string, status: 'completed' | 'interrupted' | 'error', _responseText: string): Promise<boolean> {
    const state = this.processingCards.get(chatId);
    if (!state) return false;
    if (state.throttleTimer) {
      clearTimeout(state.throttleTimer);
      state.throttleTimer = null;
    }
    const creds = this.credentials();
    const phase: ProcessingPhase = status === 'completed' ? 'completed'
      : status === 'interrupted' ? 'interrupted' : 'error';
    if (creds) {
      const result = await modifyInteractive(
        creds, state.target, state.cardMsgId,
        buildProcessingCard(phase, state.pendingText, state.tools, creds.cardUrl),
      );
      if (!result.ok) console.warn(`[tuitui-adapter] 处理结束卡片更新失败: ${result.error}`);
    }
    this.processingCards.delete(chatId);
    return false;
  }

  /** 消息处理结束后的兜底清理（防状态卡泄漏）。 */
  onMessageEnd(chatId: string): void {
    const state = this.processingCards.get(chatId);
    if (!state) return;
    if (state.throttleTimer) clearTimeout(state.throttleTimer);
    this.processingCards.delete(chatId);
  }

  /** 节流调度：距上次更新 ≥CARD_THROTTLE_MS 立即刷，否则排 trailing-edge 定时器。 */
  private scheduleCardUpdate(chatId: string, state: ProcessingCardState): void {
    const elapsed = Date.now() - state.lastUpdateAt;
    if (elapsed >= CARD_THROTTLE_MS && state.lastUpdateAt > 0) {
      if (state.throttleTimer) { clearTimeout(state.throttleTimer); state.throttleTimer = null; }
      void this.flushCardUpdate(chatId, state);
      return;
    }
    if (!state.throttleTimer) {
      const delay = state.lastUpdateAt === 0 ? 0 : CARD_THROTTLE_MS - elapsed;
      state.throttleTimer = setTimeout(() => {
        state.throttleTimer = null;
        void this.flushCardUpdate(chatId, state);
      }, Math.max(delay, 0));
    }
  }

  private async flushCardUpdate(chatId: string, state: ProcessingCardState): Promise<void> {
    const creds = this.credentials();
    if (!creds) return;
    const result = await modifyInteractive(
      creds, state.target, state.cardMsgId,
      buildProcessingCard('streaming', state.pendingText, state.tools, creds.cardUrl),
    );
    if (result.ok) state.lastUpdateAt = Date.now();
    else console.warn(`[tuitui-adapter] 处理中卡片更新失败: ${result.error}`);
  }

  // ── 内部 ────────────────────────────────────────────────

  private enqueue(message: InboundMessage): void {
    // 每条入站消息（群聊@/单聊/回调）统一在此进入系统：
    // 普通消息（非按钮回调/非命令）先回一张"处理中"卡，让用户立即知道
    // Claude 已收到并在处理（参考 intent-os 的流式状态反馈）。
    // fire-and-forget：卡片失败不影响消息处理主链路。
    if (!message.callbackData && !message.text.trim().startsWith('/')) {
      void this.notifyProcessing(message.address.chatId);
    }
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

/**
 * 构建"处理中"状态卡（参考 intent-os 的流式状态反馈形态）。
 *
 * - received:   刚收到消息，Claude 开始处理
 * - streaming:  正在思考/输出（footer 展示当前工具）
 * - completed:  处理完成（正式正文由 sendText 单独发送，卡片只做状态收尾）
 * - error:      处理出错
 * - interrupted: 被用户/超时中断
 */
export function buildProcessingCard(phase: ProcessingPhase, text: string, tools: ToolCallInfo[], cardUrl = DEFAULT_CARD_URL): InteractiveCard {
  const running = tools.filter(t => t.status === 'running');
  const toolText = running.length > 0
    ? `正在调用工具：${running.map(t => t.name).join('、')}`
    : (tools.length > 0 ? `已完成 ${tools.length} 次工具调用` : '正在思考');
  const head = {
    text: '🤖 Claude 处理中',
    bgcolor: phase === 'error' ? '#C0392B' : phase === 'completed' ? '#27AE60' : '#2C3E50',
    tcolor: '#FFFFFF',
  };
  let bodyText: string;
  let footerText: string;
  switch (phase) {
    case 'received':
      bodyText = '已收到你的消息，Claude 正在处理…';
      footerText = '处理中';
      break;
    case 'streaming':
      bodyText = text.trim() ? `正在输出：\n${text}` : toolText;
      footerText = running.length > 0 ? `🔧 ${running[0]!.name}` : '处理中';
      break;
    case 'completed':
      bodyText = '处理完成，回复已发送。';
      footerText = '✅ 已完成';
      break;
    case 'error':
      bodyText = '处理出错，请稍后重试或查看日志。';
      footerText = '❌ 出错';
      break;
    case 'interrupted':
      bodyText = '任务已中断。';
      footerText = '⏹ 已中断';
      break;
  }
  return {
    id: `status_${Date.now()}`,
    url: cardUrl,
    mobileurl: cardUrl,
    head,
    body: { content: bodyText },
    footer: [{ text: '状态', rtext: footerText }],
    action: [],
  };
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
