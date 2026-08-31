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

  it('marks group message mentioned by text @botName when at_users is absent', () => {
    const raw = JSON.stringify({
      event_id: 'evt-g3',
      body: { event: 'group_chat', user_account: 'u2', group_id: '1234567890', msgtype: 'text', text: '@助手 hi', data: { msgid: 'm5' } },
    });
    const frame = parseWsFrame(raw, 'bot-appid', '助手');
    assert.ok(frame.chat);
    assert.equal(frame.chat!.mentioned, true);
  });

  it('recognizes bot in comma-separated string at_users', () => {
    const raw = JSON.stringify({
      event_id: 'evt-g4',
      body: { event: 'group_chat', user_account: 'u2', group_id: '1234567890', text: 'hi', at_users: 'user-2,bot-appid', data: { msgid: 'm6' } },
    });
    const frame = parseWsFrame(raw, 'bot-appid', '助手');
    assert.ok(frame.chat);
    assert.equal(frame.chat!.mentioned, true);
  });

  it('extracts top-level images and file from mixed messages', () => {
    const raw = JSON.stringify({
      event_id: 'evt-mix',
      body: {
        event: 'single_chat', user_account: 'u1', msgtype: 'mixed', text: '看下这两个文件',
        images: ['https://c.example.com/x.png'],
        file: { url: 'https://c.example.com/f.pdf', name: 'f.pdf' },
        data: { msgid: 'm7', msg_type: 'mixed' },
      },
    });
    const frame = parseWsFrame(raw, 'bot-appid', '助手');
    assert.ok(frame.chat);
    assert.ok(frame.chat!.imageUrls.includes('https://c.example.com/x.png'));
    assert.equal(frame.chat!.file?.url, 'https://c.example.com/f.pdf');
  });

  it('falls back to data.images for mixed when top-level images are absent', () => {
    const raw = JSON.stringify({
      event_id: 'evt-mix2',
      body: {
        event: 'single_chat', user_account: 'u1', msgtype: 'mixed', text: '图',
        data: { msgid: 'm8', msg_type: 'mixed', images: ['https://c.example.com/y.png'] },
      },
    });
    const frame = parseWsFrame(raw, 'bot-appid', '助手');
    assert.ok(frame.chat);
    assert.deepEqual(frame.chat!.imageUrls, ['https://c.example.com/y.png']);
  });

  it('returns eventId null on invalid JSON', () => {
    const frame = parseWsFrame('not json', 'bot-appid', '助手');
    assert.deepEqual(frame, { eventId: null });
  });

  it('returns eventId only when body is missing', () => {
    const frame = parseWsFrame('{"event_id":"x"}', 'bot-appid', '助手');
    assert.deepEqual(frame, { eventId: 'x' });
  });
});

describe('findPermCallbackData', () => {
  it('falls back to regex scan over serialized body for unknown field layouts', () => {
    const data = findPermCallbackData({ event: 'interactive_action', nested: { deep: 'perm:deny:req-77' } });
    assert.equal(data, 'perm:deny:req-77');
  });

  it('extracts allow_session from message.action.value path', () => {
    const data = findPermCallbackData({ event: 'interactive_action', message: { action: { value: 'perm:allow_session:req-8' } } });
    assert.equal(data, 'perm:allow_session:req-8');
  });

  it('extracts deny from message.value path', () => {
    const data = findPermCallbackData({ event: 'interactive_action', message: { value: 'perm:deny:req-9' } });
    assert.equal(data, 'perm:deny:req-9');
  });
});

describe('parseWsFrame 联调校准（2026-08-31 真实帧）', () => {
  it('parses real interactive_action callback frame (data.message.action[] + data.message.msgid)', () => {
    const raw = JSON.stringify({
      event_id: 'evt-real',
      body: {
        event: 'interactive_action',
        user_account: 'baofuen',
        user_name: '包富恩',
        data: {
          message: {
            msgid: '7680112677696077537',
            id: 'perm_toolu_50eaa542cedb4943becce1ec',
            action: [{ text: 'Allow', name: 'perm_0_toolu_50eaa542cedb4943becce1ec', value: 'perm:allow:toolu_50eaa542cedb4943becce1ec', color: 'FFFFFF', bgcolor: '27AE60', type: '' }],
          },
        },
      },
    });
    const frame = parseWsFrame(raw, '3433149389', 'Claude助手');
    assert.ok(frame.callback);
    assert.equal(frame.callback!.callbackData, 'perm:allow:toolu_50eaa542cedb4943becce1ec');
    assert.equal(frame.callback!.msgId, '7680112677696077537');
  });

  it('extracts multiple files from data.files array', () => {
    const raw = JSON.stringify({
      event_id: 'evt-files',
      body: {
        event: 'single_chat', user_account: 'u1', msgtype: 'file',
        data: {
          msgid: 'm9', msg_type: 'file',
          file: { name: 'a.md', url: 'https://cdn.example.com/a.md', file_id: 'f1' },
          files: [
            { name: 'a.md', url: 'https://cdn.example.com/a.md', file_id: 'f1' },
            { name: 'b.md', url: 'https://cdn.example.com/b.md', file_id: 'f2' },
          ],
        },
      },
    });
    const frame = parseWsFrame(raw, 'bot-appid', '助手');
    assert.ok(frame.chat);
    assert.equal(frame.chat!.files?.length, 2);
    assert.equal(frame.chat!.files![1]!.name, 'b.md');
    assert.equal(frame.chat!.file?.url, 'https://cdn.example.com/a.md');
  });
});

describe('findPermCallbackData 联调校准', () => {
  it('finds perm: value inside data.message.action array elements', () => {
    const data = findPermCallbackData({
      event: 'interactive_action',
      data: {
        message: {
          action: [
            { text: 'Deny', name: 'perm_2_x', value: 'perm:deny:req-77', type: '' },
          ],
        },
      },
    });
    assert.equal(data, 'perm:deny:req-77');
  });
});
