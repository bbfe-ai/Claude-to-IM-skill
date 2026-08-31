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
