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
