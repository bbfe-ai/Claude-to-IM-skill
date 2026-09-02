import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { BridgeStore } from 'claude-to-im/src/lib/bridge/host.js';
import type { InboundMessage } from 'claude-to-im/src/lib/bridge/types.js';
import { initBridgeContext } from 'claude-to-im/src/lib/bridge/context.js';
import { TuituiAdapter, buildCardFromInlineButtons, buildDecisionCard, buildProcessingCard, stripHtml } from '../adapters/tuitui-adapter.js';

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

describe('TuituiAdapter start', () => {
  it('idles without credentials without throwing', async () => {
    setupContext(createMockStore({}));
    const adapter = new TuituiAdapter();
    await adapter.start();
    assert.equal(adapter.isRunning(), false);
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  });
});

describe('buildCardFromInlineButtons 中文化', () => {
  it('maps known permission buttons and headers to Chinese', () => {
    const card = buildCardFromInlineButtons({
      address: { channelType: 'tuitui', chatId: 'tuitui:app-1:single:u1' },
      text: '<b>Permission Required</b>\n\nTool: <code>Read</code>\n\nChoose an action:',
      parseMode: 'HTML',
      inlineButtons: [
        [{ text: 'Allow', callbackData: 'perm:allow:req-2' }],
        [{ text: 'Allow Session', callbackData: 'perm:allow_session:req-2' }],
        [{ text: 'Deny', callbackData: 'perm:deny:req-2' }],
      ],
    }, 'https://intent-os.qihoo.net');

    assert.equal(card.head.text, '权限请求');
    assert.equal(card.body.content.includes('权限请求'), true);
    assert.equal(card.body.content.includes('请选择操作：'), true);
    assert.equal(card.action[0]!.text, '允许');
    assert.equal(card.action[1]!.text, '允许本次会话');
    assert.equal(card.action[2]!.text, '拒绝');
  });
});

describe('TuituiAdapter 媒体失败透传', () => {
  it('surfaces download failures via raw flag instead of dropping the message', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('err', { status: 404 })) as typeof fetch;
    try {
      setupContext(createMockStore({
        bridge_tuitui_appid: 'app-1',
        bridge_tuitui_secret: 'sec-1',
        bridge_tuitui_media_enabled: 'true',
      }));
      const adapter = new TuituiAdapter();
      await (adapter as any).handleFrame({
        eventId: 'evt-1',
        chat: {
          msgId: 'm1', senderId: 'u1', senderName: '用户',
          msgType: 'image', text: '', imageUrls: ['https://cdn.example.com/a.jpg'],
          mentioned: true,
        },
      });
      const inbound = await adapter.consumeOne();
      assert.ok(inbound);
      assert.equal((inbound?.raw as { attachmentDownloadFailed?: boolean })?.attachmentDownloadFailed, true);
      assert.equal((inbound?.raw as { failedCount?: number })?.failedCount, 1);
    } finally {
      globalThis.fetch = originalFetch;
      delete (globalThis as Record<string, unknown>)['__bridge_context__'];
    }
  });
});

describe('buildProcessingCard', () => {
  it('received phase: 告知用户已收到并处理中', () => {
    const card = buildProcessingCard('received', '', [], 'https://intent-os.qihoo.net');
    assert.equal(card.head.text, '🤖 Claude 处理中');
    assert.equal(card.body.content, '已收到你的消息，Claude 正在处理…');
    assert.deepEqual(card.footer, [{ text: '状态', rtext: '处理中' }]);
    assert.equal(card.action.length, 0);
  });

  it('streaming phase: 展示输出预览或当前工具', () => {
    const withText = buildProcessingCard('streaming', '正在分析代码…', [], 'https://intent-os.qihoo.net');
    assert.equal(withText.body.content, '正在输出：\n正在分析代码…');
    const withTool = buildProcessingCard('streaming', '', [
      { id: 't1', name: 'Bash', status: 'running' },
      { id: 't0', name: 'Read', status: 'complete' },
    ], 'https://intent-os.qihoo.net');
    assert.equal(withTool.body.content, '正在调用工具：Bash');
    assert.equal(withTool.footer[0]!.rtext, '🔧 Bash');
  });

  it('completed / error / interrupted phases: 状态收尾', () => {
    assert.equal(buildProcessingCard('completed', '', [], 'https://x').head.bgcolor, '#27AE60');
    assert.equal(buildProcessingCard('completed', '', [], 'https://x').footer[0]!.rtext, '✅ 已完成');
    assert.equal(buildProcessingCard('error', '', [], 'https://x').head.bgcolor, '#C0392B');
    assert.equal(buildProcessingCard('error', '', [], 'https://x').footer[0]!.rtext, '❌ 出错');
    assert.equal(buildProcessingCard('interrupted', '', [], 'https://x').footer[0]!.rtext, '⏹ 已中断');
  });

  it('默认 cardUrl 回退到 DEFAULT_CARD_URL', () => {
    const card = buildProcessingCard('received', '', []);
    assert.equal(card.url, 'https://intent-os.qihoo.net');
  });
});

describe('TuituiAdapter 处理中卡片生命周期', () => {
  function makeAdapter() {
    const settings: Record<string, string> = {
      bridge_tuitui_appid: 'app-1',
      bridge_tuitui_secret: 'secret-1',
      bridge_tuitui_card_url: 'https://intent-os.qihoo.net',
    };
    setupContext(createMockStore(settings));
    return new TuituiAdapter();
  }

  it('enqueue 普通消息触发"处理中"卡路径，命令/回调不触发（fire-and-forget 无凭据仅记日志）', async () => {
    const adapter = makeAdapter();
    // 注入一条普通消息 + 一条命令 + 一条回调
    const msg: InboundMessage = {
      messageId: 'm1',
      address: { channelType: 'tuitui', chatId: 'tuitui:app-1:single:u1', userId: 'u1', displayName: 'u1' },
      text: '帮我写个脚本',
      timestamp: Date.now(),
    };
    adapter['enqueue'](msg);
    const cmd: InboundMessage = { ...msg, messageId: 'm2', text: '/status' };
    adapter['enqueue'](cmd);
    const cb: InboundMessage = { ...msg, messageId: 'm3', text: '', callbackData: 'perm:allow:req-1' };
    adapter['enqueue'](cb);

    // 无凭据发送会失败但流程不抛错（fire-and-forget）
    const consumed: InboundMessage[] = [];
    consumed.push((await adapter.consumeOne())!);
    consumed.push((await adapter.consumeOne())!);
    consumed.push((await adapter.consumeOne())!);
    assert.deepEqual(consumed.map(c => c.messageId), ['m1', 'm2', 'm3']);
  });

  it('onStreamEnd 返回 false 并清理状态（正文由 sendText 发送）', async () => {
    const adapter = makeAdapter();
    const chatId = 'tuitui:app-1:single:u1';
    // 手动注入状态（跳过真实 API 调用）
    adapter['processingCards'].set(chatId, {
      target: 'u1', cardMsgId: 'card-1', lastUpdateAt: 0,
      pendingText: 'ok', throttleTimer: null, tools: [],
    });
    const finalized = await adapter.onStreamEnd(chatId, 'completed', 'ok');
    assert.equal(finalized, false);
    assert.equal(adapter['processingCards'].has(chatId), false);
  });
});
