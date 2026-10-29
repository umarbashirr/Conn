/* A thought's close and its folded label, under plain node. Settling stamps
   how long the row streamed, once; every later close (a late stop, a result
   after Stop, an error) leaves it as it was. A replayed row has no clock and
   says so rather than inventing one. */
import assert from 'node:assert/strict';
import './renderer-esm.mjs';

const { settle, thoughtLabel } = await import('../src/renderer/ui/lib/reasoning.js');

const live = { id: 'r1', kind: 'reasoning', parent: null, text: 'Reading the file', streaming: true, at: 1000 };

{
  const done = settle(live, 5200);
  assert.equal(done.streaming, false, 'a settled thought stops streaming');
  assert.equal(done.ms, 4200, 'and keeps how long it ran, from block start');
  assert.equal(done.text, live.text, 'its text is untouched');
  assert.equal(live.streaming, true, 'the row it was given is not mutated');
  assert.equal(thoughtLabel(done), 'Thought for 4s');

  const again = settle(done, 90000);
  assert.equal(again, done, 'settling twice changes nothing');
  assert.equal(again.ms, 4200, 'a late close does not re-time the row');
}

{
  const assistant = { id: 'a1', kind: 'assistant', text: 'hi', streaming: true };
  const call = { id: 't1', kind: 'tool', name: 'Read', state: 'input-available', at: 1000 };
  const replayed = { id: 'h3', kind: 'reasoning', text: 'old' };
  assert.equal(settle(assistant, 5000), assistant, 'a streaming reply is left alone');
  assert.equal(settle(call, 5000), call, 'a running call is left alone');
  assert.equal(settle(replayed, 5000), replayed, 'a replayed thought gains no clock');
}

assert.equal(thoughtLabel({ kind: 'reasoning', ms: 400 }), 'Thought for 1s', 'under a second rounds up, never 0s');
assert.equal(thoughtLabel({ kind: 'reasoning', ms: 0 }), 'Thought for 1s', 'an instant thought still reads 1s');
assert.equal(thoughtLabel({ kind: 'reasoning', ms: 4200 }), 'Thought for 4s');
assert.equal(thoughtLabel({ kind: 'reasoning', ms: 59400 }), 'Thought for 59s');
assert.equal(thoughtLabel({ kind: 'reasoning', ms: 65000 }), 'Thought for 1m 5s');
assert.equal(thoughtLabel({ kind: 'reasoning', ms: 119600 }), 'Thought for 2m 0s', 'seconds that round to 60 carry into minutes');
assert.equal(thoughtLabel({ kind: 'reasoning', text: 'old' }), 'Thought', 'no ms means no number');

console.log('reasoning-check: all passed');
