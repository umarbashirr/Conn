/* How the transcript's flat items read, under plain node. A decided permission
   is drawn as a mark on the row of the call it let through, and only that one:
   an answered question, a pending card and a perm whose row lives somewhere
   else stay lines of their own. A turn's footer lists the files it changed,
   counted from the edits that went through. */
import assert from 'node:assert/strict';
import './renderer-esm.mjs';

const { attachPerms, hunksOf, turnEdits } = await import('../src/renderer/ui/lib/turns.js');

const call = (id, name) => ({ id, kind: 'tool', name, input: {}, state: 'output-available' });
const perm = (id, tool, extra) => ({ id, kind: 'perm', tool, input: {}, agent: null, ...extra });
const bridge = (id, tool, extra) => perm(id, tool, { agent: { id: 'bridge', label: 'preview' }, ...extra });
const user = (id) => ({ id, kind: 'user', text: 'go' });
const note = (id) => ({ id, kind: 'note', text: 'done in 1.0s' });
const ids = (list) => list.map((it) => it.id);
const pairs = ({ marks }) => Object.fromEntries([...marks].map(([row, p]) => [row, p.id]));

const WAIT = 'mcp__preview__browser_wait';

{
  const items = [user('u1'), call('tb1', 'Bash'), perm('p1', 'Bash', { forId: 'tb1', decided: 'allow' }), note('n1')];
  const got = attachPerms(items);
  assert.deepEqual(pairs(got), { tb1: 'p1' }, 'a decided perm marks the row its forId names');
  assert.deepEqual(ids(got.rest), ['u1', 'tb1', 'n1'], 'and is no longer a line of its own');
}

{
  const items = [
    call('tr1', 'Read'),
    perm('p2', 'Read', { forId: 'inner', decided: 'deny', agent: { id: 'task1', label: 'helper', toolUseId: 'ta1' } }),
  ];
  const got = attachPerms(items);
  assert.deepEqual(pairs(got), {}, 'a perm whose forId row is not in the list marks nothing, not even a call of the same tool');
  assert.deepEqual(ids(got.rest), ['tr1', 'p2'], 'it stays a line');
}

{
  const items = [
    call('tq1', 'AskUserQuestion'),
    perm('p3', 'AskUserQuestion', { forId: 'tq1', decided: 'allow', answers: { 'Which database?': 'Postgres' } }),
  ];
  const got = attachPerms(items);
  assert.deepEqual(pairs(got), {}, 'an answered question marks no row');
  assert.deepEqual(ids(got.rest), ['tq1', 'p3'], 'it keeps its Q/A line');
}

{
  const items = [call('tb1', 'Bash'), perm('p4', 'Bash', { forId: 'tb1' }), call('tw1', WAIT), bridge('b1', 'browser_waitFor')];
  const got = attachPerms(items);
  assert.deepEqual(pairs(got), {}, 'a pending perm marks no row, by forId or by name');
  assert.deepEqual(ids(got.rest), ids(items), 'pending cards stay where they are');
}

{
  const items = [
    call('tb1', 'Bash'),
    perm('p5', 'Bash', { forId: 'tb1', decided: 'allow' }),
    perm('p6', 'Bash', { forId: 'tb1', decided: 'deny' }),
  ];
  const got = attachPerms(items);
  assert.deepEqual(pairs(got), { tb1: 'p5' }, 'one perm per row: the first to name it');
  assert.deepEqual(ids(got.rest), ['tb1', 'p6'], 'the second stays a line');
}

{
  const items = [call('tw1', WAIT), bridge('b1', 'browser_waitFor', { decided: 'always' }), call('tw2', WAIT)];
  assert.deepEqual(pairs(attachPerms(items)), { tw1: 'b1' },
    'a bridge perm pairs with the call announced before it asked, not the next one that Always let through');
}

{
  const items = [call('tw0', WAIT), bridge('b1', 'browser_waitFor', { decided: 'allow' }), call('tb1', 'Bash'), call('tw1', WAIT)];
  assert.deepEqual(pairs(attachPerms(items)), { tw0: 'b1' },
    'the nearest call of its tool before a bridge perm wins over one after it');
}

{
  const items = [bridge('b1', 'browser_waitFor', { decided: 'allow' }), call('tb1', 'Bash'), call('tw1', WAIT)];
  assert.deepEqual(pairs(attachPerms(items)), { tw1: 'b1' },
    'with nothing behind it, a bridge perm pairs forward');
}

{
  const items = [call('tw0', WAIT), call('tw1', WAIT), call('tb1', 'Bash'), bridge('b1', 'browser_waitFor', { decided: 'always' })];
  assert.deepEqual(pairs(attachPerms(items)), { tw1: 'b1' },
    'a bridge perm pairs back with the nearest call of its tool, past calls of other tools');
}

{
  const items = [call('tw0', WAIT), call('tw1', WAIT), perm('p7', WAIT, { forId: 'tw1', decided: 'allow' }), bridge('b1', 'browser_waitFor', { decided: 'deny' })];
  assert.deepEqual(pairs(attachPerms(items)), { tw1: 'p7', tw0: 'b1' }, 'a bridge perm skips a row already marked');
}

{
  for (const name of ['mcp__preview__browser_wait', 'mcp__conn__browser_wait', 'browser_wait']) {
    const items = [call('tw1', name), bridge('b1', 'browser_waitFor', { decided: 'allow' })];
    assert.deepEqual(pairs(attachPerms(items)), { tw1: 'b1' }, `the bridge's browser_waitFor pairs with ${name}`);
  }
  const items = [call('tc1', 'mcp__preview__browser_click'), bridge('b1', 'browser_waitFor', { decided: 'allow' })];
  assert.deepEqual(pairs(attachPerms(items)), {}, 'a bridge perm does not pair with a call of another tool');
}

{
  const asked = [
    bridge('b1', 'browser_waitFor', { decided: 'allow' }), call('tw1', WAIT),
    bridge('b2', 'browser_waitFor', { decided: 'deny' }), call('tw2', WAIT),
  ];
  assert.deepEqual(pairs(attachPerms(asked)), { tw1: 'b1', tw2: 'b2' }, 'two bridge perms each ahead of their call pair in order');
  const together = [
    bridge('b1', 'browser_waitFor', { decided: 'allow' }), bridge('b2', 'browser_waitFor', { decided: 'deny' }),
    call('tw1', WAIT), call('tw2', WAIT),
  ];
  assert.deepEqual(pairs(attachPerms(together)), { tw1: 'b1', tw2: 'b2' }, 'two bridge perms asked before both calls pair in order');
}

{
  const items = [call('tb1', 'Bash'), bridge('b1', 'browser_click', { decided: 'allow' })];
  const got = attachPerms(items);
  assert.deepEqual(pairs(got), {}, 'a decided bridge perm with no call of its tool marks nothing');
  assert.deepEqual(ids(got.rest), ['tb1', 'b1'], 'it stays a line');
}

{
  const items = [
    user('u1'), bridge('b1', 'browser_waitFor', { decided: 'allow' }), call('tw1', WAIT),
    call('tb1', 'Bash'), perm('p1', 'Bash', { forId: 'tb1', decided: 'always' }),
    call('tq1', 'AskUserQuestion'), perm('p2', 'AskUserQuestion', { forId: 'tq1', decided: 'allow', answers: { q: 'a' } }),
    perm('p3', 'Read', { forId: 'elsewhere', decided: 'deny' }), note('n1'),
  ];
  const got = attachPerms(items);
  assert.deepEqual(pairs(got), { tw1: 'b1', tb1: 'p1' }, 'a mixed turn marks the two rows it can');
  assert.deepEqual(ids(got.rest), ['u1', 'tw1', 'tb1', 'tq1', 'p2', 'p3', 'n1'], 'rest keeps the order it was given');
}

{
  const items = [user('u1'), call('tb1', 'Bash'), call('tw1', WAIT), { id: 'a1', kind: 'assistant', text: 'ok' }, note('n1')];
  const got = attachPerms(items);
  assert.equal(got.marks.size, 0, 'a list with no perms marks nothing');
  assert.deepEqual(ids(got.rest), ids(items), 'and comes back the same length in the same order');
}

const edit = (id, file_path, old_string, new_string, extra) => ({ id, kind: 'tool', name: 'Edit', input: { file_path, old_string, new_string }, state: 'output-available', ...extra });
const write = (id, file_path, content, extra) => ({ id, kind: 'tool', name: 'Write', input: { file_path, content }, state: 'output-available', ...extra });
const codex = (id, files, extra) => ({ id, kind: 'tool', name: 'Edit', input: { files }, state: 'output-available', ...extra });
const counts = (turn) => turn.files.map((f) => `${f.path} +${f.added} -${f.removed}`);

{
  const items = [
    user('u1'),
    edit('e1', '/a.js', 'one', 'uno'),
    edit('e2', '/a.js', 'two\nthree', 'dos'),
    note('n1'),
  ];
  const got = turnEdits(items);
  assert.equal(got.length, 1, 'one user item is one turn');
  assert.deepEqual([got[0].userId, got[0].end], ['u1', 'n1'], 'the turn runs from its user item to its last item');
  assert.deepEqual(counts(got[0]), ['/a.js +2 -3'], 'two edits to one file sum into one entry');
  assert.deepEqual(got[0].files[0].calls, ['e1', 'e2'], 'and name both calls');
}

{
  const got = turnEdits([user('u1'), write('w1', '/new.txt', 'a\nb\nc\n')]);
  assert.deepEqual(counts(got[0]), ['/new.txt +3 -0'], 'a Write counts its whole content as added');
}

{
  const got = turnEdits([user('u1'), { id: 'a1', kind: 'assistant', text: 'hi' }, call('tb1', 'Bash'), note('n1'), user('u2'), edit('e1', '/b.js', 'x', 'y')]);
  assert.deepEqual(got.map((t) => [t.userId, t.end, t.files.length]), [['u1', 'n1', 0], ['u2', 'e1', 1]], 'a turn with no edits has no files, and the next one starts at its user item');
}

{
  const items = [
    user('u1'),
    edit('ok', '/a.js', 'x', 'y'),
    edit('bad', '/b.js', 'x', 'y', { state: 'output-error' }),
    edit('run', '/c.js', 'x', 'y', { state: 'input-available' }),
    edit('denied', '/d.js', 'x', 'y', { state: 'output-denied' }),
  ];
  assert.deepEqual(counts(turnEdits(items)[0]), ['/a.js +1 -1'], 'only an edit that went through is listed');
}

{
  const files = [
    { path: '/x.js', kind: 'update', hunks: [{ before: 'a', after: 'b\nc' }] },
    { path: '/y.js', kind: 'add', hunks: [{ before: '', after: 'new' }] },
  ];
  const items = [user('u1'), codex('c1', files), edit('e1', '/x.js', 'p', 'q')];
  assert.deepEqual(counts(turnEdits(items)[0]), ['/x.js +3 -2', '/y.js +1 -0'], 'a files edit gives one entry per file, in first-seen order, and sums with a later edit');
  assert.deepEqual(turnEdits(items)[0].files.map((f) => f.calls), [['c1', 'e1'], ['c1']], 'each file names the calls that touched it');
}

{
  const items = [
    user('u1'),
    { id: 'ag1', kind: 'agent', children: [edit('e1', '/sub.js', 'x', 'y')] },
    edit('e2', '/sub.js', 'p', 'q', { parent: 'ag1' }),
    note('n1'),
  ];
  assert.deepEqual(counts(turnEdits(items)[0]), ['/sub.js +2 -2'], "a subagent's edits count, nested under its row or flat with a parent");
}

{
  const got = turnEdits([edit('e0', '/early.js', 'x', 'y'), { id: 'n0', kind: 'note', text: 'opening' }, user('u1'), edit('e1', '/a.js', 'x', 'y')]);
  assert.equal(got.length, 1, 'items before the first user item belong to no turn');
  assert.deepEqual(counts(got[0]), ['/a.js +1 -1'], 'and are not counted in the next one');
}

{
  const files = [
    { path: '/x.js', hunks: [{ before: 'a', after: 'b' }] },
    { path: '/y.js', hunks: [{ before: '', after: 'new' }] },
  ];
  const items = [
    user('u1'),
    codex('c1', files),
    { id: 'ag1', kind: 'agent', children: [edit('e1', '/x.js', 'p', 'q')] },
    edit('e2', '/x.js', 'r', 's'),
  ];
  assert.deepEqual(hunksOf(items, ['c1', 'e1'], '/x.js'), [{ before: 'a', after: 'b' }, { before: 'p', after: 'q' }], 'the hunks of the named calls to one path, a subagent row included and other calls and files left out');
}

{
  const moved = [{ path: '/src/a.js', kind: 'update', movePath: '/lib/a.js', hunks: [{ before: 'x', after: 'y' }] }];
  const items = [user('u1'), codex('c1', moved)];
  const [turn] = turnEdits(items);
  assert.deepEqual(turn.files.map((f) => f.path), ['/lib/a.js'], 'a moved file is listed where it lives now');
  assert.deepEqual(hunksOf(items, ['c1'], '/lib/a.js'), [{ before: 'x', after: 'y' }], 'and its diff is found under that path');
}

console.log('turns-check: all passed');
