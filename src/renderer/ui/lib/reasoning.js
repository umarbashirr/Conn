// A thought stops counting the moment it is settled, once. Every later close
// (a late stop after Stop, a result after an interrupt, an error) finds it
// already settled and leaves it alone.
export const settle = (it, now) => (it.kind === 'reasoning' && it.streaming
  ? { ...it, streaming: false, ms: now - it.at }
  : it);

// "0s" reads like a bug, so anything shorter than a second says 1s. A replayed
// thought has no clock on disk and gets no number.
export function thoughtLabel(item) {
  if (item.ms == null) return 'Thought';
  const s = Math.max(1, Math.round(item.ms / 1000));
  return `Thought for ${s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`}`;
}
