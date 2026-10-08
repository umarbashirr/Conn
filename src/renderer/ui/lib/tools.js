// What a tool call is called, what it did in a line, and what kind of work it
// was. No JSX, so lib code and plain node read the same vocabulary the rows do.

// One short line of context, so a collapsed row still says what it did.
const SUMMARY = {
  Bash: (i) => i.command,
  Read: (i) => tail(fileOf(i)),
  Write: (i) => tail(fileOf(i)),
  Edit: (i) => tail(fileOf(i)),
  MultiEdit: (i) => tail(fileOf(i)),
  NotebookEdit: (i) => tail(fileOf(i)),
  Glob: (i) => i.pattern,
  Grep: (i) => i.pattern,
  WebFetch: (i) => i.url,
  Agent: (i) => i.description,
  Task: (i) => i.description,
  browser_navigate: (i) => i.url,
  browser_click: (i) => i.target,
  browser_fill: (i) => `${i.target} = ${JSON.stringify(i.value ?? '')}`,
  browser_evaluate: (i) => i.code,
  browser_press: (i) => i.key,
};

const tail = (p) => String(p || '').split('/').filter(Boolean).slice(-2).join('/');

// ACP calls often name the file as `path` or a location, not `file_path`.
function fileOf(i = {}) {
  const locs = Array.isArray(i.locations) ? i.locations : [];
  const loc = locs.map((l) => (typeof l === 'string' ? l : l?.path || l?.uri || '')).find(Boolean);
  return i.file_path || i.path || i.filePath || i.notebook_path || i.target_file || loc || '';
}

const clip = (s) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  if (t.includes('/') && !t.includes(' ')) return tail(t);
  return t.slice(0, 120);
};

// The name to show. An MCP tool arrives as mcp__server__thing, which says more
// about the plumbing than about what ran.
export const toolLabel = (name) =>
  String(name || '').replace(/^mcp__preview__/, '').replace(/^mcp__[^_]+__/, '');

export function toolSummary(name, input) {
  const i = input || {};
  const fn = SUMMARY[name];
  const raw = fn ? fn(i) : null;
  const fromFn = raw == null || typeof raw === 'object' ? '' : clip(raw);
  if (fromFn) return fromFn;
  const titled = typeof i.title === 'string' ? i.title.trim() : '';
  const bare = titled.replace(new RegExp(`^${String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+`, 'i'), '');
  if (bare && bare.toLowerCase() !== String(name || '').trim().toLowerCase()) return clip(bare);
  if (!fn) {
    const first = Object.values(i).find((v) => typeof v === 'string' && v.trim() && v.trim() !== titled);
    if (first) return clip(first);
  }
  return '';
}

// What a run is made of. Anything without a word of its own is a step,
// because "3 browser_click calls" is not a sentence.
export const BUCKET = {
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
};

export const toolText = (output) => {
  if (typeof output === 'string') return output;
  if (!Array.isArray(output)) return JSON.stringify(output ?? '', null, 2);
  return output.map((b) => (b.type === 'image' ? '[screenshot]' : b.text ?? JSON.stringify(b))).join('\n');
};

// Live tool results carry a path (main strips the base64 before IPC); a replayed
// transcript still carries the bytes for its most recent few. Handle both.
export const toolImages = (output) =>
  (Array.isArray(output) ? output : []).filter((b) => b.type === 'image' && (b.path || b.source?.data));

export const imageSrc = (b) => (b.path
  ? `file://${encodeURI(b.path)}`
  : `data:${b.source.media_type || 'image/png'};base64,${b.source.data}`);
