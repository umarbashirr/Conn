// What a chat is doing right now, in one line a glance can read. The rail, the
// status bar and the pane pill all draw this, so none of them works out for
// itself whether a chat is stuck on a permission or only thinking.
import { bucketOf, toolLabel, toolName, toolSummary, toolText } from './tools.js';
import { doingTool, isLive, nameOf } from './subagents.js';

/**
 * @typedef {'browser' | 'files' | 'changes'} Pane
 * @typedef {{ state: 'idle' }
 *   | { state: 'working', line: string, target: Pane | null }
 *   | { state: 'waiting', line: string }
 *   | { state: 'finished', line: string }} Activity
 *
 * `target` is the pane the call in flight touches, and null when nothing a
 * pane could show is going on: Bash runs inside the CLI, and thinking has no
 * call at all. `finished` is a turn that ended in a chat nobody has opened
 * since.
 */

export const IDLE = Object.freeze({ state: 'idle' });

const PANE = { browser: 'browser', file: 'files', edit: 'changes' };

const WANTS = {
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Write: 'write',
  Bash: 'run',
  Read: 'read',
  WebFetch: 'fetch',
};

// These browser calls point at an element by a ref the page handed out, and
// the ref says nothing to the person reading the line.
const AT_ELEMENT = new Set(['browser_click', 'browser_hover', 'browser_highlight']);
const ELSEWHERE = 'in the page';
const REF = /^e\d+$/;

const isAsk = (it) => it.kind === 'perm' && !it.decided;
const isLiveAgent = (it) => it.kind === 'agent' && isLive(it);

// The snapshot is a list of `- role "name" [ref=eN]` lines, the name a JSON
// string. Every spelling the call arrives under ends the same way, which is
// cheaper to test than toolLabel across a long transcript. Only the newest
// answer counts: a ref belongs to the page that gave it
// out, and a click names whatever the last look at that page called it.
function elementName(items, before, ref) {
  for (let i = before - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind !== 'tool' || it.output == null || !it.name.endsWith('browser_snapshot')) continue;
    const hit = new RegExp(`^\\s*- \\S+ ("(?:[^"\\\\]|\\\\.)*") \\[ref=${ref}\\]`, 'm').exec(toolText(it.output));
    return hit ? JSON.parse(hit[1]) : null;
  }
  return null;
}

function inputFor(items, at, label, input) {
  if (!AT_ELEMENT.has(label)) return input;
  const ref = input?.target;
  return { ...input, target: (REF.test(ref) && elementName(items, at, ref)) || ELSEWHERE };
}

function wants(items, at) {
  const ask = items[at];
  if (ask.tool === 'AskUserQuestion') return 'Has a question';
  const label = toolLabel(ask.tool);
  return [
    'Wants to',
    WANTS[label] ?? toolName(label).toLowerCase(),
    toolSummary(label, inputFor(items, at, label, ask.input)),
  ].filter(Boolean).join(' ');
}

// The newest call or line of prose the turn has started and not finished, as an
// index, or -1. Walking back stops at the message or note that opened or closed
// the turn. A stopped turn leaves its call in flight for good, and that is not
// what the next turn is doing.
function stepIn(items) {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === 'user' || it.kind === 'note') return -1;
    if (it.kind === 'tool' && it.state === 'input-available') return i;
    if (it.kind === 'assistant' && it.streaming) return i;
  }
  return -1;
}

/**
 * @param {readonly object[]} items The chat's transcript, flat, subagent steps included.
 * @param {boolean} busy Whether a turn is running.
 * @param {boolean} seen Whether the person has opened the chat since its last turn ended.
 * @returns {Activity}
 */
export function activityOf(items, busy, seen) {
  const ask = items.findIndex(isAsk);
  if (ask >= 0) return { state: 'waiting', line: wants(items, ask) };

  const agent = items.findLast(isLiveAgent);
  if (busy || agent) {
    const at = stepIn(items);
    if (at < 0) return { state: 'working', line: agent ? nameOf(agent) : 'Thinking', target: null };
    const step = items[at];
    if (step.kind === 'assistant') return { state: 'working', line: 'Writing', target: null };
    const label = toolLabel(step.name);
    return {
      state: 'working',
      line: doingTool(step.name, inputFor(items, at, label, step.input)),
      target: PANE[bucketOf(step)] ?? null,
    };
  }

  const last = items[items.length - 1];
  if (!seen && last?.kind === 'note' && last.ended) {
    return { state: 'finished', line: last.error ? 'Ended with an error' : 'Finished' };
  }
  return IDLE;
}
