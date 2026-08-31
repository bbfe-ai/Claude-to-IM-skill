//! TuiTui 推推协议类型与 WS 帧解析。
//! 协议事实来源: intent-os-platform crates/domain/intent-im-bridge/src/tuitui_provider.rs

export interface TuituiCredentials {
  appid: string;
  secret: string;
  apiBase: string;
  botName: string;
  cardUrl: string;
  mediaEnabled: boolean;
}

export interface InteractiveCard {
  id: string;
  url: string;
  mobileurl: string;
  head: { text: string; bgcolor: string; tcolor: string };
  body: { content: string };
  footer: Array<{ text: string; rtext: string }>;
  action: Array<{ text: string; name: string; value: string; color: string; bgcolor: string }>;
}

export interface ParsedFrame {
  /** 非 null 时必须回 ACK {"ack": event_id} */
  eventId: string | null;
  /** single_chat / group_chat 消息 */
  chat?: ParsedChatMessage;
  /** action 回调（权限卡片按钮点击） */
  callback?: ParsedActionCallback;
}

export interface ParsedChatMessage {
  msgId?: string;
  senderId: string;
  senderName?: string;
  groupId?: string;
  msgType: string;
  text: string;
  imageUrls: string[];
  file?: { name?: string; url?: string };
  /** 多文件消息（联调实测 data.files 数组） */
  files?: Array<{ name?: string; url?: string }>;
  /** 群聊:@提及命中; 单聊: true */
  mentioned: boolean;
}

export interface ParsedActionCallback {
  /** 被点击卡片的原 msgid */
  msgId?: string;
  callbackData?: string;
  senderId: string;
  senderName?: string;
  groupId?: string;
}

export const DEFAULT_API_ENDPOINT = 'https://alarm.im.qihoo.net';
export const DEFAULT_CARD_URL = 'https://intent-os.qihoo.net';
export const WS_HOST = 'wss://alarm.im.qihoo.net';
export const MAX_RECONNECT_ATTEMPTS = 100;

const PERM_RE = /^perm:(allow|allow_session|deny):([A-Za-z0-9_-]+)$/;

export function parseWsFrame(raw: string, botAppid: string, botName: string): ParsedFrame {
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return { eventId: null };
  }
  const obj = envelope as { event_id?: unknown; body?: Record<string, unknown> };
  const eventId = typeof obj.event_id === 'string' ? obj.event_id : null;
  const body = obj.body;
  if (!body || typeof body !== 'object') return { eventId };

  const event = typeof body.event === 'string' ? body.event : '';
  if (event === 'keepalive') return { eventId };

  const data = (body.data && typeof body.data === 'object' ? body.data : {}) as Record<string, unknown>;
  const senderId = typeof body.user_account === 'string' ? body.user_account : '';
  const senderName = typeof body.user_name === 'string' ? body.user_name : undefined;
  const groupIdRaw = typeof body.group_id === 'string' ? body.group_id : '';
  const groupId = groupIdRaw !== '' ? groupIdRaw : undefined;

  if (event === 'single_chat' || event === 'group_chat') {
    const isGroup = event === 'group_chat';
    let msgType = typeof body.msgtype === 'string'
      ? body.msgtype
      : typeof data.msg_type === 'string' ? data.msg_type : 'unknown';
    let text = typeof body.text === 'string'
      ? body.text
      : typeof data.text === 'string' ? data.text : '';
    // chat_open 事件仅在有文本时才作为 text 消息处理
    if (msgType === 'single_chat_open' || msgType === 'group_chat_open') {
      if (!text.trim()) return { eventId };
      msgType = 'text';
    }
    const imageUrls: string[] = [];
    let file: { name?: string; url?: string } | undefined;
    let files: Array<{ name?: string; url?: string }> | undefined;
    if (msgType === 'image') {
      if (Array.isArray(data.images)) {
        imageUrls.push(...data.images.filter((i): i is string => typeof i === 'string'));
      }
    } else if (msgType === 'file') {
      const f = data.file && typeof data.file === 'object'
        ? (data.file as Record<string, unknown>) : undefined;
      if (f && typeof f.url === 'string') {
        file = { url: f.url, name: typeof f.name === 'string' ? f.name : undefined };
      }
      // 联调实测: 多文件消息用 data.files 数组（含单文件场景）
      if (Array.isArray(data.files)) {
        const list = data.files
          .filter((it): it is Record<string, unknown> => !!it && typeof it === 'object')
          .map((it) => ({ url: typeof it.url === 'string' ? it.url : '', name: typeof it.name === 'string' ? it.name : undefined }))
          .filter((it) => it.url !== '');
        if (list.length > 0) files = list;
      }
    } else if (msgType === 'mixed') {
      // mixed 消息图片/文件平铺在事件顶层（Rust serde flatten extra），fallback data.images
      if (Array.isArray(body.images)) {
        imageUrls.push(...body.images.filter((i): i is string => typeof i === 'string'));
      }
      if (imageUrls.length === 0 && Array.isArray(data.images)) {
        imageUrls.push(...data.images.filter((i): i is string => typeof i === 'string'));
      }
      const f = body.file && typeof body.file === 'object'
        ? (body.file as Record<string, unknown>) : undefined;
      if (f && typeof f.url === 'string') {
        file = { url: f.url, name: typeof f.name === 'string' ? f.name : undefined };
      }
    }
    const mentioned = isGroup ? checkMentioned(body.at_users, text, botAppid, botName) : true;
    return {
      eventId,
      chat: {
        msgId: typeof data.msgid === 'string' ? data.msgid : undefined,
        senderId,
        senderName,
        groupId,
        msgType,
        text,
        imageUrls,
        file,
        files,
        mentioned,
      },
    };
  }

  // 非 chat 事件: 尝试提取权限卡片回调（perm: allow|allow_session|deny）
  const callbackData = findPermCallbackData(body);
  if (callbackData) {
    // 联调实测: 回调帧的 msgid 在 data.message.msgid（回执原卡片），data.msgid 兜底
    const messageObj = data.message && typeof data.message === 'object'
      ? (data.message as Record<string, unknown>) : undefined;
    const msgId = typeof messageObj?.msgid === 'string'
      ? messageObj.msgid
      : typeof data.msgid === 'string' ? data.msgid : undefined;
    return {
      eventId,
      callback: {
        msgId,
        callbackData,
        senderId,
        senderName,
        groupId,
      },
    };
  }
  return { eventId };
}

export function checkMentioned(
  atUsers: unknown,
  text: string,
  botAppid: string,
  botName: string,
): boolean {
  if (Array.isArray(atUsers)) {
    for (const u of atUsers) if (u === botAppid) return true;
  } else if (typeof atUsers === 'string') {
    if (atUsers.split(',').some((s) => s.trim() === botAppid)) return true;
  }
  if (botName !== '' && text.includes(`@${botName}`)) return true;
  if (text.includes(`@${botAppid}`)) return true;
  return false;
}

export function findPermCallbackData(body: Record<string, unknown>): string | undefined {
  // 结构化候选路径（联调实测: 回调帧为 body.data.message.action[]，value 在数组元素里；
  // Rust 版未知字段 flatten 到 body 顶层，故保留 body 级候选）
  const candidates: string[][] = [
    ['data', 'message', 'action', 'value'],
    ['data', 'message', 'action', 'name'],
    ['message', 'action', 'value'],
    ['action', 'value'],
    ['action', 'name'],
  ];
  for (const path of candidates) {
    const cur = lookupPath(body, path);
    if (typeof cur === 'string' && PERM_RE.test(cur)) return cur;
  }
  // 兜底: 全量序列化扫描（联调期未知字段布局的防御）
  const scanned = JSON.stringify(body).match(/perm:(allow|allow_session|deny):[A-Za-z0-9_-]+/);
  return scanned ? scanned[0] : undefined;
}

/** 按路径取对象字段，中间值若是数组则逐个元素尝试（action 数组场景）。 */
function lookupPath(root: unknown, path: string[]): unknown {
  let cur: unknown = root;
  for (const key of path) {
    if (Array.isArray(cur)) {
      let found: unknown = undefined;
      for (const item of cur) {
        const v = lookupPath(item, [key]);
        if (v !== undefined) { found = v; break; }
      }
      cur = found;
    } else if (cur && typeof cur === 'object' && key in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return cur;
}
