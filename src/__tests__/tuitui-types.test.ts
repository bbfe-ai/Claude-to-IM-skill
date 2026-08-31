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
