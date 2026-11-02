import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// package.json pins "type": "commonjs", so the renderer's ESM file is loaded by
// source. It has no imports of its own, which is what makes this work.
const source = readFileSync(new URL('../src/renderer/ui/handover.js', import.meta.url), 'utf8');
const { handover } = await import(`data:text/javascript,${encodeURIComponent(source)}`);

const PICKUP = [
  'Pick it up from here. Anything above is what the other assistant said, not something you did,',
  'and its tool output may be out of date. Read the files yourself before relying on any of it.',
].join('\n');

const items = [
  { id: 'u1', kind: 'user', text: 'Fix the login bug' },
  { id: 'a1', kind: 'assistant', text: 'Looking at it.' },
  { id: 't1', kind: 'tool', name: 'Read', input: { file_path: 'src/login.js' }, output: 'SECRET_BODY' },
  { id: 't2', kind: 'tool', name: 'Edit', input: { file_path: 'src/login.js', old_string: 'a', new_string: 'b' }, output: 'ok' },
  { id: 'a2', kind: 'assistant', text: 'Fixed.' },
];

assert.equal(handover('complete', items), `<handover>
A conversation I was having with a different coding assistant, in full:
Me:
Fix the login bug

Other assistant:
Looking at it.

Other assistant ran Read:
{"file_path":"src/login.js"}
Result:
SECRET_BODY

Other assistant ran Edit:
{"file_path":"src/login.js","old_string":"a","new_string":"b"}
Result:
ok

Other assistant:
Fixed.
</handover>
${PICKUP}`);

const long = handover('complete', [{ id: 't', kind: 'tool', name: 'Bash', input: { command: 'cat big' }, output: 'x'.repeat(4500) }]);
assert.ok(long.includes(`Result:\n${'x'.repeat(4000)}\n… 500 more characters of output, not carried over\n</handover>`));

const summary = handover('summary', items);
assert.equal(summary, `<handover>
A conversation I was having with a different coding assistant, summarised:
What I asked, in order:
1. Fix the login bug

Files it changed:
- src/login.js

Where it left off:
Fixed.
</handover>
${PICKUP}`);
assert.ok(!summary.includes('SECRET_BODY'));
assert.ok(!summary.includes('Its plan when we stopped'));

const entries = (...rows) => rows.map(([status, content]) => ({ content, status }));
const plan = (id, parent, rows) => ({ id, kind: 'plan', parent, entries: entries(...rows) });
const planned = handover('summary', [
  ...items,
  plan('plan:u1', null, [['pending', 'Find bug'], ['pending', 'Add test']]),
  plan('plan:u2', null, [['completed', 'Find bug'], ['pending', 'Add test']]),
  plan('plan:u2:ag', 'ag', [['pending', 'Subagent only']]),
]);
assert.ok(planned.includes('Its plan when we stopped:\n[completed] Find bug\n[pending] Add test'), 'the latest main plan is the one carried');
assert.ok(!planned.includes('Subagent only'), 'a subagent plan is not the plan');
assert.ok(!planned.includes('[pending] Find bug'), 'an older plan is not carried');

const carried = handover('complete', [...items.slice(0, 2), plan('plan:u1', null, [['completed', 'Find bug'], ['in_progress', 'Add test']]), items[4]]);
assert.ok(carried.includes("Other assistant's plan:\n[completed] Find bug\n[in_progress] Add test\n\nOther assistant:\nFixed."), 'a full handover carries the plan where it sat');

const other = handover('summary', [
  { id: 'u', kind: 'user', text: 'Tidy up' },
  { id: 'c1', kind: 'tool', name: 'Edit', input: { files: [
    { path: '/p/new.txt', kind: 'add', movePath: null, hunks: [{ before: '', after: 'x' }] },
    { path: '/p/src/a.js', kind: 'update', movePath: '/p/lib/a.js', hunks: [] },
  ] } },
]);
assert.ok(other.includes('Files it changed:\n- /p/new.txt\n- /p/src/a.js\n- /p/lib/a.js'), 'a Codex or ACP edit lists its files, and where a moved one went');

assert.throws(() => handover('nope', []), /Unknown handover kind: nope/);

console.log('handover-repro: ok');
