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