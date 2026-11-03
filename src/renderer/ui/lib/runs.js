// A turn is mostly tool calls, and one line each turns twenty greps into a
// screenful of scrolling past your own work. So a run of them folds: whatever
// is running stays a row you can read, and everything it already did becomes
// the one line above it saying how much of what. An edit that carries a diff
// breaks the run and keeps its own row, because that diff is something to
// read. An edit that only names a file is a step, and a stack of those is
// the same kind of noise as a stack of greps.
import { editHunks } from './diff.js';
import { toolLabel } from './tools.js';

// Two calls are not a run worth folding: it would cost a click and save a line.
export const FOLD_AT_CALLS = 3;

export function runs(items) {
  const out = [];
  let thoughts = [];
  const releaseThoughts = () => {
    for (const it of thoughts) out.push({ id: it.id, item: it });
    thoughts = [];
  };
  for (const item of items) {
    const last = out[out.length - 1];
    if (item.kind === 'reasoning' && last?.run) {
      thoughts.push(item);
      continue;
    }
    const label = item.kind === 'tool' ? toolLabel(item.name) : '';
    const foldable = item.kind === 'tool' && label !== 'ExitPlanMode' && !editHunks(label, item.input || {});
    if (foldable && last?.run) {
      last.run.push(...thoughts, item);
      last.calls += 1;
      thoughts = [];
      continue;
    }
    releaseThoughts();
    out.push(foldable ? { id: item.id, run: [item], calls: 1 } : { id: item.id, item });
  }
  releaseThoughts();
  return out;
}

export const SHOW_AFTER_MS = 2000;

// Only a call that was watched has both ends. A replayed one has neither, and
// a duration made up from the transcript would be a guess.
export function callSpan(item) {
  const ms = item.at && item.end ? item.end - item.at : 0;
  return ms >= SHOW_AFTER_MS ? ms : null;
}

export function runSpan(items) {
  const starts = items.map((it) => it.at).filter(Boolean);
  const ends = items.map((it) => it.end).filter(Boolean);
  if (!starts.length || !ends.length) return null;
  const ms = Math.max(...ends) - Math.min(...starts);
  return ms >= SHOW_AFTER_MS ? ms : null;
}
