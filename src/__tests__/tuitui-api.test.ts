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

  it('redacts appid/secret from error messages', async () => {
    globalThis.fetch = (async () => { throw new Error('boom at https://alarm.im.qihoo.net/send?appid=app-1&secret=sec-1'); }) as typeof fetch;
    const r = await sendText(creds, 'baofuen', 'hi');
    assert.equal(r.ok, false);
    assert.equal(r.error?.includes('app-1'), false);
    assert.equal(r.error?.includes('sec-1'), false);
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
