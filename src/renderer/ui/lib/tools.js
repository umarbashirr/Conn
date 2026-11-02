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

export const toolText = (output) => {
  if (typeof output === 'string') return output;
  if (!Array.isArray(output)) return JSON.stringify(output ?? '', null, 2);
  return output.map((b) => (b.type === 'image' ? '[screenshot]' : b.text ?? JSON.stringify(b))).join('\n');
};

const ROW_TEXT_LIMIT = 4000;

export const cutText = (text, limit = ROW_TEXT_LIMIT) => ({
  shown: text.slice(0, limit),
  hidden: Math.max(0, text.length - limit),
});

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
