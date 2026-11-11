// The turn outline: one entry per message you sent, and what that turn did.
// A long agent chat is found again by its turns ("where did I ask for the
// prod env", "where did that command fail"), not by how the page looks
// shrunk down. No JSX, so plain node checks the same rules the outline is
// drawn by: scripts/outline-check.mjs.
import { turnEdits } from './turns.js';

// Below this there is nothing to find, and an outline would only be clutter.
export const OUTLINE_MIN_TURNS = 4;
const WORDS = 90;
const PR_CREATE = /\bgh\s+pr\s+create\b/;

const startsTurn = (it) => it.kind === 'user' && !it.parent;
// A turn that was stopped is not one that failed.
const failed = (it) => it.kind === 'tool' && it.state === 'output-error' && it.output !== 'interrupted';
const openedPr = (it) => it.kind === 'tool' && it.output != null && PR_CREATE.test(it.input?.command || '');

// The first line of the message, which is what you remember it by.
export function firstWords(text, images = 0) {
  const line = String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  if (!line) return images ? (images === 1 ? 'An image' : `${images} images`) : 'Empty message';
  return line.length > WORDS ? `${line.slice(0, WORDS - 1).trimEnd()}…` : line;
}

export function chatOutline(items) {
  const files = new Map(turnEdits(items).map((t) => [t.userId, t.files.length]));
  const turns = [];
  let turn = null;
  const visit = (it) => {
    if (failed(it)) turn.errors += 1;
    if (openedPr(it)) turn.prs += 1;
    if (it.kind === 'perm') {
      turn.asks += 1;
      if (!it.decided) turn.waiting = true;
    }
    for (const child of it.children || []) visit(child);
  };
  for (const it of items) {
    if (startsTurn(it)) {
      turns.push(turn = {
        id: it.id,
        text: firstWords(it.text, it.images?.length || 0),
        files: files.get(it.id) || 0,
        errors: 0,
        asks: 0,
        waiting: false,
        prs: 0,
      });
    } else if (turn) visit(it);
  }
  return turns;
}

// The one colour a turn's tick takes when there is room for only one. What
// needs you beats what went wrong beats what changed.
export function toneOf(turn) {
  if (turn.waiting) return 'waiting';
  if (turn.errors) return 'error';
  if (turn.files || turn.prs) return 'edit';
  return 'plain';
}

// The tooltip's second line, in words.
export function summaryOf(turn) {
  const n = (count, one, many) => `${count} ${count === 1 ? one : many}`;
  return [
    turn.waiting && 'waiting on you',
    turn.files && n(turn.files, 'file edited', 'files edited'),
    turn.errors && n(turn.errors, 'error', 'errors'),
    turn.prs && n(turn.prs, 'PR opened', 'PRs opened'),
    !turn.waiting && turn.asks && n(turn.asks, 'permission asked', 'permissions asked'),
  ].filter(Boolean).join(' · ');
}
