// What a tool call is called, what it did in a line, and what kind of work it
// was. No JSX, so lib code and plain node read the same vocabulary the rows do.
import { fileOf, tail, toolLabel, toolName, toolSummary } from '../../../shared/tool-summary.js';

export { fileOf, tail, toolLabel, toolName, toolSummary };

// What a run is made of. Anything without a word of its own is a step,
// because "3 TodoWrite calls" is not a sentence.
const BUCKET = {
  Bash: 'command',
  Read: 'file',
  NotebookRead: 'file',
  Glob: 'search',
  Grep: 'search',
  WebSearch: 'search',
  WebFetch: 'fetch',
  Edit: 'edit',
  Write: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Skill: 'skill',
};

// Every browser tool is the same kind of work, named or not, and a subagent
// is its own.
export function bucketOf(item) {
  if (item.kind === 'agent') return 'agent';
  const label = toolLabel(item.name);
  return BUCKET[label] || (label.startsWith('browser_') ? 'browser' : 'step');
}

// Present tense for a call in flight and for a subagent's newest step, past
// tense for one that landed. A tool with no entry keeps its name.
export const DOING = {
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
  browser_navigate: 'Opening',
  browser_snapshot: 'Reading the page',
  browser_text: 'Reading the page',
  browser_click: 'Clicking',
  browser_fill: 'Filling',
  browser_type: 'Typing',
  browser_press: 'Pressing',
  browser_select: 'Selecting',
  browser_hover: 'Hovering',
  browser_scroll: 'Scrolling',
  browser_screenshot: 'Screenshotting',
  browser_record: 'Recording',
  browser_evaluate: 'Evaluating',
  browser_wait: 'Waiting',
  browser_highlight: 'Highlighting',
  browser_back: 'Going back',
  browser_forward: 'Going forward',
  browser_reload: 'Reloading the page',
  browser_tab_new: 'Opening a tab',
};

const DONE = {
  Read: 'Read',
  NotebookRead: 'Read',
  Glob: 'Searched',
  Grep: 'Searched',
  WebSearch: 'Searched',
  WebFetch: 'Fetched',
  Bash: 'Ran',
  Edit: 'Edited',
  MultiEdit: 'Edited',
  NotebookEdit: 'Edited',
  Write: 'Wrote',
};

const IN_FLIGHT = new Set(['input-available', 'input-streaming']);

// The word a row leads with. Browser tools are named by what they are, not by
// a verb, so they never take one. A failed call keeps its name too: "Ran" or
// "Edited" in red would claim the work happened.
export function toolTitle(label, state) {
  if (label.startsWith('browser_') || state === 'output-error') return toolName(label);
  return (IN_FLIGHT.has(state) ? DOING : DONE)[label] || toolName(label);
}

export const toolText = (output) => {
  if (typeof output === 'string') return output;
  if (!Array.isArray(output)) return JSON.stringify(output ?? '', null, 2);
  return output.map((b) => (b.type === 'image' ? '[screenshot]' : b.text ?? JSON.stringify(b))).join('\n');
};

export const ROW_TEXT_LIMIT = 4000;

// Live tool results carry a path (main strips the base64 before IPC); a replayed
// transcript still carries the bytes for its most recent few. Handle both.
export const toolImages = (output) =>
  (Array.isArray(output) ? output : []).filter((b) => b.type === 'image' && (b.path || b.source?.data));

export function toolRecording(output) {
  for (const b of Array.isArray(output) ? output : []) {
    if (b?.type !== 'text' || !String(b.text).startsWith('{')) continue;
    try {
      const r = JSON.parse(b.text);
      if (/\.(mp4|webm)$/i.test(r.path || '')) return r;
    } catch {}
  }
  return null;
}

export const imageSrc = (b) => (b.path
  ? `file://${encodeURI(b.path)}`
  : `data:${b.source.media_type || 'image/png'};base64,${b.source.data}`);
