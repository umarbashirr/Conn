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

const AT_ELEMENT = new Set(['browser_click', 'browser_hover', 'browser_highlight']);
const ELSEWHERE = 'in the page';
const REF = /^e\d+$/;

const isSnapshot = (it) => it.kind === 'tool' && it.output != null && it.name.endsWith('browser_snapshot');

function elementName(items, before, ref) {
  for (let i = before - 1; i >= 0; i--) {
    if (!isSnapshot(items[i])) continue;
    const hit = new RegExp(`^\\s*- \\S+ ("(?:[^"\\\\]|\\\\.)*") \\[ref=${ref}\\]`, 'm').exec(toolText(items[i].output));
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

// One walk back from the newest item finds everything the line needs. The call
// or prose in flight only counts inside the current turn, so it stops counting
// at the message or note that opened or closed the turn. A permission or a live
// subagent counts wherever it sits.
function scan(items) {
  const found = { ask: -1, agent: null, step: -1, edge: null };
  let behindTurnEdge = false;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    switch (it.kind) {
      case 'perm':
        if (!it.decided) found.ask = i;
        break;
      case 'agent':
        if (!found.agent && isLive(it)) found.agent = it;
        break;
      case 'tool':
        if (!behindTurnEdge && found.step < 0 && it.state === 'input-available') found.step = i;
        break;
      case 'assistant':
        if (!behindTurnEdge && found.step < 0 && it.streaming) found.step = i;
        break;
      case 'user':
        behindTurnEdge = true;
        found.edge ??= it;
        break;
      case 'note':
        behindTurnEdge = true;
        if (it.ended) found.edge ??= it;
        break;
    }
    if (found.ask >= 0) break;
  }
  return found;
}

/**
 * @param {readonly object[]} items The chat's transcript, flat, subagent steps included.
 * @param {boolean} busy Whether a turn is running.
 * @param {boolean} seen Whether the person has opened the chat since its last turn ended.
 * @returns {Activity}
 */
export function activityOf(items, busy, seen) {
  const { ask, agent, step: at, edge } = scan(items);
  if (ask >= 0) return { state: 'waiting', line: wants(items, ask) };

  if (busy || agent) {
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

  if (!seen && edge?.ended) return { state: 'finished', line: edge.error ? 'Ended with an error' : 'Finished' };
  return IDLE;
}
