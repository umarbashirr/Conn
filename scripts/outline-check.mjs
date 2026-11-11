import assert from 'node:assert/strict';
import './renderer-esm.mjs';

const { chatOutline, firstWords, OUTLINE_MIN_TURNS, summaryOf, toneOf } = await import('../src/renderer/ui/lib/outline.js');

const user = (id, text = 'go', extra) => ({ id, kind: 'user', text, ...extra });
const says = (id, text) => ({ id, kind: 'assistant', text });
const bash = (id, command, extra) => ({ id, kind: 'tool', name: 'Bash', input: { command }, state: 'output-available', output: 'ok', ...extra });
const write = (id, file) => ({ id, kind: 'tool', name: 'Write', input: { file_path: file, content: 'x' }, state: 'output-available', output: 'ok' });

assert.equal(OUTLINE_MIN_TURNS, 4, 'the outline waits for four turns before it is worth showing');
assert.deepEqual(chatOutline([]), [], 'an empty chat has no turns');

{
  const items = [
    says('a0', 'hello before anything was asked'),
    user('u1', '\n  run the app with .env.production\nI already started twingate'),
    write('w1', '/p/a.ts'), write('w2', '/p/b.ts'), write('w3', '/p/a.ts'),
    user('u2', 'now test it'),
    bash('b1', 'npm test', { state: 'output-error', output: 'failed' }),
    bash('b2', 'npm run lint', { state: 'output-error', output: 'interrupted' }),
    user('u3', 'ship it'),
    { id: 'p1', kind: 'perm', tool: 'Bash', decided: 'allow' },
    bash('b3', 'gh pr create --title "x"', { output: 'https://github.com/o/r/pull/9' }),
    user('u4', '', { images: [{}, {}] }),
    { id: 'p2', kind: 'perm', tool: 'Edit' },
  ];
  const turns = chatOutline(items);
  assert.deepEqual(turns.map((t) => t.id), ['u1', 'u2', 'u3', 'u4'], 'one entry per message you sent, in order; text before the first is no turn');
  assert.equal(turns[0].text, 'run the app with .env.production', 'a turn is named by the first line it has');
  assert.equal(turns[0].files, 2, 'files are counted once each, however often they were touched');
  assert.equal(turns[1].errors, 1, 'a failed call counts; a stopped one does not');
  assert.deepEqual([turns[2].asks, turns[2].waiting, turns[2].prs], [1, false, 1], 'an answered permission and an opened PR');
  assert.deepEqual([turns[3].text, turns[3].waiting], ['2 images', true], 'an image-only message is named for its images, and an open card waits on you');
  assert.deepEqual(turns.map(toneOf), ['edit', 'error', 'edit', 'waiting'], 'waiting beats error beats edits');
  assert.equal(summaryOf(turns[0]), '2 files edited');
  assert.equal(summaryOf(turns[2]), '1 PR opened · 1 permission asked');
  assert.equal(summaryOf(turns[3]), 'waiting on you');
}

{
  const items = [
    user('u1', 'audit'),
    { id: 'ag', kind: 'agent', children: [bash('c1', 'false', { state: 'output-error', output: 'exit 1' }), { id: 'cp', kind: 'perm' }] },
    user('sub', 'a subagent prompt', { parent: 'ag' }),
  ];
  const [turn, ...rest] = chatOutline(items);
  assert.equal(rest.length, 0, "a subagent's own prompt is not one of your turns");
  assert.deepEqual([turn.errors, turn.waiting], [1, true], "a subagent's failures and cards count toward the turn it ran in");
}

assert.equal(firstWords('x'.repeat(200)).length, 90, 'a long first line is cut to fit');
assert.equal(firstWords('   '), 'Empty message');
console.log('outline-check: all assertions passed');
