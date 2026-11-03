import assert from 'node:assert/strict';
import './renderer-esm.mjs';

const { runs, FOLD_AT_CALLS, runSpan, callSpan, SHOW_AFTER_MS } = await import('../src/renderer/ui/lib/runs.js');

const tool = (id, name = 'Read') => ({ id, kind: 'tool', name, input: { file_path: `/${id}` }, state: 'output-available' });
const edit = (id) => ({ id, kind: 'tool', name: 'Edit', input: { file_path: '/a.js', old_string: 'x', new_string: 'y' }, state: 'output-available' });
const thought = (id, extra) => ({ id, kind: 'reasoning', parent: null, text: 'hm', ...extra });
const reply = (id) => ({ id, kind: 'assistant', text: 'ok' });
const shape = (groups) => groups.map((g) => (g.run ? { run: g.run.map((it) => it.id), calls: g.calls } : g.item.id));

assert.equal(FOLD_AT_CALLS, 3, 'three calls is where a run folds');

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

assert.deepEqual(shape(runs([tool('t1'), { id: 'p1', kind: 'tool', name: 'ExitPlanMode', input: { plan: '# Plan' } }, tool('t2')])),
  [{ run: ['t1'], calls: 1 }, 'p1', { run: ['t2'], calls: 1 }],
  'a proposed plan breaks a run and keeps its row');

assert.deepEqual(shape(runs([tool('t1'), { id: 'plan:u1', kind: 'plan', entries: [] }, tool('t2')])),
  [{ run: ['t1'], calls: 1 }, 'plan:u1', { run: ['t2'], calls: 1 }],
  'a checklist breaks a run too');

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

{
  const t = (at, end, extra) => ({ ...tool('x'), at, end, ...extra });
  assert.equal(SHOW_AFTER_MS, 2000, 'a duration shows from two seconds');
  assert.equal(callSpan(t(1000, 4500)), 3500, 'a call spans its start to its end');
  assert.equal(callSpan(t(1000, 2500)), null, 'under two seconds shows nothing');
  assert.equal(callSpan(t(1000, 3000)), 2000, 'exactly two seconds shows');
  assert.equal(callSpan(tool('r')), null, 'a replayed call has no times and so no duration');
  assert.equal(callSpan(t(1000, undefined)), null, 'a call with no end has no duration');
  assert.equal(callSpan(t(5000, 1000)), null, 'an end before the start is not a duration');
  assert.equal(runSpan([t(1000, 2000), t(2000, 3000), t(3000, 6000)]), 5000, 'a run spans its first start to its last end');
  assert.equal(runSpan([t(1000, 1500), t(1500, 2000)]), null, 'a run under two seconds shows nothing');
  assert.equal(runSpan([tool('a'), tool('b')]), null, 'a replayed run has no total');
  assert.equal(runSpan([t(1000, 2000), tool('b'), t(3000, 9000)]), 8000, 'a call without times does not hide the rest');
  assert.equal(runSpan([t(1000, 9000), t(2000, 3000)]), 8000, 'the latest end counts, not the last in order');
}

console.log('runs-check: all passed');
