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