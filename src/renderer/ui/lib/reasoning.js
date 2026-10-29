export const settle = (it, now) => (it.kind === 'reasoning' && it.streaming
  ? { ...it, streaming: false, ms: now - it.at }
  : it);

export function thoughtLabel(item) {
  if (item.ms == null) return 'Thought';
  const s = Math.max(1, Math.round(item.ms / 1000));
  return `Thought for ${s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`}`;
}
