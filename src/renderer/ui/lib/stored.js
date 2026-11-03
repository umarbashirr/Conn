// Where a chat opened off disk sits in its stored transcript, as the chat's
// `stored` field: { session, from, to, count, loading }. Messages [from, to)
// of transcript `session` were replayed into the chat's first `count` items,
// and the `from` before them are still only on disk. `to` stays where the chat
// was opened, so a turn run since, which the transcript also records, is never
// read back in on top of the rows it already drew. Null once nothing is left.
export function storedWindow(t, end = t.total) {
  const to = Math.min(end, t.total);
  return { from: to - t.messages.length, to };
}

export const storedOf = (session, { from, to }, count) => (from > 0 ? { session, from, to, count } : null);

// Twice what is on screen, or all that is left.
export const widerLimit = ({ from, to }) => Math.min(to, 2 * (to - from));

// The wider replay in place of the narrower one. A row already on screen keeps
// its object, so what the reader did to it (an agent opened, edits undone)
// stays done, and what came after the window (a live turn, an opened agent's
// rows) stays where it was.
export function rewindow(items, count, fresh) {
  const shown = new Map(items.slice(0, count).map((it) => [it.id, it]));
  return [...fresh.map((it) => shown.get(it.id) ?? it), ...items.slice(count)];
}
