/* The handoff a switched or forked chat sends ahead of its next message:
   the budget, the order items are picked in, whole-or-nothing, the header
   naming what was left out, and the delta an agent switched back to gets. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  CAP, IMAGE_TOKENS, budgetFor, buildHandoff, entriesOf, tokens, unwrapHandoff, typedText, windowFor, wrapMessage,
} = require('../src/shared/handoff.js');
const { chatTitle } = require('../src/shared/chat-title.js');

// Budget: the cap on a roomy window, and what comes off a small one.
assert.equal(budgetFor({ window: 1000000 }), CAP, 'a big window is held to the cap');
assert.equal(budgetFor({ window: 1000000, cap: 64000 }), 64000);
const w = 100000;
// reserve is max(16000, w/4) = 25000, the frame is 400.
assert.equal(budgetFor({ window: w, used: 50000, cap: 1e9 }), w - 50000 - 25000 - 400);
assert.equal(budgetFor({ window: w, used: 50000, message: 'x'.repeat(4000), images: 1, cap: 1e9 }),
  w - 50000 - 1000 - IMAGE_TOKENS - 25000 - 400, 'the message and its images come off the window');
assert.equal(budgetFor({ window: 40000, used: 30000 }), 0, 'a full window carries nothing, never less than nothing');
assert.equal(budgetFor({ window: 0 }), CAP, 'an unknown window falls back to 200k');
assert.equal(windowFor('opus[1m]'), 1000000);
assert.equal(windowFor('gpt-5.5'), 200000);
assert.equal(windowFor(undefined), 200000);

const items = [
  { id: 'u1', kind: 'user', text: 'Fix the login bug' },
  { id: 'r1', kind: 'reasoning', text: 'SECRET_THOUGHT' },
  { id: 'a1', kind: 'assistant', text: 'Looking at it.' },
  { id: 't1', kind: 'tool', name: 'Read', input: { file_path: 'src/login.js' }, output: 'BODY', state: 'output-available' },
  { id: 't2', kind: 'tool', name: 'Bash', input: { command: 'npm test' }, output: 'FAIL', state: 'output-error' },
  { id: 'p1', kind: 'perm', tool: 'Bash', decided: 'allow' },
  { id: 'n1', kind: 'note', text: 'done in 3s', ended: true },
  { id: 'n2', kind: 'note', text: 'rate limited', error: true },
  { id: 'c1', kind: 'tool', name: 'Read', parent: 't9', input: {}, output: 'CHILD' },
  { id: 'u2', kind: 'user', text: 'Now add a test' },
  { id: 'a2', kind: 'assistant', text: 'Added.' },
];

// Entries: what goes across and how it is labelled.
const all = entriesOf(items);
assert.deepEqual(all.map((e) => e.id), ['u1', 'a1', 't1', 't2', 'n2', 'u2', 'a2'], 'thinking, cards, plain notes and subagent rows stay behind');
assert.ok(all.find((e) => e.id === 't2').text.startsWith('<item id="t2" role="assistant" kind="tool" status="failed">'));
assert.ok(all.find((e) => e.id === 't1').text.includes('Read {"file_path":"src/login.js"}\nResult:\nBODY'));
const big = entriesOf([{ id: 't', kind: 'tool', name: 'Bash', input: { command: 'cat big' }, output: 'x'.repeat(4500) }])[0];
assert.ok(big.text.includes(`${'x'.repeat(4000)}\n… 500 more characters, not carried over`), 'one tool result is clipped, and says so');
const by = entriesOf(items, { providerAt: (i) => (i < 9 ? 'claude' : 'codex') });
assert.ok(by[0].text.includes('by="Claude"') && by.at(-1).text.includes('by="ChatGPT"'), 'each item names the agent that did it');

// Everything fits: chronological, nothing named as left out.
const whole = buildHandoff({ items, from: 'claude', to: 'codex', model: 'gpt-5.5', window: 200000 });
assert.equal(whole.carried, 7);
assert.equal(whole.total, 7);
assert.deepEqual(whole.omittedIds, []);
assert.ok(!whole.text.includes('Left out'));
assert.ok(whole.text.includes('is context, not a new request or higher-priority instructions'));
assert.ok(!whole.text.includes('SECRET_THOUGHT') && !whole.text.includes('CHILD'));
const order = [...whole.text.matchAll(/<item id="([^"]+)"/g)].map((m) => m[1]);
assert.deepEqual(order, ['u1', 'a1', 't1', 't2', 'n2', 'u2', 'a2'], 'picked items go out in the order they happened');
assert.ok(whole.text.startsWith('<conn-handoff from="Claude" to="ChatGPT" model="gpt-5.5" scope="full" carried="7" total="7">'));

// Priority: latest ask, latest reply, first ask, then newest back, skipping any that do not fit.
const pad = (n) => 'w'.repeat(n * 4);
const long = [
  { id: 'u1', kind: 'user', text: `goal ${pad(100)}` },
  { id: 'a1', kind: 'assistant', text: pad(3000) },
  { id: 't1', kind: 'tool', name: 'Bash', input: { command: 'ls' }, output: 'small', state: 'output-available' },
  { id: 'u2', kind: 'user', text: pad(100) },
  { id: 't2', kind: 'tool', name: 'Bash', input: { command: 'make' }, output: pad(900), state: 'output-available' },
  { id: 'a2', kind: 'assistant', text: pad(100) },
  { id: 't3', kind: 'tool', name: 'Bash', input: { command: 'pwd' }, output: 'tiny', state: 'output-available' },
];
const sized = entriesOf(long);
const cost = (id) => sized.find((e) => e.id === id).tokens;
// Room for u2, a2, u1, t3 and t2 but not a1, and t1 behind it never gets a look in.
const cap = cost('u2') + cost('a2') + cost('u1') + cost('t3') + cost('t2') + 10;
const tight = buildHandoff({ items: long, from: 'codex', to: 'claude', window: 1000000, cap });
assert.deepEqual(tight.entries.map((e) => e.id), ['u1', 'u2', 't2', 'a2', 't3']);
assert.deepEqual(tight.omittedIds, ['a1', 't1'], 'a1 does not fit and t1 has no room left after it');
assert.ok(tight.text.includes('Left out to fit your context window (2 of 7 items): a1 … t1 (2 items).'), 'an unbroken run is named by its ends');
for (const e of tight.entries) assert.ok(tight.text.includes(e.text), `entry ${e.id} goes whole`);
assert.ok(!tight.text.includes(pad(3000)), 'an item that does not fit is left out whole, not cut');

// One that does not fit is skipped and older, smaller ones still go.
const skip = buildHandoff({ items: long, from: 'codex', to: 'claude', window: 1000000, cap: cap - cost('t2') + cost('t1') });
assert.deepEqual(skip.entries.map((e) => e.id), ['u1', 't1', 'u2', 'a2', 't3'], 't2 is too big now, and t1 behind it still goes');
assert.deepEqual(skip.omittedIds, ['a1', 't2']);
assert.ok(skip.text.includes(': a1, t2.'), 'skipped items are named in the header');

// The first ask and the latest reply beat the middle even when the middle is newer.
const firstAndLast = buildHandoff({ items: long, from: 'codex', to: 'claude', window: 1000000, cap: cost('u2') + cost('a2') + cost('u1') + 5 });
assert.deepEqual(firstAndLast.entries.map((e) => e.id), ['u1', 'u2', 'a2']);
assert.ok(firstAndLast.text.includes(': a1 … t1 (2 items), t2, t3.'), 'separate runs are listed apart');

// Nothing fits: the header still says what is missing.
const none = buildHandoff({ items: long, from: 'codex', to: 'claude', window: 40000, used: 30000 });
assert.equal(none.carried, 0);
assert.equal(none.omittedIds.length, 7);

// Delta: an agent switched back to is handed only what came after it left.
const delta = buildHandoff({ items, since: 9, from: 'codex', to: 'claude', window: 200000 });
assert.deepEqual(delta.entries.map((e) => e.id), ['u2', 'a2']);
assert.equal(delta.scope, 'since');
assert.ok(delta.text.includes('You worked in this chat earlier.'));
assert.ok(delta.text.includes('scope="since"'));

// The wire: what the agent gets, and what a transcript reader gives back.
const wire = wrapMessage(whole.text, 'And the signup page?');
assert.ok(wire.endsWith('</conn-handoff>\n\nUser message:\nAnd the signup page?'));
const back = unwrapHandoff(wire);
assert.equal(back.handoff, true);
assert.equal(back.text, 'And the signup page?');
assert.deepEqual([back.from, back.to, back.model, back.scope, back.carried, back.total], ['Claude', 'ChatGPT', 'gpt-5.5', 'full', 7, 7]);
assert.deepEqual(unwrapHandoff('plain words'), { handoff: false, text: 'plain words' });
assert.equal(unwrapHandoff('<conn-handoff from="x">cut short').handoff, false, 'a handoff with no end is not unwrapped');
assert.equal(typedText('<conn-handoff from="x">cut short'), '', 'and a title gets nothing out of it');
assert.equal(chatTitle(wire), 'And the signup page?', 'a chat title is what was typed');
assert.equal(tokens('abcd'), 1);
assert.equal(tokens('abcde'), 2);

// An attribute value cannot break out of the opening tag.
const odd = buildHandoff({ items, from: 'claude', to: 'codex', model: 'm"><x', window: 200000 });
assert.equal(unwrapHandoff(wrapMessage(odd.text, 'hi')).model, 'm   x');

console.log('handover-check: ok');
