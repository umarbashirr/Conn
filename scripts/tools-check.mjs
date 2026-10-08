/* The tool vocabulary under plain node. Every browser tool in the shared table
   has a name a person reads, every spelling it arrives under maps back to it,
   and the rows have an icon and a summary for it, so a new tool cannot reach
   the transcript as a wrench and its plumbing name. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';

// package.json pins "type": "commonjs", so the renderer's files are read as
// the ES modules vite reads them as.
registerHooks({
  load(url, context, next) {
    const loaded = next(url, context);
    return url.includes('/src/renderer/') ? { ...loaded, format: 'module' } : loaded;
  },
});

const require = createRequire(import.meta.url);
const { z } = require('zod');
const { browserTools, BROWSER_LABEL, BROWSER_BY_ROUTE } = require('../src/shared/browser-tools.js');
const { toolLabel, toolName, toolSummary, bucketOf, toolImages, imageSrc } = await import('../src/renderer/ui/lib/tools.js');
await import('../src/renderer/ui/lib/subagents.js');

const TOOLS = browserTools(z);
const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

for (const t of TOOLS) {
  assert.ok(typeof t.label === 'string' && t.label.trim(), `${t.name} has a label`);
  assert.equal(BROWSER_LABEL.get(t.name), t.label, `BROWSER_LABEL names ${t.name} ${t.label}`);
  for (const route of [t.bridgeTool, ...(t.routes || [])]) {
    assert.equal(BROWSER_BY_ROUTE.get(route), t.name, `bridge route ${route} maps back to ${t.name}`);
  }
}

for (const t of TOOLS.filter((x) => x.route)) {
  const full = Object.fromEntries(Object.keys(t.schema).map((k) => [k, 1]));
  for (const args of [{}, full]) {
    assert.ok(t.routes?.includes(t.route(args)), `${t.name} lists ${t.route(args)} in routes, since route() picks it`);
  }
}

const PREFIXES = ['', 'mcp__preview__', 'mcp__conn__'];
const SPELLINGS = {
  browser_waitFor: 'browser_wait',
  browser_scrollTo: 'browser_scroll',
  browser_setViewport: 'browser_viewport',
  browser_clearViewport: 'browser_viewport',
  browser_preview: 'browser_show',
  browser_tabNew: 'browser_tab_new',
  browser_tabSelect: 'browser_tab_select',
  browser_tabClose: 'browser_tab_close',
};
for (const prefix of PREFIXES) {
  for (const t of TOOLS) assert.equal(toolLabel(prefix + t.name), t.name, `${prefix}${t.name} is ${t.name}`);
  for (const [spelling, tool] of Object.entries(SPELLINGS)) {
    assert.equal(toolLabel(prefix + spelling), tool, `${prefix}${spelling} is ${tool}`);
  }
}
for (const t of TOOLS) {
  for (const route of [t.bridgeTool, ...(t.routes || [])]) {
    assert.equal(toolLabel(`browser_${route}`), t.name, `the bridge's browser_${route} is ${t.name}`);
  }
}
assert.equal(toolLabel('Bash'), 'Bash', 'Bash keeps its name');
assert.equal(toolLabel('Read'), 'Read', 'Read keeps its name');
assert.equal(toolLabel('mcp__github__search'), 'search', 'another MCP server\'s tool loses its server prefix');
assert.equal(toolLabel('browser_unheardOf'), 'browser_unheardOf', 'an unknown browser_ name passes through');

for (const t of TOOLS) assert.equal(toolName(t.name), t.label, `${t.name} shows as ${t.label}`);
assert.equal(toolName('Bash'), 'Bash', 'a tool with no label shows its own name');
assert.equal(toolName('conn-review'), 'review', 'toolName drops the conn- prefix');
assert.equal(toolName('github: create_issue'), 'create_issue', 'toolName drops a server: prefix');

for (const t of TOOLS) {
  assert.notEqual(toolSummary(t.name, { stray: 'leftover' }), 'leftover', `${t.name} has a summary of its own, not the first string in its input`);
}
const SUMMARIES = [
  ['browser_console', { level: 'error' }, 'errors only'],
  ['browser_console', { level: 'warning' }, 'warnings only'],
  ['browser_console', { level: 'info' }, 'info only'],
  ['browser_console', { level: 'debug' }, 'debug only'],
  ['browser_console', { limit: 20 }, 'all messages'],
  ['browser_wait', { selector: '#app' }, '#app'],
  ['browser_wait', { ms: 500 }, '500 ms'],
  ['browser_wait', {}, 'for the network to settle'],
  [toolLabel('browser_waitFor'), { networkIdle: true }, 'for the network to settle'],
  ['browser_navigate', { url: 'http://localhost:3000' }, 'localhost:3000'],
  ['browser_navigate', { url: 'https://example.com' }, 'example.com'],
  ['browser_screenshot', { target: '#hero' }, '#hero'],
  ['browser_screenshot', { fullPage: true }, 'full page'],
  ['browser_screenshot', {}, ''],
  ['browser_snapshot', { stray: 'leftover' }, ''],
  ['browser_text', { max: 2000, stray: 'leftover' }, ''],
  ['browser_tabs', { stray: 'leftover' }, ''],
  ['browser_state', { stray: 'leftover' }, ''],
  ['browser_network', { limit: 5, stray: 'leftover' }, ''],
  ['browser_back', { stray: 'leftover' }, ''],
  ['browser_forward', { stray: 'leftover' }, ''],
  ['browser_reload', { stray: 'leftover' }, ''],
  ['browser_type', { text: 'hello', target: '#q' }, '"hello" into #q'],
  ['browser_type', { text: 'hello' }, '"hello"'],
  ['browser_select', { target: '#size', value: 'L' }, '#size = "L"'],
  ['browser_hover', { target: 'e12' }, 'e12'],
  ['browser_highlight', { target: '#cta' }, '#cta'],
  ['browser_scroll', { target: '#footer' }, '#footer'],
  ['browser_scroll', { dy: 400 }, 'down 400px'],
  ['browser_scroll', { dy: -200 }, 'up 200px'],
  ['browser_viewport', { width: 375, height: 812 }, '375×812'],
  ['browser_viewport', {}, 'reset'],
  ['browser_tab_new', { url: 'https://docs.example.com' }, 'docs.example.com'],
  ['browser_tab_new', {}, ''],
  ['browser_tab_select', { tab: 't2' }, 't2'],
  ['browser_tab_close', { tab: 't2' }, 't2'],
  ['browser_tab_close', {}, ''],
  ['browser_show', { open: false }, 'hide'],
  ['browser_show', { open: true }, ''],
  ['Skill', { skill: 'pdf' }, 'pdf'],
];
for (const [label, input, want] of SUMMARIES) {
  assert.equal(toolSummary(label, input), want, `${label} ${JSON.stringify(input)} reads "${want}"`);
}

const BUCKETS = [
  [{ kind: 'agent', name: 'Agent' }, 'agent'],
  [{ kind: 'tool', name: 'Skill' }, 'skill'],
  [{ kind: 'tool', name: 'mcp__preview__browser_click' }, 'browser'],
  [{ kind: 'tool', name: 'mcp__conn__browser_screenshot' }, 'browser'],
  [{ kind: 'tool', name: 'browser_waitFor' }, 'browser'],
  [{ kind: 'tool', name: 'browser_unheardOf' }, 'browser'],
  [{ kind: 'tool', name: 'Edit' }, 'edit'],
  [{ kind: 'tool', name: 'Bash' }, 'command'],
  [{ kind: 'tool', name: 'Read' }, 'file'],
  [{ kind: 'tool', name: 'Grep' }, 'search'],
  [{ kind: 'tool', name: 'WebFetch' }, 'fetch'],
  [{ kind: 'tool', name: 'TodoWrite' }, 'step'],
];
for (const [item, want] of BUCKETS) assert.equal(bucketOf(item), want, `${item.name} counts as ${want}`);

const live = { type: 'image', path: '/tmp/conn shots/a.png' };
const replayed = { type: 'image', source: { data: 'R0lGOD', media_type: 'image/gif' } };
assert.deepEqual(
  toolImages([{ type: 'text', text: 'saved' }, live, { type: 'image' }, replayed]),
  [live, replayed],
  'toolImages keeps the image blocks that carry a path or bytes',
);
assert.deepEqual(toolImages('plain output'), [], 'a string result has no images');
assert.equal(imageSrc(live), 'file:///tmp/conn%20shots/a.png', 'a live screenshot loads from its file');
assert.equal(imageSrc(replayed), 'data:image/gif;base64,R0lGOD', 'a replayed screenshot loads from its bytes');

const icons = read('src/renderer/ui/components/tool-row.jsx').match(/const ICONS = \{([\s\S]*?)\n\};/)?.[1] ?? '';
const iconKeys = new Set([...icons.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]));
for (const name of [...TOOLS.map((t) => t.name), 'Skill']) assert.ok(iconKeys.has(name), `ICONS has an icon for ${name}`);

assert.doesNotMatch(read('src/renderer/ui/lib/subagents.js'), /from '@\/components/, 'lib/subagents.js imports no component, so plain node can load it');

console.log('tools-check: all passed');
