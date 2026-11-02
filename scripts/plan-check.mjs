import assert from 'node:assert/strict';
import './renderer-esm.mjs';

const { planOf, withPlan, planDone } = await import('../src/renderer/ui/lib/plan.js');

const todo = (content, status = 'pending', extra = {}) => ({ content, status, ...extra });
const three = [todo('Read'), todo('Patch'), todo('Test')];
const ticked = [todo('Read', 'completed'), todo('Patch', 'in_progress', { activeForm: 'Patching' }), todo('Test')];
const user = (id) => ({ id, kind: 'user', text: 'go' });
const says = { id: 'a1', kind: 'assistant', text: 'ok' };
const plans = (items) => items.filter((it) => it.kind === 'plan');

{
  const plan = planOf({ todos: three, explanation: 'Start small' });
  assert.deepEqual(plan.entries, three, 'entries keep content and status');
  assert.equal(plan.explanation, 'Start small');
  assert.ok(!('explanation' in planOf({ todos: three })), 'no explanation key when the source has none');
  assert.ok(!('priority' in planOf({ todos: three }).entries[0]), 'no priority key when the source has none');
  assert.equal(planOf({ todos: [todo('A', 'pending', { priority: 'high' })] }).entries[0].priority, 'high');
}

{
  assert.equal(planOf({ todos: [] }), null, 'an empty list is not a plan');
  assert.equal(planOf({}), null, 'a missing list is not a plan');
  assert.equal(planOf(undefined), null);
  assert.equal(planOf({ todos: 'Read, Patch' }), null, 'a list that is not an array is not a plan');
  assert.equal(planOf({ todos: [{ status: 'pending' }, { content: 3 }] }), null, 'entries without text drop out, leaving nothing');
  assert.deepEqual(planOf({ todos: [todo('A'), { status: 'pending' }] }).entries, [todo('A')], 'an entry without text is dropped');
  assert.equal(planOf({ todos: [{ content: 'A', status: 'inProgress' }] }).entries[0].status, 'in_progress', 'inProgress is normalised');
  assert.equal(planOf({ todos: [{ content: 'A', status: 'weird' }] }).entries[0].status, 'pending', 'an unknown status reads as not started');
}

{
  const turn = [user('u1'), says];
  const first = withPlan(turn, { parent: null, entries: three });
  assert.deepEqual(first.map((it) => it.id), ['u1', 'a1', 'plan:u1'], 'the first update appends one item');
  assert.equal(first[2].kind, 'plan');

  const later = [...first, { id: 'a2', kind: 'assistant', text: 'more' }];
  const second = withPlan(later, { parent: null, entries: ticked });
  assert.equal(plans(second).length, 1, 'a second update in the same turn replaces, not adds');
  assert.deepEqual(second.map((it) => it.id), ['u1', 'a1', 'plan:u1', 'a2'], 'and keeps its position');
  assert.deepEqual(second[2].entries, ticked, 'and holds the latest entries');
}

{
  const items = withPlan([user('u1'), says], { parent: null, entries: three });
  const next = withPlan([...items, user('u2')], { parent: null, entries: ticked });
  assert.deepEqual(plans(next).map((it) => it.id), ['plan:u1', 'plan:u2'], 'a new turn gets its own plan');
  assert.deepEqual(plans(next)[0].entries, three, 'and leaves the old one as it was');
}

{
  assert.equal(withPlan([], { parent: null, entries: three })[0].id, 'plan:start', 'no user message yet files under start');
  const sub = [user('u1'), { id: 'ag', kind: 'agent' }, { id: 'u9', kind: 'user', parent: 'ag', text: 'prompt' }];
  assert.equal(withPlan(sub, { parent: null, entries: three }).at(-1).id, 'plan:u1', 'a subagent message does not start a turn');
}

{
  const main = withPlan([user('u1'), { id: 'ag', kind: 'agent' }], { parent: null, entries: three });
  const both = withPlan(main, { parent: 'ag', entries: ticked });
  assert.deepEqual(plans(both).map((it) => [it.id, it.parent]), [['plan:u1', null], ['plan:u1:ag', 'ag']], 'a subagent plan is its own item');
  const again = withPlan(both, { parent: 'ag', entries: three });
  assert.equal(plans(again).length, 2, 'the subagent updates in place too');
  assert.deepEqual(plans(again)[0].entries, three, 'and leaves the main plan alone');
  assert.deepEqual(plans(again)[1].entries, three);
}

{
  const items = Object.freeze([user('u1'), Object.freeze({ id: 'plan:u1', kind: 'plan', parent: null, entries: three })]);
  const out = withPlan(items, { parent: null, entries: ticked });
  assert.notEqual(out, items, 'a new array comes back');
  assert.deepEqual(items[1].entries, three, 'the item it was given is untouched');
  assert.equal(items.length, 2);
}

assert.equal(planDone(ticked), 1, 'one entry is done');
assert.equal(planDone(three), 0);

console.log('plan-check: all passed');
