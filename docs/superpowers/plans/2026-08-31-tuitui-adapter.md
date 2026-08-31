# 推推（TuiTui）渠道 adapter 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Claude-to-IM-skill 中新增推推渠道 adapter，支持单聊+群聊（@提及）、interactive 卡片按钮权限审批、入站图片/文件媒体，协议移植自 intent-os-platform 的 Rust `TuituiProvider`。

**Architecture:** 新增 `TuituiAdapter`（`BaseChannelAdapter` 子类）与 `src/adapters/tuitui/` 协议层（types/ids/api/ws）。出站走 HTTP POST `https://alarm.im.qihoo.net/message/custom/send?appid=&secret=`，入站走 WS 长连接 `wss://alarm.im.qihoo.net/callback/ws?auth=appid.secret`（每事件 3 秒内 ACK `{"ack": event_id}`）。权限审批复用 bridge 包现成流程：permission-broker 发 `inlineButtons` → adapter 渲染为 interactive 卡片 → WS action 回调 → `InboundMessage{callbackData, callbackMessageId}` → `handlePermissionCallback`。

**Tech Stack:** Node.js >= 20（全局 `fetch`）、TypeScript（tsx/node:test）、`ws` 包（WebSocket）、`claude-to-im` 本地 file: 依赖（`/ssd2/baobao/Claude-to-IM`）。

**范围修正（相对 spec，已随实现确认）：** 出站媒体（Claude 发图/文件给推推用户）不进入 v1 —— bridge 包的 `OutboundMessage` 只有 text/inlineButtons/replyToMessageId，没有文件载体，框架层不支持（微信 adapter 同为纯文本出站）。v1 媒体能力 = **入站**（用户发图/文件 → Claude），出站媒体列为 future work。

**仓库与分支：**
- skill：`/ssd2/baobao/Claude-to-IM-skill`，工作分支 `feature/tuitui-adapter`（已建，spec 已提交）
- 依赖：`/ssd2/baobao/Claude-to-IM`（已克隆，`npm install` 会经 `file:` 依赖 + prepare 钩子自动构建）

**验证基线（Task 0 前需为绿）：** `cd /ssd2/baobao/Claude-to-IM-skill && npm install && npm run typecheck && npm test`（现有 weixin 测试全部通过）。

---

### Task 0: 依赖就位与基线验证

**Files:**
- Modify: `/ssd2/baobao/Claude-to-IM-skill/package.json`（加 ws 依赖）
- 测试：无（基线验证）

- [ ] **Step 1: 在 package.json 的 dependencies 中加入 ws**

```json
    "@anthropic-ai/claude-agent-sdk": "^0.2.62",
    "claude-to-im": "file:../Claude-to-IM",
    "qrcode": "^1.5.4",
    "ws": "^8.18.0"
```

devDependencies 加 `"@types/ws": "^8.5"`。

- [ ] **Step 2: 安装依赖**

Run: `cd /ssd2/baobao/Claude-to-IM-skill && npm install`
Expected: 成功结束；`node_modules/ws` 存在；sibling `../Claude-to-IM/dist` 已由 prepare 钩子生成（`npm install` 对 `file:` 依赖触发其 build）。若 `../Claude-to-IM` 构建失败，先在该仓库跑 `npm install` 单独排查。

- [ ] **Step 3: 基线验证**

Run: `npm run typecheck && npm test`
Expected: typecheck 无错误；所有现有测试 PASS（含 weixin 系列）。若有失败，**停下**排查环境问题，不要带病进入实现。

- [ ] **Step 4: Commit**

```bash
cd /ssd2/baobao/Claude-to-IM-skill && git add package.json package-lock.json && git commit -m "chore: 新增 ws 依赖（tuitui adapter 前置）"
```

---

### Task 1: 协议类型与 WS 帧解析（tuitui-types.ts）

**Files:**
- Create: `/ssd2/baobao/Claude-to-IM-skill/src/adapters/tuitui/tuitui-types.ts`
- Test: `/ssd2/baobao/Claude-to-IM-skill/src/__tests__/tuitui-types.test.ts`

- [ ] **Step 1: 写失败的单测**（在 `src/__tests__/tuitui-types.test.ts`，用例对齐 Rust `tuitui_provider.rs` tests 模块的三个用例 + keepalive + @提及 + 回调）

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findPermCallbackData, parseWsFrame } from '../adapters/tuitui/tuitui-types.js';

describe('parseWsFrame', () => {
  it('parses single_chat_open with text as a text message', () => {
    const raw = JSON.stringify({
      event_id: 'evt-1',
      body: {
        event: 'single_chat',
        user_account: 'user-1',
        user_name: '用户',
        msgtype: 'single_chat_open',
        text: '你好',
        data: { msgid: 'msg-1' },
      },
    });
    const frame = parseWsFrame(raw, 'bot-appid', '助手');
    assert.equal(frame.eventId, 'evt-1');
    assert.ok(frame.chat);
    assert.equal(frame.chat!.msgType, 'text');
    assert.equal(frame.chat!.text, '你好');
    assert.equal(frame.chat!.senderId, 'user-1');
    assert.equal(frame.chat!.mentioned, true);
  });

  it('returns ack-only for single_chat_open without text', () => {
    const raw = JSON.stringify({
      event_id: 'evt-open',
      body: { event: 'single_chat', user_account: 'user-1', msgtype: 'single_chat_open', data: { msgid: 'msg-open' } },
    });
    const frame = parseWsFrame(raw, 'bot-appid', '助手');
    assert.equal(frame.eventId, 'evt-open');
    assert.equal(frame.chat, undefined);
  });

  it('returns ack-only for keepalive', () => {
    const raw = JSON.stringify({ event_id: 'evt-ka', body: { event: 'keepalive' } });
    const frame = parseWsFrame(raw, 'bot-appid', '助手');
    assert.equal(frame.eventId, 'evt-ka');
    assert.equal(frame.chat, undefined);
    assert.equal(frame.callback, undefined);
  });

  it('parses group_chat and applies @mention filter', () => {
    const raw = JSON.stringify({
      event_id: 'evt-g',
      body: {
        event: 'group_chat',
        user_account: 'u2',
        user_name: '同事',
        group_id: '1234567890',
        msgtype: 'text',
        text: '@助手 帮我看下代码',
        at_users: ['bot-appid'],
        data: { msgid: 'msg-g', msg_type: 'text' },
      },
    });
    const frame = parseWsFrame(raw, 'bot-appid', '助手');
    assert.ok(frame.chat);
    assert.equal(frame.chat!.groupId, '1234567890');
    assert.equal(frame.chat!.mentioned, true);
  });

  it('marks group message not mentioned when at_users lacks the bot', () => {
    const raw = JSON.stringify({
      event_id: 'evt-g2',
      body: { event: 'group_chat', user_account: 'u2', group_id: '1234567890', text: '闲聊', at_users: ['someone-else'], data: { msgid: 'm2' } },
    });
    const frame = parseWsFrame(raw, 'bot-appid', '助手');
    assert.ok(frame.chat);
    assert.equal(frame.chat!.mentioned, false);
  });

  it('extracts image url from image messages', () => {
    const raw = JSON.stringify({
      event_id: 'evt-img',
      body: {
        event: 'single_chat', user_account: 'u1', msgtype: 'image',
        data: { msgid: 'm3', msg_type: 'image', images: ['https://cdn.example.com/a.jpg'] },
      },
    });
    const frame = parseWsFrame(raw, 'bot-appid', '助手');
    assert.ok(frame.chat);
    assert.deepEqual(frame.chat!.imageUrls, ['https://cdn.example.com/a.jpg']);
  });

  it('extracts file info from file messages', () => {
    const raw = JSON.stringify({
      event_id: 'evt-f',
      body: {
        event: 'single_chat', user_account: 'u1', msgtype: 'file',
        data: { msgid: 'm4', msg_type: 'file', file: { name: 'report.pdf', url: 'https://cdn.example.com/r.pdf' } },
      },
    });
    const frame = parseWsFrame(raw, 'bot-appid', '助手');
    assert.ok(frame.chat);
    assert.equal(frame.chat!.file?.url, 'https://cdn.example.com/r.pdf');
    assert.equal(frame.chat!.file?.name, 'report.pdf');
  });

  it('parses action callback into perm: callbackData', () => {
    const raw = JSON.stringify({
      event_id: 'evt-cb',
      body: {
        event: 'interactive_action',
        user_account: 'u1',
        data: { msgid: 'card-9' },
        action: { text: '允许', name: 'perm_a', value: 'perm:allow:req-123' },
        fields: [],
      },
    });
    const frame = parseWsFrame(raw, 'bot-appid', '助手');
    assert.equal(frame.chat, undefined);
    assert.ok(frame.callback);
    assert.equal(frame.callback!.callbackData, 'perm:allow:req-123');
    assert.equal(frame.callback!.msgId, 'card-9');
    assert.equal(frame.callback!.senderId, 'u1');
  });

  it('ignores non-chat events without perm: data (ack only)', () => {
    const raw = JSON.stringify({ event_id: 'evt-x', body: { event: 'some_other_event', user_account: 'u1' } });
    const frame = parseWsFrame(raw, 'bot-appid', '助手');
    assert.equal(frame.eventId, 'evt-x');
    assert.equal(frame.callback, undefined);
  });
});

describe('findPermCallbackData', () => {
  it('falls back to regex scan over serialized body for unknown field layouts', () => {
    const data = findPermCallbackData({ event: 'interactive_action', nested: { deep: 'perm:deny:req-77' } });
    assert.equal(data, 'perm:deny:req-77');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /ssd2/baobao/Claude-to-IM-skill && CTI_HOME=$(mktemp -d) node --import tsx --test --test-concurrency=1 --test-timeout=15000 src/__tests__/tuitui-types.test.ts`
Expected: 全部 FAIL（模块不存在 / `parseWsFrame is not a function`）。

- [ ] **Step 3: 实现 tuitui-types.ts**

```ts
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
        mentioned,
      },
    };
  }

  // 非 chat 事件: 尝试提取权限卡片回调（perm: allow|allow_session|deny）
  const callbackData = findPermCallbackData(body);
  if (callbackData) {
    return {
      eventId,
      callback: {
        msgId: typeof data.msgid === 'string' ? data.msgid : undefined,
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
  // 结构化候选路径（Rust 版把未知字段 flatten 到 body 顶层）
  const candidates: string[][] = [
    ['action', 'value'],
    ['action', 'name'],
    ['message', 'action', 'value'],
    ['message', 'value'],
  ];
  for (const path of candidates) {
    let cur: unknown = body;
    let ok = true;
    for (const key of path) {
      if (cur && typeof cur === 'object' && key in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[key];
      } else {
        ok = false;
        break;
      }
    }
    if (ok && typeof cur === 'string' && PERM_RE.test(cur)) return cur;
  }
  // 兜底: 全量序列化扫描（联调期未知字段布局的防御）
  const scanned = JSON.stringify(body).match(/perm:(allow|allow_session|deny):[A-Za-z0-9_-]+/);
  return scanned ? scanned[0] : undefined;
}
```

- [ ] **Step 4: 运行确认全绿**

Run: `cd /ssd2/baobao/Claude-to-IM-skill && CTI_HOME=$(mktemp -d) node --import tsx --test --test-concurrency=1 --test-timeout=15000 src/__tests__/tuitui-types.test.ts`
Expected: 10 个测试全部 PASS；再跑 `npm run typecheck` 无错误。

- [ ] **Step 5: Commit**

```bash
cd /ssd2/baobao/Claude-to-IM-skill && git add src/adapters/tuitui/tuitui-types.ts src/__tests__/tuitui-types.test.ts && git commit -m "feat(tuitui): 协议类型与 WS 帧解析器（移植 Rust parse_ws_message）"
```

---

### Task 2: chatId 编解码与目标判定（tuitui-ids.ts）

**Files:**
- Create: `/ssd2/baobao/Claude-to-IM-skill/src/adapters/tuitui/tuitui-ids.ts`
- Test: `/ssd2/baobao/Claude-to-IM-skill/src/__tests__/tuitui-ids.test.ts`

- [ ] **Step 1: 写失败的单测**

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decodeTuituiChatId, encodeTuituiChatId, isGroupTarget } from '../adapters/tuitui/tuitui-ids.js';

describe('encodeTuituiChatId / decodeTuituiChatId', () => {
  it('round-trips single chat ids', () => {
    const encoded = encodeTuituiChatId('app-1', 'single', 'user-1');
    assert.equal(encoded, 'tuitui:app-1:single:user-1');
    assert.deepEqual(decodeTuituiChatId(encoded), { appid: 'app-1', kind: 'single', target: 'user-1' });
  });

  it('round-trips group chat ids', () => {
    const encoded = encodeTuituiChatId('app-1', 'group', '7652669649100131');
    assert.deepEqual(decodeTuituiChatId(encoded), { appid: 'app-1', kind: 'group', target: '7652669649100131' });
  });

  it('preserves colons inside the target', () => {
    const encoded = encodeTuituiChatId('app-1', 'single', 'ab:cd');
    assert.deepEqual(decodeTuituiChatId(encoded), { appid: 'app-1', kind: 'single', target: 'ab:cd' });
  });

  it('rejects malformed ids', () => {
    assert.equal(decodeTuituiChatId('tuitui:app-1:single'), null);
    assert.equal(decodeTuituiChatId('weixin:x:single:y'), null);
    assert.equal(decodeTuituiChatId('tuitui:app-1:other:y'), null);
    assert.equal(decodeTuituiChatId(''), null);
  });
});

describe('isGroupTarget', () => {
  it('treats all-digit targets as groups, everything else as users', () => {
    assert.equal(isGroupTarget('7652669649100131'), true);
    assert.equal(isGroupTarget('123'), true);
    assert.equal(isGroupTarget('baofuen'), false);
    assert.equal(isGroupTarget('user-1'), false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /ssd2/baobao/Claude-to-IM-skill && CTI_HOME=$(mktemp -d) node --import tsx --test --test-concurrency=1 --test-timeout=15000 src/__tests__/tuitui-ids.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 tuitui-ids.ts**

```ts
//! chatId 编解码与推推目标类型判定（全数字=群，否则=用户，对齐 Rust target_kind）。

export type TuituiChatKind = 'single' | 'group';

// 格式: tuitui:<appid>:<single|group>:<target>（target 可含冒号）
export function encodeTuituiChatId(appid: string, kind: TuituiChatKind, target: string): string {
  return `tuitui:${appid}:${kind}:${target}`;
}

export function decodeTuituiChatId(chatId: string): { appid: string; kind: TuituiChatKind; target: string } | null {
  const parts = chatId.split(':');
  if (parts.length < 4 || parts[0] !== 'tuitui') return null;
  const [, appid, kind, ...rest] = parts;
  if (kind !== 'single' && kind !== 'group') return null;
  const target = rest.join(':');
  if (!appid || !target) return null;
  return { appid, kind, target };
}

export function isGroupTarget(target: string): boolean {
  return /^\d+$/.test(target);
}
```

- [ ] **Step 4: 运行确认全绿**

Run: `cd /ssd2/baobao/Claude-to-IM-skill && CTI_HOME=$(mktemp -d) node --import tsx --test --test-concurrency=1 --test-timeout=15000 src/__tests__/tuitui-ids.test.ts && npm run typecheck`
Expected: 全 PASS，typecheck 无错误。

- [ ] **Step 5: Commit**

```bash
cd /ssd2/baobao/Claude-to-IM-skill && git add src/adapters/tuitui/tuitui-ids.ts src/__tests__/tuitui-ids.test.ts && git commit -m "feat(tuitui): chatId 编解码与群/用户目标判定"
```

---

### Task 3: HTTP 发送 API 与媒体下载（tuitui-api.ts）

**Files:**
- Create: `/ssd2/baobao/Claude-to-IM-skill/src/adapters/tuitui/tuitui-api.ts`
- Test: `/ssd2/baobao/Claude-to-IM-skill/src/__tests__/tuitui-api.test.ts`

- [ ] **Step 1: 写失败的单测**（用 `globalThis.fetch` 注入法，对齐 weixin-api.test.ts 风格）

```ts
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { downloadToAttachment, modifyInteractive, sendInteractive, sendText } from '../adapters/tuitui/tuitui-api.js';
import type { InteractiveCard, TuituiCredentials } from '../adapters/tuitui/tuitui-types.js';

const creds: TuituiCredentials = {
  appid: 'app-1', secret: 'sec-1', apiBase: 'https://alarm.im.qihoo.net',
  botName: '助手', cardUrl: 'https://intent-os.qihoo.net', mediaEnabled: true,
};

const baseCard: InteractiveCard = {
  id: 'perm_req-123', url: 'https://intent-os.qihoo.net', mobileurl: 'https://intent-os.qihoo.net',
  head: { text: 'Permission Required', bgcolor: '#2C3E50', tcolor: '#FFFFFF' },
  body: { content: 'Tool: Bash' }, footer: [],
  action: [{ text: 'Allow', name: 'perm_0_req-123', value: 'perm:allow:req-123', color: 'FFFFFF', bgcolor: '27AE60' }],
};

describe('tuitui HTTP API', () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

  beforeEach(() => {
    fetchCalls = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      return new Response(JSON.stringify({ errcode: 0, msgids: [{ user: 'u1', msgid: 'msg-42' }] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
  });

  afterEach(() => { globalThis.fetch = originalFetch; });

  it('sends text to a user target with auth query params', async () => {
    const r = await sendText(creds, 'baofuen', 'hello', { referenceMsgid: 'prev-1' });
    assert.equal(r.ok, true);
    assert.equal(r.messageId, 'msg-42');
    assert.equal(fetchCalls.length, 1);
    const call = fetchCalls[0]!;
    assert.equal(call.url, 'https://alarm.im.qihoo.net/message/custom/send?appid=app-1&secret=sec-1');
    const body = JSON.parse(String(call.init?.body)) as Record<string, unknown>;
    assert.deepEqual(body.tousers, ['baofuen']);
    assert.equal(body.togroups, undefined);
    assert.equal(body.msgtype, 'text');
    assert.equal((body.text as { content: string }).content, 'hello');
    assert.equal(body.reference_msgid, 'prev-1');
  });

  it('sends text to a group target via togroups', async () => {
    await sendText(creds, '7652669649100131', 'hi');
    const body = JSON.parse(String(fetchCalls[0]!.init?.body)) as Record<string, unknown>;
    assert.deepEqual(body.togroups, ['7652669649100131']);
    assert.equal(body.tousers, undefined);
  });

  it('fails on errcode != 0', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ errcode: 40001, errmsg: 'bad secret' }), { status: 200 })) as typeof fetch;
    const r = await sendText(creds, 'baofuen', 'hi');
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /bad secret/);
  });

  it('fails on HTTP error status', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 502 })) as typeof fetch;
    const r = await sendText(creds, 'baofuen', 'hi');
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /HTTP 502/);
  });

  it('sends interactive card with msgtype interactive', async () => {
    const r = await sendInteractive(creds, 'baofuen', baseCard);
    assert.equal(r.ok, true);
    const body = JSON.parse(String(fetchCalls[0]!.init?.body)) as Record<string, unknown>;
    assert.equal(body.msgtype, 'interactive');
    assert.equal((body.interactive as InteractiveCard).id, 'perm_req-123');
  });

  it('modifies an existing card via /message/custom/modify', async () => {
    const r = await modifyInteractive(creds, 'baofuen', 'msg-42', baseCard);
    assert.equal(r.ok, true);
    const call = fetchCalls[0]!;
    assert.equal(call.url, 'https://alarm.im.qihoo.net/message/custom/modify?appid=app-1&secret=sec-1');
    const body = JSON.parse(String(call.init?.body)) as Record<string, unknown>;
    assert.deepEqual(body.tousers, [{ user: 'baofuen', msgid: 'msg-42' }]);
    assert.equal(body.msgtype, 'interactive');
  });

  it('downloads media into base64 FileAttachment', async () => {
    const buf = Buffer.from('png-bytes');
    globalThis.fetch = (async (url: string | URL) => {
      assert.equal(String(url), 'https://cdn.example.com/a.jpg');
      return new Response(buf, { status: 200, headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(buf.length) } });
    }) as typeof fetch;
    const att = await downloadToAttachment('https://cdn.example.com/a.jpg', 'a.jpg');
    assert.ok(att);
    assert.equal(att!.name, 'a.jpg');
    assert.equal(att!.type, 'image/jpeg');
    assert.equal(att!.size, buf.length);
    assert.equal(att!.data, buf.toString('base64'));
  });

  it('returns null when media download fails', async () => {
    globalThis.fetch = (async () => new Response('err', { status: 404 })) as typeof fetch;
    const att = await downloadToAttachment('https://cdn.example.com/missing.jpg', 'm.jpg');
    assert.equal(att, null);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /ssd2/baobao/Claude-to-IM-skill && CTI_HOME=$(mktemp -d) node --import tsx --test --test-concurrency=1 --test-timeout=15000 src/__tests__/tuitui-api.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 tuitui-api.ts**

```ts
//! 推推 HTTP 发送 API 与媒体下载。
//! 协议事实来源: Rust TuituiProvider（send_url / upload_media / media_fetch 同构）。

import { randomUUID } from 'node:crypto';
import type { FileAttachment } from 'claude-to-im/src/lib/bridge/host.js';
import type { InteractiveCard, TuituiCredentials } from './tuitui-types.js';
import { isGroupTarget } from './tuitui-ids.js';

export interface TuituiSendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export interface TuituiNoResult {
  ok: boolean;
  error?: string;
}

interface SendApiResponse {
  errcode?: number;
  errmsg?: string;
  msgids?: Array<{ user?: string; msgid?: string }>;
}

function sendUrl(creds: TuituiCredentials, path: string): string {
  return `${creds.apiBase}${path}?appid=${encodeURIComponent(creds.appid)}&secret=${encodeURIComponent(creds.secret)}`;
}

function targetFields(target: string): { togroups?: string[]; tousers?: string[] } {
  return isGroupTarget(target) ? { togroups: [target] } : { tousers: [target] };
}

/** 对齐 Rust redact_handshake_error：错误信息中抹掉 appid/secret，防止日志泄漏。 */
function redact(value: string, creds: TuituiCredentials): string {
  return value.replaceAll(creds.appid, '***').replaceAll(creds.secret, '***');
}

async function postJson(
  creds: TuituiCredentials,
  path: string,
  body: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  try {
    const resp = await fetchImpl(sendUrl(creds, path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text();
      return { ok: false, error: redact(`HTTP ${resp.status}: ${text.slice(0, 500)}`, creds) };
    }
    const data = (await resp.json()) as SendApiResponse;
    if (data.errcode !== 0) {
      return { ok: false, error: redact(data.errmsg ?? 'unknown error', creds) };
    }
    const messageId = data.msgids?.[0]?.msgid ?? `tuitui_${randomUUID()}`;
    return { ok: true, messageId };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    return { ok: false, error: redact(raw, creds) };
  }
}

export async function sendText(
  creds: TuituiCredentials,
  target: string,
  content: string,
  opts?: { referenceMsgid?: string },
  fetchImpl?: typeof fetch,
): Promise<TuituiSendResult> {
  return postJson(creds, '/message/custom/send', {
    ...targetFields(target),
    msgtype: 'text',
    text: { content },
    ...(opts?.referenceMsgid ? { reference_msgid: opts.referenceMsgid } : {}),
  }, fetchImpl);
}

export async function sendInteractive(
  creds: TuituiCredentials,
  target: string,
  card: InteractiveCard,
  fetchImpl?: typeof fetch,
): Promise<TuituiSendResult> {
  return postJson(creds, '/message/custom/send', {
    ...targetFields(target),
    msgtype: 'interactive',
    interactive: card,
  }, fetchImpl);
}

export async function modifyInteractive(
  creds: TuituiCredentials,
  target: string,
  msgId: string,
  card: InteractiveCard,
  fetchImpl?: typeof fetch,
): Promise<TuituiNoResult> {
  const isGroup = isGroupTarget(target);
  const body = {
    ...(isGroup
      ? { togroups: [{ group: target, msgid: msgId }] }
      : { tousers: [{ user: target, msgid: msgId }] }),
    msgtype: 'interactive',
    interactive: card,
  };
  const result = await postJson(creds, '/message/custom/modify', body, fetchImpl);
  return { ok: result.ok, error: result.error };
}

/** 下载入站媒体为 base64 FileAttachment；失败返回 null（含 HTTP 错误与网络异常）。 */
export async function downloadToAttachment(
  url: string,
  name: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<FileAttachment | null> {
  try {
    const resp = await fetchImpl(url);
    if (!resp.ok) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    const mime = resp.headers.get('content-type') || 'application/octet-stream';
    return {
      id: randomUUID(),
      name: name ?? 'attachment',
      type: mime,
      size: buf.length,
      data: buf.toString('base64'),
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: 运行确认全绿**

Run: `cd /ssd2/baobao/Claude-to-IM-skill && CTI_HOME=$(mktemp -d) node --import tsx --test --test-concurrency=1 --test-timeout=15000 src/__tests__/tuitui-api.test.ts && npm run typecheck`
Expected: 全 PASS，typecheck 无错误。

- [ ] **Step 5: Commit**

```bash
cd /ssd2/baobao/Claude-to-IM-skill && git add src/adapters/tuitui/tuitui-api.ts src/__tests__/tuitui-api.test.ts && git commit -m "feat(tuitui): HTTP 发送 API（text/interactive/modify）与媒体下载"
```

---

### Task 4: WebSocket 客户端（tuitui-ws.ts）

**Files:**
- Create: `/ssd2/baobao/Claude-to-IM-skill/src/adapters/tuitui/tuitui-ws.ts`
- Test: `/ssd2/baobao/Claude-to-IM-skill/src/__tests__/tuitui-ws.test.ts`

- [ ] **Step 1: 写失败的单测**（纯函数：退避延迟、握手错误分类、连接预检 URL 构造）

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { backoffDelayMs, classifyWsError, wsUrl } from '../adapters/tuitui/tuitui-ws.js';

describe('backoffDelayMs', () => {
  it('doubles from 2s with attempt, capped at 30s (Rust parity)', () => {
    assert.equal(backoffDelayMs(1), 2_000);
    assert.equal(backoffDelayMs(2), 4_000);
    assert.equal(backoffDelayMs(4), 16_000);
    assert.equal(backoffDelayMs(5), 30_000);
    assert.equal(backoffDelayMs(99), 30_000);
  });
});

describe('classifyWsError', () => {
  it('classifies 401/403 as auth failures', () => {
    assert.equal(classifyWsError(new Error('Unexpected server response: 401')), 'auth');
    assert.equal(classifyWsError(new Error('Unexpected server response: 403')), 'auth');
  });
  it('classifies everything else as retryable', () => {
    assert.equal(classifyWsError(new Error('Unexpected server response: 502')), 'retryable');
    assert.equal(classifyWsError(new Error('connect ECONNREFUSED')), 'retryable');
    assert.equal(classifyWsError('string error'), 'retryable');
  });
});

describe('wsUrl', () => {
  it('builds the auth query from appid and secret', () => {
    assert.equal(wsUrl('app-1', 'sec-1'), 'wss://alarm.im.qihoo.net/callback/ws?auth=app-1.sec-1');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /ssd2/baobao/Claude-to-IM-skill && CTI_HOME=$(mktemp -d) node --import tsx --test --test-concurrency=1 --test-timeout=15000 src/__tests__/tuitui-ws.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 tuitui-ws.ts**

```ts
//! 推推 WS 长连接客户端。
//! 对齐 Rust listen_loop: 每事件 3s 内 ACK、keepalive 只 ACK、指数退避重连（2^attempt 秒, 上限 30s, 100 次）、
//! 认证失败（HTTP 401/403）不重连。`ws` 包自动应答协议层 Ping。

import WebSocket from 'ws';
import type { ParsedFrame, TuituiCredentials } from './tuitui-types.js';
import { MAX_RECONNECT_ATTEMPTS, WS_HOST, parseWsFrame } from './tuitui-types.js';

/** Rust: 1s * 2^attempt，封顶 30s；attempt 从 1 开始计。 */
export function backoffDelayMs(attempt: number): number {
  return Math.min(30_000, 2 ** Math.max(attempt, 0) * 1_000);
}

export type HandshakeFailure = 'auth' | 'retryable';

/** ws 包在 HTTP 握手失败时抛 "Unexpected server response: <status>"。 */
export function classifyWsError(err: unknown): HandshakeFailure {
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(/Unexpected server response: (\d{3})/);
  if (m && (m[1] === '401' || m[1] === '403')) return 'auth';
  return 'retryable';
}

export function wsUrl(appid: string, secret: string): string {
  return `${WS_HOST}/callback/ws?auth=${encodeURIComponent(appid)}.${encodeURIComponent(secret)}`;
}

export async function testTuituiConnection(
  creds: TuituiCredentials,
  timeoutMs = 15_000,
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result: { ok: boolean; error?: string }) => {
      if (!done) { done = true; clearTimeout(timer); ws.close(); resolve(result); }
    };
    const timer = setTimeout(() => {
      finish({ ok: false, error: 'WebSocket 握手超时（15 秒）' });
      ws.terminate();
    }, timeoutMs);
    const ws = new WebSocket(wsUrl(creds.appid, creds.secret));
    ws.on('open', () => finish({ ok: true }));
    ws.on('error', (err) => {
      finish({
        ok: false,
        error: classifyWsError(err) === 'auth'
          ? '推推拒绝了凭据（401/403），请检查 App ID 和 Secret'
          : err.message,
      });
    });
    ws.on('close', () => finish({ ok: false, error: '连接提前关闭' }));
  });
}

export class TuituiWsClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private attempt = 0;

  constructor(
    private readonly creds: TuituiCredentials,
    private readonly onFrame: (frame: ParsedFrame) => void,
  ) {}

  start(): void {
    this.stopping = false;
    this.connect();
  }

  stop(): void {
    this.stopping = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.ws?.close();
  }

  private connect(): void {
    if (this.stopping) return;
    const ws = new WebSocket(wsUrl(this.creds.appid, this.creds.secret));
    this.ws = ws;

    ws.on('open', () => {
      this.attempt = 0;
      console.log('[tuitui-ws] 连接成功');
    });

    ws.on('message', (dataRaw) => {
      const frame = parseWsFrame(dataRaw.toString(), this.creds.appid, this.creds.botName);
      // 任何事件（含 keepalive）都必须在 3 秒窗口内 ACK
      if (frame.eventId && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ ack: frame.eventId }));
      }
      this.onFrame(frame);
    });

    ws.on('error', (err) => {
      if (classifyWsError(err) === 'auth') {
        console.error('[tuitui-ws] 鉴权失败（401/403），停止重连');
        this.stopping = true;
      } else {
        console.error('[tuitui-ws] error:', err.message);
      }
      ws.close();
    });

    ws.on('close', () => {
      if (this.stopping) return;
      this.attempt += 1;
      if (this.attempt >= MAX_RECONNECT_ATTEMPTS) {
        console.error(`[tuitui-ws] 达到最大重连次数（${MAX_RECONNECT_ATTEMPTS}），放弃`);
        return;
      }
      const delay = backoffDelayMs(this.attempt);
      console.log(`[tuitui-ws] 断线，${delay / 1000}s 后重连（第 ${this.attempt} 次）`);
      this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, delay);
    });
  }
}
```

- [ ] **Step 4: 运行确认全绿**

Run: `cd /ssd2/baobao/Claude-to-IM-skill && CTI_HOME=$(mktemp -d) node --import tsx --test --test-concurrency=1 --test-timeout=15000 src/__tests__/tuitui-ws.test.ts && npm run typecheck`
Expected: 全 PASS，typecheck 无错误。

- [ ] **Step 5: Commit**

```bash
cd /ssd2/baobao/Claude-to-IM-skill && git add src/adapters/tuitui/tuitui-ws.ts src/__tests__/tuitui-ws.test.ts && git commit -m "feat(tuitui): WS 长连接客户端（ACK/重连/鉴权熔断/预检）"
```

---

### Task 5: adapter 壳体（tuitui-adapter.ts）

**Files:**
- Create: `/ssd2/baobao/Claude-to-IM-skill/src/adapters/tuitui-adapter.ts`
- Test: `/ssd2/baobao/Claude-to-IM-skill/src/__tests__/tuitui-adapter.test.ts`

- [ ] **Step 1: 写失败的单测**（mock store + bridge context，对齐 weixin-adapter.test.ts 模式；`config` 依赖尚不存在也不被测）

```ts
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { BridgeStore } from 'claude-to-im/src/lib/bridge/host.js';
import { initBridgeContext } from 'claude-to-im/src/lib/bridge/context.js';
import { buildCardFromInlineButtons, buildDecisionCard, stripHtml } from '../adapters/tuitui-adapter.js';

function createMockStore(settings: Record<string, string> = {}) {
  return { getSetting: (key: string) => settings[key] ?? null };
}

function setupContext(store: ReturnType<typeof createMockStore>) {
  delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  initBridgeContext({
    store: store as unknown as BridgeStore,
    llm: { streamChat: () => new ReadableStream() },
    permissions: { resolvePendingPermission: () => false },
    lifecycle: {},
  });
}

describe('buildCardFromInlineButtons', () => {
  it('maps inlineButtons to an interactive card with perm: values', () => {
    const card = buildCardFromInlineButtons({
      address: { channelType: 'tuitui', chatId: 'tuitui:app-1:single:u1' },
      text: '<b>Permission Required</b>\n\nTool: <code>Bash</code>',
      parseMode: 'HTML',
      inlineButtons: [
        [{ text: 'Allow', callbackData: 'perm:allow:req-1' }],
        [{ text: 'Allow Session', callbackData: 'perm:allow_session:req-1' }],
        [{ text: 'Deny', callbackData: 'perm:deny:req-1' }],
      ],
    }, 'https://intent-os.qihoo.net');

    assert.equal(card.id, 'perm_req-1');
    assert.equal(card.url, 'https://intent-os.qihoo.net');
    assert.equal(card.action.length, 3);
    assert.equal(card.action[0]!.value, 'perm:allow:req-1');
    assert.equal(card.action[0]!.bgcolor, '27AE60');
    assert.equal(card.action[2]!.bgcolor, 'E74C3C');
    assert.equal(card.body.content.includes('Bash'), true);
    assert.equal(card.body.content.includes('<b>'), false);
  });
});

describe('buildDecisionCard', () => {
  it('builds a button-less card with the decision in the footer', () => {
    const card = buildDecisionCard('https://intent-os.qihoo.net', '已批准', 'allow');
    assert.deepEqual(card.footer, [{ text: '状态', rtext: '已批准' }]);
    assert.equal(card.action.length, 0);
  });
});

describe('stripHtml', () => {
  it('strips HTML tags but keeps the visible text', () => {
    assert.equal(stripHtml('<pre>a &amp; b</pre>'), 'a & b');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /ssd2/baobao/Claude-to-IM-skill && CTI_HOME=$(mktemp -d) node --import tsx --test --test-concurrency=1 --test-timeout=15000 src/__tests__/tuitui-adapter.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 tuitui-adapter.ts**

```ts
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
    this.client = new TuituiWsClient(creds, (frame) => { void this.handleFrame(frame); });
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
```

- [ ] **Step 4: 运行确认全绿**

Run: `cd /ssd2/baobao/Claude-to-IM-skill && CTI_HOME=$(mktemp -d) node --import tsx --test --test-concurrency=1 --test-timeout=15000 src/__tests__/tuitui-adapter.test.ts && npm run typecheck`
Expected: 全 PASS，typecheck 无错误。

- [ ] **Step 5: Commit**

```bash
cd /ssd2/baobao/Claude-to-IM-skill && git add src/adapters/tuitui-adapter.ts src/__tests__/tuitui-adapter.test.ts && git commit -m "feat(tuitui): adapter 壳体（入站/出站/权限卡片/回调路由）"
```

---

### Task 6: 配置接线（config.ts + main.ts）

**Files:**
- Modify: `/ssd2/baobao/Claude-to-IM-skill/src/config.ts`
- Modify: `/ssd2/baobao/Claude-to-IM-skill/src/main.ts`
- Test: `/ssd2/baobao/Claude-to-IM-skill/src/__tests__/config.test.ts`（追加 describe 块）

- [ ] **Step 1: 在 config.test.ts 末尾追加失败的单测**

```ts
// ── Tuitui ──

describe('configToSettings: tuitui', () => {
  const tuituiConfig: Config = {
    runtime: 'claude',
    enabledChannels: ['tuitui'],
    defaultWorkDir: '/tmp/test',
    defaultMode: 'code',
    tuituiAppId: 'app-1',
    tuituiSecret: 'sec-1',
    tuituiBotName: '助手',
    tuituiApiBase: 'https://alarm.im.qihoo.net',
    tuituiMediaEnabled: true,
    tuituiCardUrl: 'https://intent-os.qihoo.net',
  };

  it('maps tuitui config to bridge settings', () => {
    const m = configToSettings(tuituiConfig);
    assert.equal(m.get('bridge_tuitui_enabled'), 'true');
    assert.equal(m.get('bridge_tuitui_appid'), 'app-1');
    assert.equal(m.get('bridge_tuitui_secret'), 'sec-1');
    assert.equal(m.get('bridge_tuitui_bot_name'), '助手');
    assert.equal(m.get('bridge_tuitui_api_base'), 'https://alarm.im.qihoo.net');
    assert.equal(m.get('bridge_tuitui_media_enabled'), 'true');
    assert.equal(m.get('bridge_tuitui_card_url'), 'https://intent-os.qihoo.net');
  });

  it('disables tuitui when not in enabledChannels', () => {
    const m = configToSettings({ ...tuituiConfig, enabledChannels: ['telegram'] });
    assert.equal(m.get('bridge_tuitui_enabled'), 'false');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /ssd2/baobao/Claude-to-IM-skill && CTI_HOME=$(mktemp -d) node --import tsx --test --test-concurrency=1 --test-timeout=15000 src/__tests__/config.test.ts`
Expected: 新增测试 FAIL（Config 类型无 tuitui 字段 / 映射缺失）。

- [ ] **Step 3: 改 config.ts**

3a. Config 接口 `// WeChat` 注释块后追加：

```ts
  // TuiTui
  tuituiAppId?: string;
  tuituiSecret?: string;
  tuituiBotName?: string;
  tuituiApiBase?: string;
  tuituiMediaEnabled?: boolean;
  tuituiCardUrl?: string;
```

3b. `loadConfig()` 返回对象 `weixinMediaEnabled` 行后追加：

```ts
    tuituiAppId: env.get("CTI_TUITUI_APPID") || undefined,
    tuituiSecret: env.get("CTI_TUITUI_SECRET") || undefined,
    tuituiBotName: env.get("CTI_TUITUI_BOT_NAME") || undefined,
    tuituiApiBase: env.get("CTI_TUITUI_API_BASE") || undefined,
    tuituiMediaEnabled: env.has("CTI_TUITUI_MEDIA_ENABLED")
      ? env.get("CTI_TUITUI_MEDIA_ENABLED") === "true"
      : undefined,
    tuituiCardUrl: env.get("CTI_TUITUI_CARD_URL") || undefined,
```

3c. `saveConfig()` 的 `CTI_WEIXIN_*` 输出后追加：

```ts
  out += formatEnvLine("CTI_TUITUI_APPID", config.tuituiAppId);
  out += formatEnvLine("CTI_TUITUI_SECRET", config.tuituiSecret);
  out += formatEnvLine("CTI_TUITUI_BOT_NAME", config.tuituiBotName);
  out += formatEnvLine("CTI_TUITUI_API_BASE", config.tuituiApiBase);
  if (config.tuituiMediaEnabled !== undefined)
    out += formatEnvLine("CTI_TUITUI_MEDIA_ENABLED", String(config.tuituiMediaEnabled));
  out += formatEnvLine("CTI_TUITUI_CARD_URL", config.tuituiCardUrl);
```

3d. `configToSettings()` 的 WeChat 块后追加：

```ts
  // ── TuiTui ──
  // Upstream keys: bridge_tuitui_enabled, bridge_tuitui_appid,
  //   bridge_tuitui_secret, bridge_tuitui_bot_name, bridge_tuitui_api_base,
  //   bridge_tuitui_media_enabled, bridge_tuitui_card_url
  m.set(
    "bridge_tuitui_enabled",
    config.enabledChannels.includes("tuitui") ? "true" : "false"
  );
  if (config.tuituiAppId) m.set("bridge_tuitui_appid", config.tuituiAppId);
  if (config.tuituiSecret) m.set("bridge_tuitui_secret", config.tuituiSecret);
  if (config.tuituiBotName) m.set("bridge_tuitui_bot_name", config.tuituiBotName);
  if (config.tuituiApiBase) m.set("bridge_tuitui_api_base", config.tuituiApiBase);
  if (config.tuituiMediaEnabled !== undefined)
    m.set("bridge_tuitui_media_enabled", String(config.tuituiMediaEnabled));
  if (config.tuituiCardUrl) m.set("bridge_tuitui_card_url", config.tuituiCardUrl);
```

3e. `src/main.ts` 在 `import './adapters/weixin-adapter.js';` 后加一行（main.ts 用单引号，保持原风格）：

```ts
import './adapters/tuitui-adapter.js';
```

- [ ] **Step 4: 运行确认全绿**

Run: `cd /ssd2/baobao/Claude-to-IM-skill && CTI_HOME=$(mktemp -d) node --import tsx --test --test-concurrency=1 --test-timeout=15000 src/__tests__/config.test.ts && npm test && npm run typecheck`
Expected: config 新测试 + 既有全部测试 PASS，typecheck 无错误。

- [ ] **Step 5: Commit**

```bash
cd /ssd2/baobao/Claude-to-IM-skill && git add src/config.ts src/main.ts src/__tests__/config.test.ts && git commit -m "feat(tuitui): 配置接线（CTI_TUITUI_* 环境变量 → bridge 设置）与 adapter 注册"
```

---

### Task 7: 上游包 PLATFORM_LIMITS + 全量验证

**Files:**
- Modify: `/ssd2/baobao/Claude-to-IM/src/lib/bridge/types.ts`（PLATFORM_LIMITS）
- 验证：无新测试

- [ ] **Step 1: 在 PLATFORM_LIMITS 加 tuitui 上限**

文件 `/ssd2/baobao/Claude-to-IM/src/lib/bridge/types.ts` 的 PLATFORM_LIMITS 对象中，`weixin: 4000,` 行后加：

```ts
  weixin: 4000,
  tuitui: 4000,
```

- [ ] **Step 2: 全量验证**

Run:
```bash
cd /ssd2/baobao/Claude-to-IM && npm run build
cd /ssd2/baobao/Claude-to-IM-skill && npm run typecheck && npm test && npm run build
```
Expected: 上游 build 成功（dist 重建，file: 依赖下一轮 install 生效可用于 dist 产物）；skill typecheck 无错误；全部测试 PASS；`dist/daemon.mjs` 生成成功（esbuild 会把 ws 与 tuitui 源码打进 bundle）。

- [ ] **Step 3: 双仓提交**

```bash
cd /ssd2/baobao/Claude-to-IM && git add src/lib/bridge/types.ts && git commit -m "feat(bridge): PLATFORM_LIMITS 支持 tuitui 渠道"
cd /ssd2/baobao/Claude-to-IM-skill && git status --short
```
Expected: skill 工作区无未提交改动；上游已有 1 个新提交。

---

### Task 8: 联调验证（手动，真实推推凭据）

**Files:** 无（验证清单）。前置：需要真实 `appid`/`secret`/机器名，写入 `/ssd2/baobao/Claude-to-IM-skill/config.env`（`CTI_HOME=...`），并在 `CTI_ENABLED_CHANNELS` 中加入 `tuitui`。

- [ ] **Step 1: 配置**

```bash
cd /ssd2/baobao/Claude-to-IM-skill && cat > config.env <<'EOF'
CTI_RUNTIME=claude
CTI_ENABLED_CHANNELS=tuitui
CTI_DEFAULT_WORKDIR=/tmp/tuitui-test
CTI_TUITUI_APPID=<appid>
CTI_TUITUI_SECRET=<secret>
CTI_TUITUI_BOT_NAME=<机器人名>
CTI_TUITUI_MEDIA_ENABLED=true
EOF
```
（CTI_HOME 默认 `~/.claude-to-im`；若该目录里已有其它配置，用 `CTI_HOME=/tmp/tuitui-cti` 隔离，并把 config.env 放到该目录。）

- [ ] **Step 2: 启动 daemon 并验证单聊收发**

Run: `cd /ssd2/baobao/Claude-to-IM-skill && npm run dev`
Expected 观察项：
- 日志出现 `[tuitui-ws] 连接成功`（无 401/403）
- 推推单聊发「你好」，daemon 日志出现解析帧（`chat` 事件），Claude 开始响应
- 回复消息在推推中可见；消息长度限制 4000 字符内正常

- [ ] **Step 3: 群聊 @提及**

推推群里 `@机器人名 帮我算 1+1`。
Expected：daemon 响应；未 @ 仅发群消息时**无**响应。

- [ ] **Step 4: 权限卡片 → 按钮 → 卡片更新**

给 Claude 下一条会触发工具调用的指令（如「列出当前目录」）。Expected 观察项：
- 推推中收到 `Permission Required` interactive 卡片，三个按钮 Allow / Allow Session / Deny
- 点 Allow 后工具放行、Claude 继续
- 原卡片更新为「已批准」状态（footer 显示）
- **若按钮点击无反应**：查看 daemon 日志中回调事件的完整 raw 报文，据此校正 `findPermCallbackData` 的候选路径（`["action","value"]` / `["message","action","value"]` 等），补测试后提交。

- [ ] **Step 5: 媒体入站**

推送一张图片给 bot；指令让其描述图片。Expected：图片作为 FileAttachment 进入 Claude 上下文并能看到内容。若图片 URL 下载 404/过期，记录 URL 形态并在日志中确认，必要时改用 `/media/fetch`（media_id → URL）流程（当前实现为直接下载 `data.images[0]`，协议联调后如有差异按 Rust `fetch_media` 补齐）。

- [ ] **Step 6: 断线重连**

在 daemon 运行中重启网络或 kill WS 连接（`kill -HUP $PID` 不行——用 Ctrl+C 再起验证重连不行,正确做法：检查日志中断线消息后 2s/4s/8s 退避重连日志；或在 daemon 所在机器临时停网关验证）。最小验证：观察 WS 被服务端关闭（如 appid 在另一处重复连接）时按指数退避重连、最大 30s。

- [ ] **Step 7: 记录联调结论**

把联调中确认的字段形态（尤其 action 回调报文）与任何协议差异记录到本计划同目录 `2026-08-31-tuitui-联调记录.md`，如有解析器修正则补测试并提交。

---

### Task 9: 文档（README / SKILL.md / 配置表）

**Files:**
- Modify: `/ssd2/baobao/Claude-to-IM-skill/README.md`
- Modify: `/ssd2/baobao/Claude-to-IM-skill/README_CN.md`
- Modify: `/ssd2/baobao/Claude-to-IM-skill/SKILL.md`

- [ ] **Step 1: 更新渠道列表**

- `README.md` / `README_CN.md` 开头的「五大 IM 平台 — Telegram、Discord、飞书、QQ、微信」→「内含推推（TuiTui，内网 IM）」：
  - README_CN.md 第 25 行：`- **五大 IM 平台** — Telegram、Discord、飞书、QQ、微信，可任意组合启用` → `- **IM 平台** — Telegram、Discord、飞书、QQ、微信、推推，可任意组合启用`
  - README.md 同位置英文版同步
  - 架构图/「核心组件」表中提到的渠道注册保持一致
- `SKILL.md` 中平台清单相应加入推推。

- [ ] **Step 2: 新增「推推」配置章节**（README_CN.md / README.md 的「平台配置指南」微信段落之后）

```markdown
### 推推 / TuiTui

> 推推是公司内网 IM（alarm.im.qihoo.net）。支持单聊与群聊（群聊需 @机器人），权限确认使用 interactive 卡片按钮，支持入站图片/文件。

1. 获取推推应用的 **App ID** 与 **Secret**（应用管理员处申请）
2. 配置环境变量（`~/.claude-to-im/config.env`）：
   - `CTI_TUITUI_APPID` — 推推应用 App ID（必填）
   - `CTI_TUITUI_SECRET` — 推推应用 Secret（必填）
   - `CTI_TUITUI_BOT_NAME` — 机器人名，用于群聊 @提及检测
   - `CTI_TUITUI_API_BASE` — API 基础地址（默认 `https://alarm.im.qihoo.net`）
   - `CTI_TUITUI_MEDIA_ENABLED` — 是否下载入站图片/文件（默认 false）
   - `CTI_TUITUI_CARD_URL` — 权限卡片跳转地址（默认 `https://intent-os.qihoo.net`）
3. `CTI_ENABLED_CHANNELS` 中加入 `tuitui`
4. 重启 daemon：`/claude-to-im restart`（或 kill 后重新 start）

说明：出站媒体（Claude 回复图片/文件）暂不支持——bridge 框架的消息模型为文本。权限响应超时与其它渠道一致（5 分钟）。
```

- [ ] **Step 3: 验证文档格式与提交**

Run: `cd /ssd2/baobao/Claude-to-IM-skill && npx markdownlint README.md README_CN.md SKILL.md 2>/dev/null || echo "（无 markdownlint，跳过格式检查）"`
Expected: 无致命格式错误（无 markdownlint 时跳过）。

```bash
cd /ssd2/baobao/Claude-to-IM-skill && git add README.md README_CN.md SKILL.md && git commit -m "docs: 推推渠道使用说明与配置指南"
```

---

## 范围外（future work）
- 出站媒体（Claude 发图片/文件给用户）：需要上游 bridge 包 `OutboundMessage` 增加文件载体并贯穿 delivery-layer
- 推推 setup 交互向导（skill 的 `/claude-to-im setup` 加 tuitui 渠道选项）
- 多推推应用并行（当前单账号模式，对齐微信 adapter）
- 卡片按钮回调的群聊场景校准（联调时验证）