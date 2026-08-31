import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { BridgeStore } from 'claude-to-im/src/lib/bridge/host.js';
import { initBridgeContext } from 'claude-to-im/src/lib/bridge/context.js';
import { TuituiAdapter, buildCardFromInlineButtons, buildDecisionCard, stripHtml } from '../adapters/tuitui-adapter.js';

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
