/* How a transcript's rows group into runs, under plain node. Tool calls that
   carry no diff run together and fold once there are FOLD_AT calls. A thought
   between two calls joins their run instead of breaking it, so summarized
   Claude thinking still folds; a thought before the first call or after the
   last stays a row of its own, and the row kept out of a strip is a call. */
import assert from 'node:assert/strict';
import './renderer-esm.mjs';

const { runs, FOLD_AT } = await import('../src/renderer/ui/lib/runs.js');

const tool = (id, name = 'Read') => ({ id, kind: 'tool', name, input: { file_path: `/${id}` }, state: 'output-available' });
const edit = (id) => ({ id, kind: 'tool', name: 'Edit', input: { file_path: '/a.js', old_string: 'x', new_string: 'y' }, state: 'output-available' });
const thought = (id, extra) => ({ id, kind: 'reasoning', parent: null, text: 'hm', ...extra });
const reply = (id) => ({ id, kind: 'assistant', text: 'ok' });
const shape = (groups) => groups.map((g) => (g.run ? { run: g.run.map((it) => it.id), calls: g.calls } : g.item.id));

assert.equal(FOLD_AT, 3, 'three calls is where a run folds');

assert.deepEqual(shape(runs([tool('t1'), tool('t2'), tool('t3')])), [{ run: ['t1', 't2', 't3'], calls: 3 }],
  'tool calls alone group as before');

assert.deepEqual(shape(runs([tool('t1'), thought('r1'), tool('t2'), thought('r2'), tool('t3')])),
  [{ run: ['t1', 'r1', 't2', 'r2', 't3'], calls: 3 }],
  'thoughts between calls join the run, and calls count only the tools, so it folds');

assert.deepEqual(shape(runs([tool('t1'), thought('r1'), tool('t2')])), [{ run: ['t1', 'r1', 't2'], calls: 2 }],
  'two calls with a thought between them are one run of 2 calls, which does not fold');

assert.deepEqual(shape(runs([thought('r1'), reply('a1')])), ['r1', 'a1'], 'a thought before a reply is a row of its own');

assert.deepEqual(shape(runs([tool('t1'), edit('e1'), tool('t2')])),
  [{ run: ['t1'], calls: 1 }, 'e1', { run: ['t2'], calls: 1 }],
  'an edit with a diff still breaks a run');

assert.deepEqual(shape(runs([tool('t1'), thought('r1'), edit('e1')])),
  [{ run: ['t1'], calls: 1 }, 'r1', 'e1'],
  'a thought followed by a diff edit stays out of the run before it');

assert.deepEqual(shape(runs([tool('t1'), thought('r1'), tool('t2'), thought('r2', { streaming: true, at: 1 })])),
  [{ run: ['t1', 'r1', 't2'], calls: 2 }, 'r2'],
  'a trailing thought, live or not, stays a row after the run');

assert.deepEqual(shape(runs([thought('r0'), tool('t1'), thought('r1'), tool('t2'), thought('r2'), tool('t3')])),
  ['r0', { run: ['t1', 'r1', 't2', 'r2', 't3'], calls: 3 }],
  'a leading thought stays a row before the run');

assert.deepEqual(shape(runs([tool('t1'), thought('r1'), thought('r2'), tool('t2')])),
  [{ run: ['t1', 'r1', 'r2', 't2'], calls: 2 }],
  'two thoughts in a row between calls both join');

assert.deepEqual(shape(runs([tool('t1'), tool('t2'), thought('r1'), reply('a1'), tool('t3')])),
  [{ run: ['t1', 't2'], calls: 2 }, 'r1', 'a1', { run: ['t3'], calls: 1 }],
  'a thought before a reply leaves the run it followed');

{
  const items = [thought('r0'), tool('t1'), thought('r1'), tool('t2'), thought('r2'), tool('t3'), thought('r3'), reply('a1'),
    thought('r4'), tool('t4'), thought('r5', { streaming: true, at: 1 })];
  const got = runs(items);
  for (const g of got.filter((x) => x.run)) {
    assert.equal(g.run.at(-1).kind, 'tool', `run ${g.id} ends on a call, so the row kept out of a strip is never a thought`);
    assert.equal(g.run[0].kind, 'tool', `run ${g.id} starts on a call`);
    assert.equal(g.id, g.run[0].id, 'a run is keyed by its first row');
  }
  assert.deepEqual(got.flatMap((g) => (g.run ? g.run : [g.item])).map((it) => it.id), items.map((it) => it.id),
    'every row lands once, in order');
}

console.log('runs-check: all passed');
