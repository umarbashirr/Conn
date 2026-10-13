import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import './renderer-esm.mjs';

const require = createRequire(import.meta.url);
const { z } = require('zod');
const { browserTools } = require('../src/shared/browser-tools.js');
const { activityOf } = await import('../src/renderer/ui/lib/activity.js');

let n = 0;
const id = () => `i${++n}`;
const user = (text = 'go') => ({ id: id(), kind: 'user', text });
const said = (text = 'ok', streaming = false) => ({ id: id(), kind: 'assistant', text, streaming });
const tool = (name, input, over = {}) => ({ id: id(), kind: 'tool', name, input, state: 'input-available', ...over });
const done = (name, input, output) => tool(name, input, { state: 'output-available', output });
const perm = (name, input, over = {}) => ({ id: id(), kind: 'perm', tool: name, input, ...over });
const ended = (error = false) => ({ id: id(), kind: 'note', ended: true, error, text: error ? 'turn ended: error_during_execution 1.0s' : 'done in 1.0s' });
const note = (text) => ({ id: id(), kind: 'note', text });

const IDLE = { state: 'idle' };
const SNAPSHOT = [
  '- heading "Your cart" [ref=e2]',
  '- textbox "Coupon code" [ref=e12] value="SAVE10"',
  '- button "Apply" [ref=e13]',
  '- button "Checkout" [ref=e14]',
].join('\n');
const snapshot = (text = SNAPSHOT) => done('mcp__preview__browser_snapshot', {}, [{ type: 'text', text }]);

const is = (got, want, why) => assert.deepEqual(got, want, `${why}: ${JSON.stringify(got)}`);

is(activityOf([], false, true), IDLE, 'an empty chat is idle');
is(activityOf([user(), said(), done('Read', { file_path: '/r/a.js' }, 'x')], false, false), IDLE, 'a chat opened from disk is idle, not finished');

is(
  activityOf([user(), tool('Read', { file_path: '/repo/src/cart.js' })], true, true),
  { state: 'working', line: 'Reading src/cart.js', target: 'files' },
  'a read in flight names the file and the Files pane',
);
is(
  activityOf([user(), tool('Edit', { file_path: '/repo/src/cart.js' })], true, true),
  { state: 'working', line: 'Editing src/cart.js', target: 'changes' },
  'an edit in flight names the file and the Changes pane',
);
is(
  activityOf([user(), tool('Bash', { command: 'npm test' })], true, true),
  { state: 'working', line: 'Running npm test', target: null },
  'a command touches no pane of ours, because it runs inside the CLI',
);
is(
  activityOf([user(), said('Looking at the cart', true)], true, true),
  { state: 'working', line: 'Writing', target: null },
  'streaming prose reads as writing',
);
is(
  activityOf([user(), done('Read', { file_path: '/r/a.js' }, 'x')], true, true),
  { state: 'working', line: 'Thinking', target: null },
  'a busy chat with nothing in flight is thinking',
);
is(
  activityOf([user(), tool('Read', { file_path: '/r/a.js' }), tool('Grep', { pattern: 'applyCoupon' })], true, true),
  { state: 'working', line: 'Searching applyCoupon', target: null },
  'with two calls out, the newest names the line',
);

is(
  activityOf([user('first'), tool('Read', { file_path: '/r/stale.js' }), note('interrupted'), user('second')], true, true),
  { state: 'working', line: 'Thinking', target: null },
  'a call left in flight by a stopped turn is not what the next turn is doing',
);

const agent = { id: id(), kind: 'agent', status: 'running', description: 'Audit the diff' };
is(
  activityOf([user(), agent], false, true),
  { state: 'working', line: 'Audit the diff', target: null },
  'a subagent still running keeps an idle turn working and names itself',
);
is(
  activityOf([user(), agent, tool('Grep', { pattern: 'rail' }, { parent: agent.id })], false, true),
  { state: 'working', line: 'Searching rail', target: null },
  'a subagent step in flight is what the chat is doing',
);
is(
  activityOf([user(), { ...agent, status: 'done' }], false, true),
  IDLE,
  'a subagent that finished leaves the chat idle',
);

is(
  activityOf([user(), perm('Edit', { file_path: '/repo/src/cart.js' })], true, true),
  { state: 'waiting', line: 'Wants to edit src/cart.js' },
  'an undecided edit permission is waiting and names the file',
);
is(
  activityOf([user(), perm('Bash', { command: 'npx playwright test checkout' })], true, true),
  { state: 'waiting', line: 'Wants to run npx playwright test checkout' },
  'a command permission says run',
);
is(
  activityOf([user(), perm('Write', { file_path: '/repo/NOTES.md' })], true, true),
  { state: 'waiting', line: 'Wants to write repo/NOTES.md' },
  'a write permission says write',
);
is(
  activityOf([user(), perm('AskUserQuestion', { questions: [] })], true, true),
  { state: 'waiting', line: 'Has a question' },
  'a question is waiting on the person too, and is not a request to run something',
);
is(
  activityOf([user(), snapshot(), perm('mcp__preview__browser_click', { target: 'e13' })], true, true),
  { state: 'waiting', line: 'Wants to click Apply' },
  'a browser permission names the element the snapshot gave it',
);
is(
  activityOf([user(), tool('Read', { file_path: '/r/a.js' }), perm('Edit', { file_path: '/r/b.js' })], true, true),
  { state: 'waiting', line: 'Wants to edit r/b.js' },
  'waiting wins over a call in flight',
);
is(
  activityOf([user(), perm('Edit', { file_path: '/r/b.js' }, { decided: 'allow' })], true, true),
  { state: 'working', line: 'Thinking', target: null },
  'a decided permission no longer waits',
);

is(activityOf([user(), said(), ended()], false, false), { state: 'finished', line: 'Finished' }, 'an unseen finished turn is finished');
is(activityOf([user(), said(), ended(true)], false, false), { state: 'finished', line: 'Ended with an error' }, 'a failed turn says so');
is(activityOf([user(), said(), ended()], false, true), IDLE, 'a finished turn the person has opened is idle');
is(activityOf([user(), said(), ended(), user('more')], false, false), IDLE, 'a new message ends finished before the turn starts');
is(
  activityOf([user(), said(), ended(), user('more'), tool('Bash', { command: 'ls' })], true, false),
  { state: 'working', line: 'Running ls', target: null },
  'the next turn is working whether or not the last one was seen',
);
is(activityOf([user(), said(), note('context compacted')], false, false), IDLE, 'a note that does not end a turn does not finish one');

is(
  activityOf([user(), snapshot(), tool('mcp__preview__browser_click', { target: 'e13' })], true, true),
  { state: 'working', line: 'Clicking Apply', target: 'browser' },
  'a click after a snapshot reads the element name',
);
is(
  activityOf([user(), tool('mcp__preview__browser_click', { target: 'e13' })], true, true),
  { state: 'working', line: 'Clicking in the page', target: 'browser' },
  'a click with no snapshot has no name to give',
);
is(
  activityOf([user(), snapshot(), tool('mcp__preview__browser_click', { target: 'e99' })], true, true),
  { state: 'working', line: 'Clicking in the page', target: 'browser' },
  'a ref the snapshot does not hold has no name to give',
);
is(
  activityOf([user(), snapshot(), tool('mcp__preview__browser_click', { target: '#apply' })], true, true),
  { state: 'working', line: 'Clicking in the page', target: 'browser' },
  'a selector is not a name',
);
is(
  activityOf([user(), snapshot('- button "Reset" [ref=e13]'), snapshot(), tool('browser_click', { target: 'e13' })], true, true),
  { state: 'working', line: 'Clicking Apply', target: 'browser' },
  'the newest snapshot names the ref, under the bare tool name too',
);
is(
  activityOf([user(), done('mcp__conn__browser_snapshot', {}, SNAPSHOT), tool('mcp__conn__browser_click', { target: 'e13' })], true, true),
  { state: 'working', line: 'Clicking Apply', target: 'browser' },
  'a snapshot and a click under the codex prefix pair up as well',
);
is(
  activityOf([user(), snapshot('- button "Say \\"hi\\"" [ref=e13]'), tool('mcp__preview__browser_click', { target: 'e13' })], true, true),
  { state: 'working', line: 'Clicking Say "hi"', target: 'browser' },
  'an escaped quote in a name comes back as the quote',
);
is(
  activityOf([user(), done('mcp__preview__browser_snapshot', {}, SNAPSHOT), tool('mcp__preview__browser_hover', { target: 'e14' })], true, true),
  { state: 'working', line: 'Hovering Checkout', target: 'browser' },
  'a hover reads the element name from a plain-string result',
);
is(
  activityOf([user(), tool('mcp__preview__browser_navigate', { url: 'http://localhost:5173/cart' })], true, true),
  { state: 'working', line: 'Opening localhost:5173/cart', target: 'browser' },
  'a navigation names the page',
);
is(
  activityOf([user(), tool('mcp__preview__browser_snapshot', {})], true, true),
  { state: 'working', line: 'Reading the page', target: 'browser' },
  'a snapshot in flight reads the page',
);
is(
  activityOf([user(), tool('mcp__preview__browser_screenshot', {})], true, true),
  { state: 'working', line: 'Screenshotting', target: 'browser' },
  'a screenshot in flight reads as one',
);

const filler = (count) => Array.from({ length: count }, (_, i) => (i % 3
  ? done('Read', { file_path: `/repo/src/f${i}.js` }, 'x'.repeat(200))
  : said(`step ${i}`)));
const bigSnapshot = snapshot(Array.from({ length: 600 }, (_, i) => `- button "Item ${i}" [ref=e${i + 20}]`).join('\n'));
const click = (target) => tool('mcp__preview__browser_click', { target });

const LONG = {
  thinking: { items: [user(), ...filler(1999)], busy: true, seen: true, want: { state: 'working', line: 'Thinking', target: null } },
  click: { items: [user(), bigSnapshot, ...filler(1997), click('e21')], busy: true, seen: true, want: { state: 'working', line: 'Clicking Item 1', target: 'browser' } },
  waiting: { items: [user(), ...filler(1998), perm('Edit', { file_path: '/repo/src/cart.js' })], busy: true, seen: true, want: { state: 'waiting', line: 'Wants to edit src/cart.js' } },
  finished: { items: [user(), ...filler(1998), ended()], busy: false, seen: false, want: { state: 'finished', line: 'Finished' } },
};

const median = (run) => {
  for (let i = 0; i < 50; i++) run();
  const times = [];
  for (let i = 0; i < 200; i++) {
    const t = performance.now();
    run();
    times.push(performance.now() - t);
  }
  return times.sort((a, b) => a - b)[times.length >> 1];
};

const BUDGET_MS = 0.5;
for (const [name, { items, busy, seen, want }] of Object.entries(LONG)) {
  assert.ok(items.length >= 2000, `the ${name} transcript has ${items.length} items`);
  is(activityOf(items, busy, seen), want, `a ${items.length}-item transcript reads its ${name} state`);
  const ms = median(() => activityOf(items, busy, seen));
  console.log(`activityOf ${name} on ${items.length} items: ${(ms * 1000).toFixed(0)} us at the median, budget ${BUDGET_MS * 1000} us`);
  assert.ok(ms < BUDGET_MS, `activityOf took ${ms.toFixed(3)} ms on the ${name} transcript`);
}

for (const t of browserTools(z)) {
  const got = activityOf([user(), tool(`mcp__preview__${t.name}`, {})], true, true);
  assert.equal(got.state, 'working', `${t.name} in flight is working`);
  assert.equal(got.target, 'browser', `${t.name} touches the browser pane`);
  assert.doesNotMatch(got.line, /browser_|mcp__/, `${t.name} reads as ${JSON.stringify(got.line)}, not its plumbing name`);
}

const frozen = Object.freeze([user(), Object.freeze(tool('Bash', Object.freeze({ command: 'ls' })))]);
is(activityOf(frozen, true, true), { state: 'working', line: 'Running ls', target: null }, 'a frozen transcript reads the same, so activityOf reads and never writes');

console.log('activity-check: all passed');
