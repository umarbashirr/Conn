/* The starter prompts under plain node: which one-click prompts an empty chat
   offers for what is known about its folder, and how those facts are read from
   the IPC the renderer already has. */
import assert from 'node:assert/strict';
import './renderer-esm.mjs';

const { starterPrompts, readFacts, hasTests } = await import('../src/renderer/ui/lib/starters.js');

const texts = (f) => starterPrompts(f).map((p) => p.text);
const repo = { folder: true, repo: true, dirty: false, tests: false };

assert.deepEqual(starterPrompts(null), [], 'no prompts until the facts are in');

const loose = texts({ folder: false });
assert.ok(loose.length >= 3 && loose.length <= 4, 'a folderless chat gets 3 or 4 prompts');
assert.ok(loose.every((t) => !/project|repo|code|commit|test|folder/i.test(t)), 'folderless prompts assume no repo');

assert.ok(texts({ ...repo, dirty: true }).includes('Review my uncommitted changes'), 'uncommitted changes offer a review');
assert.ok(!texts(repo).includes('Review my uncommitted changes'), 'a clean tree does not offer a review');
assert.ok(texts(repo).some((t) => /recent commits/i.test(t)), 'a clean repo offers its recent commits instead');
assert.ok(!texts({ folder: true, repo: false, dirty: false, tests: false }).some((t) => /commit|uncommitted/i.test(t)), 'a folder without git mentions no commits');
assert.ok(texts({ ...repo, tests: true }).includes('Run the tests and fix what fails'), 'a project with tests offers to run them');
assert.ok(!texts(repo).includes('Run the tests and fix what fails'), 'no tests, no test prompt');

for (const f of [repo, { ...repo, dirty: true, tests: true }, { folder: true, repo: false }]) {
  const t = texts(f);
  assert.ok(t.length >= 3 && t.length <= 4, `3 or 4 prompts for ${JSON.stringify(f)}`);
  assert.equal(new Set(t).size, t.length, 'no prompt repeats');
  assert.ok(t.includes('Explain how this project is organised'), 'every folder can ask how it is organised');
}
assert.equal(texts({ ...repo, dirty: true, tests: true }).length, 4, 'the row stops at four');

assert.ok(hasTests(['src', 'package.json', 'tests'], null), 'a tests folder counts');
assert.ok(hasTests(['src', 'app.test.js'], null), 'a *.test.* file counts');
assert.ok(hasTests(['src', 'test_app.py'], null), 'a test_*.py file counts');
assert.ok(hasTests(['package.json'], '{"scripts":{"test":"vitest"}}'), 'a test script counts');
assert.ok(!hasTests(['package.json'], '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}'), 'the npm placeholder test script does not count');
assert.ok(!hasTests(['src', 'index.html'], null), 'a plain project has no tests');
assert.ok(!hasTests(['package.json'], '{not json'), 'a broken package.json does not throw');

const conn = (over = {}) => ({
  changes: { list: async () => ({ repo: true, files: [{ path: 'a' }] }) },
  files: {
    list: async () => ({ entries: [{ name: 'package.json' }, { name: 'src' }] }),
    read: async () => ({ kind: 'text', text: '{"scripts":{"test":"node --test"}}' }),
  },
  ...over,
});
assert.deepEqual(await readFacts(conn(), '/p'), { folder: true, repo: true, dirty: true, tests: true }, 'facts come from the changes and files calls');
assert.deepEqual(await readFacts(conn(), null), { folder: false }, 'no folder, no reads');
const quiet = await readFacts(conn({ changes: { list: async () => ({ repo: false, files: [] }) }, files: { list: async () => { throw new Error('gone'); }, read: async () => ({}) } }), '/p');
assert.deepEqual(quiet, { folder: true, repo: false, dirty: false, tests: false }, 'a failed read is read as "no", not an error');

console.log('starters-check ok');
