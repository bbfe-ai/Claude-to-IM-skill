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
  it('handles attempt 0 and negative attempts', () => {
    assert.equal(backoffDelayMs(0), 1_000);
    assert.equal(backoffDelayMs(-3), 1_000);
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
  it('classifies other HTTP statuses as retryable', () => {
    assert.equal(classifyWsError(new Error('Unexpected server response: 404')), 'retryable');
    assert.equal(classifyWsError(new Error('Unexpected server response: 500')), 'retryable');
  });
});

describe('wsUrl', () => {
  it('builds the auth query from appid and secret', () => {
    assert.equal(wsUrl('app-1', 'sec-1'), 'wss://alarm.im.qihoo.net/callback/ws?auth=app-1.sec-1');
  });
  it('URL-encodes special characters in appid/secret', () => {
    assert.equal(wsUrl('app id', 's/e=c'), 'wss://alarm.im.qihoo.net/callback/ws?auth=app%20id.s%2Fe%3Dc');
  });
});