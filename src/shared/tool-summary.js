'use strict';
const { BROWSER_BY_ROUTE, BROWSER_LABEL } = require('./browser-tools');

// "error" on its own reads as the call having failed. It is the level asked for.
const LEVELS = { error: 'errors', warning: 'warnings', info: 'info', debug: 'debug' };

const bareUrl = (url) => String(url || '').replace(/^https?:\/\//, '');

// Says nothing rather than echo the first string it finds in the input.
const nothing = () => '';

// One short line of context, so a collapsed row still says what it did.
const SUMMARY = {
  Bash: (i) => i.command,
  Read: (i) => tail(fileOf(i)),
  Write: (i) => tail(fileOf(i)),
  Edit: (i) => tail(fileOf(i)) + otherFiles(i),
  MultiEdit: (i) => tail(fileOf(i)),
  NotebookEdit: (i) => tail(fileOf(i)),
  Glob: (i) => i.pattern,
  Grep: (i) => i.pattern,
  WebFetch: (i) => i.url,
  Agent: (i) => i.description,
  Task: (i) => i.description,
  Skill: (i) => i.skill,
  ExitPlanMode: nothing,
  browser_navigate: (i) => bareUrl(i.url),
  browser_snapshot: nothing,
  browser_text: nothing,
  browser_click: (i) => i.target,
  browser_fill: (i) => `${i.target} = ${JSON.stringify(i.value ?? '')}`,
  browser_type: (i) => [JSON.stringify(i.text ?? ''), i.target && `into ${i.target}`].filter(Boolean).join(' '),
  browser_press: (i) => i.key,
  browser_select: (i) => `${i.target} = ${JSON.stringify(i.value ?? '')}`,
  browser_hover: (i) => i.target,
  browser_scroll: (i) => i.target || (i.dy ? `${i.dy < 0 ? 'up' : 'down'} ${Math.abs(i.dy)}px` : ''),
  browser_screenshot: (i) => i.target || (i.fullPage ? 'full page' : ''),
  browser_record: (i) => [i.action, i.name].filter(Boolean).join(' '),
  browser_console: (i) => (i.level ? `${LEVELS[i.level] || i.level} only` : 'all messages'),
  browser_network: nothing,
  browser_evaluate: (i) => i.code,
  browser_wait: (i) => i.selector || (i.ms ? `${i.ms} ms` : 'for the network to settle'),
  browser_viewport: (i) => (i.width && i.height ? `${i.width}×${i.height}` : 'reset'),
  browser_back: nothing,
  browser_forward: nothing,
  browser_reload: nothing,
  browser_state: nothing,
  browser_show: (i) => (i.open === false ? 'hide' : ''),
  browser_highlight: (i) => i.target,
  browser_tabs: nothing,
  browser_tab_new: (i) => bareUrl(i.url),
  browser_tab_select: (i) => i.tab,
  browser_tab_close: (i) => i.tab,
};

const tail = (p) => String(p || '').split('/').filter(Boolean).slice(-2).join('/');

const otherFiles = (i) => (Array.isArray(i.files) && i.files.length > 1 ? ` +${i.files.length - 1}` : '');

// ACP calls often name the file as `path` or a location, not `file_path`.
function fileOf(i = {}) {
  const locs = Array.isArray(i.locations) ? i.locations : [];
  const loc = locs.map((l) => (typeof l === 'string' ? l : l?.path || l?.uri || '')).find(Boolean);
  return i.file_path || i.path || i.filePath || i.notebook_path || i.target_file || loc || (Array.isArray(i.files) && i.files[0]?.path) || '';
}

const clip = (s) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  if (t.includes('/') && !t.includes(' ')) return tail(t);
  return t.slice(0, 120);
};

// The one spelling every table here keys on. An MCP tool arrives as
// mcp__server__thing, which says more about the plumbing than about what ran,
// and the preview bridge asks permission under the route it runs
// (browser_waitFor, browser_tabNew) rather than the tool the agent called.
function toolLabel(name) {
  const bare = String(name || '').replace(/^mcp__preview__/, '').replace(/^mcp__[^_]+__/, '');
  if (!bare.startsWith('browser_') || BROWSER_LABEL.has(bare)) return bare;
  return BROWSER_BY_ROUTE.get(bare.slice('browser_'.length)) ?? bare;
}

const NAMES = new Map([['ExitPlanMode', 'Proposed plan']]);

// What a person calls it: "Screenshot", not browser_screenshot.
const toolName = (label) =>
  BROWSER_LABEL.get(label) ?? NAMES.get(label) ?? String(label || '').replace(/^conn-/, '').replace(/^[^:\s]+:\s*/, '');

function toolSummary(name, input) {
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

module.exports = { toolLabel, toolName, toolSummary, tail, fileOf };
