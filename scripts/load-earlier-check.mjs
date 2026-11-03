import assert from 'node:assert/strict';
import './renderer-esm.mjs';

const { storedOf, storedWindow, widerLimit, rewindow } = await import('../src/renderer/ui/lib/stored.js');

const msgs = (n) => Array.from({ length: n }, (_, i) => ({ type: i % 2 ? 'assistant' : 'user', i }));

assert.deepEqual(storedWindow({ total: 1000, messages: msgs(400) }), { from: 600, to: 1000 },
  'a chat opened off disk shows the last 400 of 1000, with 600 still on disk');

assert.deepEqual(storedWindow({ total: 1003, messages: msgs(800) }, 1000), { from: 200, to: 1000 },
  'a wider read ends where the first one did, even after a live turn wrote three more messages');

assert.deepEqual(storedWindow({ total: 120, messages: msgs(120) }), { from: 0, to: 120 },
  'a short chat has nothing left on disk');

assert.deepEqual(storedOf('s1', { from: 600, to: 1000 }, 7), { session: 's1', from: 600, to: 1000, count: 7 },
  'a chat with messages left on disk records where its replay came from');
assert.equal(storedOf('s1', { from: 0, to: 1000 }, 7), null, 'a chat read back to its first message has nothing left to load');

assert.equal(widerLimit({ from: 600, to: 1000 }), 800, 'loading earlier asks for twice what is on screen');
assert.equal(widerLimit({ from: 200, to: 1000 }), 1000, 'or for all of it when less than that is left');
assert.equal(widerLimit({ from: 1, to: 2 }), 2, 'one message left is still asked for');

const opened = { id: 'toolu_a', kind: 'agent', loaded: true };
const shown = [
  { id: 'plan:start', kind: 'plan' },
  { id: 'h600', kind: 'user', text: 'q300' },
  opened,
  { id: 'u1', kind: 'user', text: 'live question' },
  { id: 'toolu_a:0.0', kind: 'assistant', parent: 'toolu_a' },
];
const fresh = [
  { id: 'h0', kind: 'user', text: 'q0' },
  { id: 'toolu_cut', kind: 'tool', output: 'paired' },
  { id: 'h600', kind: 'user', text: 'q300' },
  { id: 'toolu_a', kind: 'agent', loaded: false },
];
const next = rewindow(shown, 3, fresh);

assert.deepEqual(next.map((it) => it.id), ['h0', 'toolu_cut', 'h600', 'toolu_a', 'u1', 'toolu_a:0.0'],
  'the wider replay takes the place of the old one, and the live turn and an agent\'s rows stay after it');
assert.equal(next[3], opened, 'a row already on screen keeps its object, so an opened agent stays opened');
assert.equal(next[2], shown[1], 'a message already on screen is the same object, so React keeps its row');
assert.ok(!next.some((it) => it.id === 'plan:start'), 'a row only the shorter window made is dropped');
assert.equal(next[1].output, 'paired', 'a call cut off from its result by the old window comes back paired');

console.log('load-earlier-check: all passed');
