// How the transcript's flat items read as a conversation. No JSX, so plain node
// checks the same rules the rows are drawn by: scripts/turns-check.mjs.
import { editHunks, hunkStats } from './diff.js';
import { fileOf, toolLabel } from './tools.js';

const isCall = (it) => it?.kind === 'tool';

// A permission that was answered with a yes or a no. An answered question is
// not one: its answer is the thing worth reading, so it keeps its own line.
const settled = (it) => it.kind === 'perm' && it.decided && !it.answers;

/* A decided permission moves onto the row of the call it let through, so a
   past "Allowed Bash" is not a line of its own that reads like a button.
   Returns the perms that found a row, keyed by row id, and the items without
   them, in order.

   Main names the row as forId. When that row is not in this list (a
   subagent's call lives in its agent's children) the perm stays a line; it
   is never paired by name instead, or a subagent's perm would mark a call
   the main thread made. A preview-bridge prompt has no call to name, so it
   pairs with the nearest unmarked call of its tool, looking back first:
   only codex and the ACP agents reach the bridge's card (a Claude session's
   invoke drives the tool without it), and they announce the call before the
   bridge asks. Forward is the fallback for a card that got in ahead. */
export function attachPerms(items) {
  const marks = new Map();
  const calls = new Set(items.filter(isCall).map((it) => it.id));
  for (const perm of items) {
    if (settled(perm) && perm.forId && calls.has(perm.forId) && !marks.has(perm.forId)) marks.set(perm.forId, perm);
  }

  items.forEach((perm, at) => {
    if (!settled(perm) || perm.forId || perm.agent?.id !== 'bridge') return;
    const label = toolLabel(perm.tool);
    const fits = (it) => isCall(it) && !marks.has(it.id) && toolLabel(it.name) === label;
    const row = items.slice(0, at).findLast(fits) ?? items.slice(at + 1).find(fits);
    if (row) marks.set(row.id, perm);
  });

  if (!marks.size) return { marks, rest: items };
  const placed = new Set(marks.values());
  return { marks, rest: items.filter((it) => !placed.has(it)) };
}

// A moved file is named where it lives now.
export function fileEdits(item) {
  const input = item.input || {};
  const hunks = item.kind === 'tool' && editHunks(toolLabel(item.name), input);
  if (!hunks) return [];
  if (Array.isArray(input.files) && input.files.length) {
    return input.files.filter((f) => f.path).map((f) => ({ path: f.movePath || f.path, hunks: f.hunks ?? [] }));
  }
  const path = fileOf(input);
  return path ? [{ path, hunks }] : [];
}

// Valid because a row is replaced, never changed in place.
const counted = new WeakMap();
function counts(item) {
  if (!counted.has(item)) {
    counted.set(item, fileEdits(item).map(({ path, hunks }) => ({ path, ...hunkStats(hunks) })));
  }
  return counted.get(item);
}

const startsTurn = (it) => it.kind === 'user' && !it.parent;
// Failed, denied and still-running edits changed nothing.
const landed = (it) => it.kind === 'tool' && it.state === 'output-available';

// One entry per turn, `end` its last item. A subagent's edits, under its agent
// row or flat with a `parent`, count toward the turn they ran in.
export function turnEdits(items) {
  const turns = [];
  let turn = null;

  const visit = (list) => {
    for (const it of list) {
      if (landed(it)) {
        for (const { path, added, removed } of counts(it)) {
          let file = turn.files.find((f) => f.path === path);
          if (!file) turn.files.push(file = { path, added: 0, removed: 0, calls: [] });
          file.added += added;
          file.removed += removed;
          if (!file.calls.includes(it.id)) file.calls.push(it.id);
        }
      }
      if (it.children) visit(it.children);
    }
  };

  for (const it of items) {
    if (startsTurn(it)) turns.push(turn = { userId: it.id, end: it.id, files: [] });
    else if (turn) {
      turn.end = it.id;
      visit([it]);
    }
  }
  return turns;
}

export function hunksOf(transcript, calls, path) {
  const wanted = new Set(calls);
  const out = [];
  const visit = (list) => {
    for (const it of list) {
      if (wanted.has(it.id)) out.push(...fileEdits(it).filter((f) => f.path === path).flatMap((f) => f.hunks));
      if (it.children) visit(it.children);
    }
  };
  visit(transcript);
  return out;
}
