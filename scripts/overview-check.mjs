import assert from 'node:assert/strict';
import './renderer-esm.mjs';

const { chatOverview, FILES_SHOWN, PRS_SHOWN } = await import('../src/renderer/ui/lib/overview.js');

const PROJECT = '/work/shop';
const facts = (extra) => ({ project: PROJECT, name: 'shop', branch: 'main', changes: 0, pane: null, folderless: false, ...extra });
const kinds = (sections) => sections.map((s) => s.kind);
const section = (sections, kind) => sections.find((s) => s.kind === kind);

const user = (id, text = 'go') => ({ id, kind: 'user', text });
const says = (id, text, extra) => ({ id, kind: 'assistant', text, ...extra });
const bash = (id, command, output, extra) => ({ id, kind: 'tool', name: 'Bash', input: { command }, state: 'output-available', output, ...extra });
const edit = (id, file, from, to, state = 'output-available') => ({
  id, kind: 'tool', name: 'Edit', input: { file_path: file, old_string: from, new_string: to }, state, output: 'ok',
});
const write = (id, file, content) => ({ id, kind: 'tool', name: 'Write', input: { file_path: file, content }, state: 'output-available', output: 'ok' });

assert.deepEqual(chatOverview([], facts({ changes: 4 })), [], 'an empty chat has no sections, whatever the folder says');

{
  const s = chatOverview([user('u1')], facts());
  assert.deepEqual(kinds(s), ['header', 'places'], 'a chat with nothing done yet has only the header and the places');
  assert.deepEqual(section(s, 'header'), { kind: 'header', name: 'shop', branch: 'main' }, 'the header names the folder and its branch');
  assert.deepEqual(section(s, 'places').places.map((p) => p.kind), ['changes', 'browser', 'terminal', 'files'],
    'the places are Changes, Browser, Terminal, Files in that order');
}

{
  const s = chatOverview([user('u1')], facts({ branch: null }));
  assert.deepEqual(section(s, 'header'), { kind: 'header', name: 'shop', branch: null }, 'a folder outside git has a header with no branch');
}

{
  const places = section(chatOverview([user('u1')], facts({ changes: 3, pane: 'terminal' })), 'places').places;
  assert.equal(places.find((p) => p.kind === 'changes').count, 3, 'Changes carries the uncommitted-file count');
  assert.deepEqual(places.filter((p) => p.open).map((p) => p.kind), ['terminal'], 'only the pane on screen is marked open');
}

{
  const s = chatOverview([user('u1')], facts({ project: null, name: 'No folder', branch: null, folderless: true }));
  assert.equal(section(s, 'header'), undefined, 'a chat with no folder has no header');
  assert.deepEqual(section(s, 'places').places.map((p) => p.kind), ['browser', 'terminal'],
    'a chat with no folder offers no Changes and no Files');
}

{
  const items = [
    user('u1'),
    bash('t1', 'gh pr create --title "feat(cart): rename the heading" --body x', 'https://github.com/o/r/pull/12\n'),
    says('a1', 'Opened https://github.com/o/r/pull/12. Also see https://github.com/o/r/pull/3 from the handoff.'),
    bash('t0', 'cat HANDOFF.md', 'PR https://github.com/o/r/pull/16 and https://github.com/o/r/pull/17'),
    user('u2'),
    bash('t2', 'gh pr create --base main --title "$title" --body "$body"', 'remote: ...\nhttps://github.com/O/R/pull/14\n'),
    says('a2', 'Then [PR #14: fix(cart): coupon rounding](https://github.com/o/r/pull/14).'),
    bash('t3', 'GH_TOKEN=x gh pr create --title fix --head ui/a', 'https://github.com/acme/api/pull/7\n'),
    bash('t4', 'gh pr list', 'https://github.com/o/r/pull/99\nhttps://github.com/o/r/pulls'),
  ];
  const s = section(chatOverview(items, facts()), 'prs');
  assert.deepEqual(s.prs.map((p) => `${p.repo}#${p.number}`), ['acme/api#7', 'O/R#14', 'o/r#12'],
    'only PRs this chat opened with gh pr create are listed, newest first; mentioned and listed PRs are not');
  assert.equal(s.prs.find((p) => p.number === 12).title, 'feat(cart): rename the heading', 'gh pr create names the PR it printed');
  assert.equal(s.prs.find((p) => p.number === 14).title, 'fix(cart): coupon rounding',
    'a --title written as a shell variable is no title, and a Markdown link label fills it in');
  assert.equal(s.prs.find((p) => p.number === 7).title, 'fix', 'an unquoted --title is read');
  assert.equal(s.prs.find((p) => p.number === 12).url, 'https://github.com/o/r/pull/12', 'a PR is opened at its own page');
  assert.equal(s.repos, 2, 'the section says how many repos its PRs span, so one repo need not be repeated on every row');
}

{
  const items = [user('u1'), bash('t1', 'gh pr create --title "$t"', 'https://github.com/o/r/pull/5\n')];
  assert.deepEqual(section(chatOverview(items, facts()), 'prs').prs.map((p) => [p.number, p.title]), [[5, null]],
    'an opened PR whose title is only a shell variable has no title');
}

{
  const items = [user('u1'), { id: 'ag', kind: 'agent', status: 'done', children: [
    bash('c1', 'gh pr create --title "chore: bump"', 'https://github.com/o/r/pull/30'),
  ] }];
  assert.deepEqual(section(chatOverview(items, facts()), 'prs').prs.map((p) => p.number), [30], 'a PR a subagent opened counts');
}

{
  const items = [user('u1'), says('a1', 'https://github.com/o/r/pull/9 and [#5](https://github.com/o/r/pull/5)')];
  assert.equal(section(chatOverview(items, facts()), 'prs'), undefined, 'a chat that only mentions PRs has no PR section');
}

{
  const many = Array.from({ length: PRS_SHOWN + 2 }, (_, i) => bash(`p${i}`, `gh pr create --title "pr ${i}"`, `https://github.com/o/r/pull/${i + 1}`));
  assert.equal(PRS_SHOWN, 3, 'three PRs show before the rest fold behind a count');
  assert.equal(section(chatOverview([user('u1'), ...many], facts()), 'prs').prs.length, PRS_SHOWN + 2, 'the model keeps every PR; the panel folds them');
}

{
  const items = [
    user('u1'),
    edit('e1', `${PROJECT}/index.html`, 'a', 'b\nc'),
    write('w1', `${PROJECT}/notes.txt`, 'one\ntwo'),
    edit('e2', `${PROJECT}/broken.js`, 'a', 'b', 'output-error'),
    user('u2'),
    edit('e3', `${PROJECT}/index.html`, 'x\ny', 'z'),
    edit('e4', '/elsewhere/outside.txt', 'p', 'q'),
  ];
  const s = section(chatOverview(items, facts()), 'files');
  assert.deepEqual(s.files.map((f) => f.path), [`${PROJECT}/index.html`, `${PROJECT}/notes.txt`],
    'files the chat changed in the project, newest-touched first; failed edits and files outside the project left out');
  const index = s.files.find((f) => f.path.endsWith('index.html'));
  assert.deepEqual([index.added, index.removed], [3, 3], 'one file edited in two turns sums its counts');
  assert.equal(index.rel, 'index.html', 'a file in the folder carries the path the Files view opens');
  assert.equal(s.total, 2, 'the section says how many project files there are in all');
}

{
  const many = Array.from({ length: FILES_SHOWN + 3 }, (_, i) => write(`w${i}`, `${PROJECT}/f${i}.txt`, 'x'));
  const s = section(chatOverview([user('u1'), ...many], facts()), 'files');
  assert.equal(FILES_SHOWN, 4, 'four files are listed before the rest fold into a count');
  assert.equal(s.files.length, FILES_SHOWN, 'the file list is capped');
  assert.equal(s.total, FILES_SHOWN + 3, 'the total still counts every file');
  assert.equal(s.files[0].path, `${PROJECT}/f${FILES_SHOWN + 2}.txt`, 'the cap keeps the newest files');
}

{
  const items = [
    user('u1'),
    bash('dev', 'npm run dev', 'started', { taskId: 'k1', status: 'running', background: true }),
    bash('old', 'npm run old', 'done', { taskId: 'k2', status: 'completed', background: true }),
    bash('stop', 'npm run stop', '', { taskId: 'k3', status: 'stopping', background: true, input: { command: 'x', description: 'Stopping server' } }),
    bash('fg', 'ls', 'a'),
    { id: 'bga', kind: 'agent', status: 'running', background: true, description: 'Audit the cart', children: [
      { id: 'nested', kind: 'agent', status: 'running', background: true, description: 'Check coupons', children: [] },
    ] },
    { id: 'fga', kind: 'agent', status: 'running', background: false, description: 'Foreground helper', children: [] },
    { id: 'gone', kind: 'agent', status: 'done', background: true, description: 'Finished', children: [] },
  ];
  const s = section(chatOverview(items, facts()), 'background');
  assert.deepEqual(s.tasks.map((t) => [t.id, t.kind]), [['dev', 'shell'], ['stop', 'shell'], ['bga', 'agent'], ['nested', 'agent']],
    'background shells and subagents still running, at any depth; finished and foreground work left out');
  assert.equal(s.tasks[0].name, 'npm run dev', 'a shell with no description is named by its command');
  assert.equal(s.tasks[1].name, 'Stopping server', 'a shell is named by its description when it has one');
  assert.equal(s.tasks[2].name, 'Audit the cart', 'a subagent is named by its description');
}

{
  const items = [user('u1'), bash('fg', 'ls', 'a'), says('a1', 'done')];
  assert.deepEqual(kinds(chatOverview(items, facts())), ['header', 'places'], 'sections with nothing in them are left out');
}

console.log('overview-check: all assertions passed');
