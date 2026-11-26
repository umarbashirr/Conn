/* Whether the chat's last turn was stopped because you had the browser: a
   browser call that came back with the note main sends while you hold the
   page (pane-lease.js, TAKEN). The chat then offers to hand it back. */
export const TAKEN_NOTE = 'The person took control of this preview tab.';

const textOf = (out) => {
  if (typeof out === 'string') return out;
  if (Array.isArray(out)) return out.map((b) => (typeof b === 'string' ? b : b?.text || '')).join('\n');
  return '';
};

export function stoppedForYou(items) {
  const list = items || [];
  for (let i = list.length - 1; i >= 0; i--) {
    const it = list[i];
    if (it.kind === 'user') return false;
    if (it.kind === 'tool' && textOf(it.output).includes(TAKEN_NOTE)) return true;
  }
  return false;
}
