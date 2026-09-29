// A subagent as every surface sees it: the row in the chat, the Working pill
// and panel, the sheet, and the Agents tab. Each asks here what state one is
// in and what it is doing, so no two of them can disagree.
import { toolLabel, toolSummary } from '@/components/tool-row';

// The wire says more than this (a stop still on its way, a status a newer SDK
// made up), but these four are the answers anything on screen gives.
export function statusOf(item) {
  switch (item.status) {
    case 'running':
    case 'stopping':
      return 'running';
    case 'failed':
    case 'error':
      return 'error';
    case 'stopped':
    case 'killed':
      return 'stopped';
    default:
      return 'done';
  }
}

export const isLive = (item) => statusOf(item) === 'running';

export const nameOf = (item) => item.description || item.input?.description || 'Agent';

export const isExplore = (item) => /explore/i.test(item.agentType || '');

// Every subagent in a tree of items, at any depth, oldest first. One can start
// its own, and those are as worth opening as the top ones.
export function subagentsIn(items, out = []) {
  for (const it of items) {
    if (it.kind !== 'agent') continue;
    out.push(it);
    subagentsIn(it.children || [], out);
  }
  return out;
}

// Nothing on the wire carries a status string, so the newest step is the
// closest thing to one: "Reading agent-row.jsx" rather than a timer.
const DOING = {
  Read: 'Reading',
  NotebookRead: 'Reading',
  Glob: 'Searching',
  Grep: 'Searching',
  WebSearch: 'Searching',
  WebFetch: 'Fetching',
  Bash: 'Running',
  Edit: 'Editing',
  MultiEdit: 'Editing',
  NotebookEdit: 'Editing',
  Write: 'Writing',
};

const doingTool = (name, input) => {
  const label = toolLabel(name);
  return [DOING[label] || label, toolSummary(label, input)].filter(Boolean).join(' ');
};

// A line of prose it is writing reads better cut at its first sentence.
const firstSentence = (text) => (text || '').trim().split(/(?<=[.!?:])\s|\n/)[0];

function doing(item) {
  const steps = item.children?.length ? item.children : item.peek || [];
  const last = steps[steps.length - 1];
  if (last?.kind === 'tool' && last.state === 'input-available') return doingTool(last.name, last.input);
  if (last?.kind === 'assistant' && last.streaming) return `${firstSentence(last.text) || 'Writing'}…`;
  if (!steps.length && item.lastTool) return doingTool(item.lastTool);
  return 'Planning next moves';
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// The counts its own result reports, in the order they say most about what it did.
function stats(s) {
  if (!s) return [];
  const out = [];
  if (s.readCount) out.push(plural(s.readCount, 'read', 'reads'));
  if (s.searchCount) out.push(plural(s.searchCount, 'search', 'searches'));
  if (s.bashCount) out.push(plural(s.bashCount, 'command', 'commands'));
  if (s.editFileCount) out.push(plural(s.editFileCount, 'edit', 'edits'));
  if (s.linesAdded || s.linesRemoved) out.push(`+${s.linesAdded || 0} −${s.linesRemoved || 0}`);
  return out;
}

// What it is doing while it runs, and what it did once it has stopped.
export function activityOf(item) {
  const status = statusOf(item);
  switch (status) {
    case 'running':
      if (item.status === 'stopping') return 'Stopping…';
      if (item.waiting) return 'Needs you';
      return doing(item);
    case 'done':
      return stats(item.stats).join(' · ') || item.summary || '';
    case 'error':
      return item.summary || 'Failed';
    case 'stopped':
      return 'Stopped';
    default:
      throw new Error(`unhandled subagent status ${status}`);
  }
}
