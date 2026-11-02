'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-search-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.SHELL = '/bin/false';

const failures = [];
async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`FAIL ${name}: ${e.message.split('\n')[0]}`);
  }
}

const history = require(path.join(ROOT, 'src/main/history.js'));
const shellEnv = require(path.join(ROOT, 'src/main/shell-env.js'));

const WORD = 'zephyrine';
const cwd = path.join(home, 'work', 'shop.app');
const dir = path.join(home, '.claude', 'projects', cwd.replace(/[/.]/g, '-'));
fs.mkdirSync(dir, { recursive: true });

const CHUNK = 1 << 18;
const idOf = (n) => `abcd1234-0000-4000-8000-${String(n).padStart(12, '0')}`;
const line = (type, content, extra = {}) => JSON.stringify({
  type, cwd, message: type === 'user' ? { role: 'user', content } : { role: 'assistant', content }, ...extra,
});
const user = (text, extra) => line('user', text, extra);
const said = (text) => line('assistant', [{ type: 'text', text }]);
const toolUse = (input) => line('assistant', [{ type: 'tool_use', id: 't1', name: 'Bash', input }]);
const toolResult = (output) => line('user', [{ type: 'tool_result', tool_use_id: 't1', content: output }]);
const thought = (text) => line('assistant', [{ type: 'thinking', thinking: text }]);

function straddling(before) {
  const make = (pad) => said(`${'x'.repeat(pad)} ${WORD} end`);
  const lead = make(0).indexOf(WORD);
  return make(CHUNK - before - lead - 3);
}

const CASES = [];
for (let i = 0; i < 10; i++) CASES.push({ hit: true, lines: [user(`please check the ${i % 2 ? WORD.toUpperCase() : 'Zephyrine'} totals`), said('on it')] });
for (let i = 0; i < 10; i++) CASES.push({ hit: true, lines: [user('fix the cart'), said(`the ${WORD} module is the cause`)] });
for (let i = 0; i < 10; i++) CASES.push({ hit: false, lines: [user('fix the cart'), toolUse({ command: 'ls' }), toolResult(`${WORD} printed by a tool`), said('done')] });
for (let i = 0; i < 5; i++) CASES.push({ hit: false, lines: [user('fix the cart'), toolUse({ command: `grep ${WORD} src` }), toolResult('ok'), said('done')] });
for (let i = 0; i < 5; i++) CASES.push({ hit: false, lines: [user('fix the cart'), thought(`maybe ${WORD} is involved`), said('done')] });
for (let i = 0; i < 2; i++) CASES.push({ hit: false, lines: [user('fix the cart'), said('done'), user(`subagent asked about ${WORD}`, { isSidechain: true })] });
for (let i = 0; i < 2; i++) CASES.push({ hit: false, lines: [user(`<system-reminder>${WORD} is a hook note</system-reminder>fix the cart`), said('done')] });
CASES.push({ hit: false, lines: [user('fix the cart'), user(`This session is being continued. The tool printed ${WORD}.`, { isCompactSummary: true }), said('done')] });
for (let i = 0; i < 2; i++) CASES.push({ hit: false, lines: [user(`<command-name>/${WORD}</command-name>\n<command-args></command-args>`), user('fix the cart'), said('done')] });
CASES.push({ hit: false, lines: [user('she said "hello there" in C:\\Users\\zed twice'), said('ok')], phrase: true });
CASES.push({ hit: false, lines: [user('first\nsecond   words'), said('ok')], multiline: true });
const opening = user('fix the cart');
CASES.push({ hit: true, lines: [opening, straddling(opening.length + 1)], straddle: true });

assert.strictEqual(CASES.length, 50, 'the fixture is fifty transcripts');
const ids = CASES.map((_, n) => idOf(n + 1));
CASES.forEach((c, n) => {
  const file = path.join(dir, `${ids[n]}.jsonl`);
  fs.writeFileSync(file, `${c.lines.join('\n')}\n`);
  const t = new Date(Date.now() - (CASES.length - n) * 60000);
  fs.utimesSync(file, t, t);
});
const expected = ids.filter((_, n) => CASES[n].hit);

const rgBin = (() => { try { return execFileSync('which', ['rg'], { encoding: 'utf8' }).trim(); } catch { return null; } })();
const bins = fs.mkdtempSync(path.join(home, 'bin-'));
const slow = fs.mkdtempSync(path.join(home, 'slow-'));
fs.writeFileSync(path.join(slow, 'rg'), '#!/bin/sh\nexec sleep 5\n', { mode: 0o755 });
const empty = fs.mkdtempSync(path.join(home, 'empty-'));
const rgLog = path.join(home, 'rg.log');
if (rgBin) {
  fs.writeFileSync(path.join(bins, 'rg'), `#!/bin/sh\necho run >> "${rgLog}"\nexec "${rgBin}" "$@"\n`, { mode: 0o755 });
}
const realPath = process.env.PATH;

async function withPath(p, fn) {
  process.env.PATH = p;
  await shellEnv.reask();
  try { return await fn(); } finally { process.env.PATH = realPath; }
}

const find = async (q, limit) => (await history.search(cwd, q, { limit })).hits;
const ids_ = (hits) => hits.map((h) => h.id).sort();

async function suite(name) {
  await check(`${name}: finds exactly the chats a person or the assistant spoke the word in`, async () => {
    const hits = await find(WORD, 100);
    assert.deepStrictEqual(ids_(hits), [...expected].sort());
  });
  await check(`${name}: every snippet shows the word`, async () => {
    const hits = await find(WORD, 100);
    for (const h of hits) assert.ok(h.snippet.toLowerCase().includes(WORD), `${h.id}: ${h.snippet.slice(0, 80)}`);
  });
  await check(`${name}: a word only a tool, a thought, a subagent or a command echo said is not a hit`, async () => {
    const hits = new Set((await find(WORD, 100)).map((h) => h.id));
    ids.forEach((id, n) => { if (!CASES[n].hit) assert.ok(!hits.has(id), `case ${n} matched`); });
  });
  await check(`${name}: matching ignores case in the query and in the chat`, async () => {
    assert.deepStrictEqual(ids_(await find('ZePhYrInE', 100)), [...expected].sort());
  });
  await check(`${name}: the newest chats come first and the limit cuts the rest`, async () => {
    const hits = await find(WORD, 3);
    assert.strictEqual(hits.length, 3);
    assert.deepStrictEqual(hits.map((h) => h.id), [...expected].reverse().slice(0, 3));
  });
  await check(`${name}: a hit carries the chat's title`, async () => {
    const hits = await find(WORD, 100);
    assert.ok(hits.every((h) => h.title.length > 0), JSON.stringify(hits.find((h) => !h.title)));
    assert.ok(hits.some((h) => h.title.startsWith('please check the')));
  });
  await check(`${name}: a quote in the query finds the escaped text`, async () => {
    const hits = await find('"hello there"', 10);
    assert.deepStrictEqual(hits.map((h) => h.id), [ids[47]]);
  });
  await check(`${name}: a backslash in the query finds the escaped text`, async () => {
    const hits = await find('C:\\Users\\zed', 10);
    assert.deepStrictEqual(hits.map((h) => h.id), [ids[47]]);
  });
  await check(`${name}: words split over lines and spaces match as one space`, async () => {
    const hits = await find('first second words', 10);
    assert.deepStrictEqual(hits.map((h) => h.id), [ids[48]]);
  });
  await check(`${name}: one character is not a search`, async () => {
    assert.deepStrictEqual(await find('z', 10), []);
    assert.deepStrictEqual(await find('   ', 10), []);
  });
  await check(`${name}: a word nobody said finds nothing`, async () => {
    assert.deepStrictEqual(await find('quokka', 10), []);
  });
}

const bigCwd = path.join(home, 'work', 'big.app');
const bigDir = path.join(home, '.claude', 'projects', bigCwd.replace(/[/.]/g, '-'));
const BIG_FILES = 8;
const BIG_BYTES = 15 << 20;
function writeBig() {
  fs.mkdirSync(bigDir, { recursive: true });
  const filler = 'x'.repeat(1 << 20);
  for (let n = 0; n < BIG_FILES; n++) {
    const file = path.join(bigDir, `${idOf(1000 + n)}.jsonl`);
    const fd = fs.openSync(file, 'w');
    fs.writeSync(fd, `${user('fix the cart')}\n{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"`);
    for (let i = 0; i < BIG_BYTES / filler.length; i++) fs.writeSync(fd, filler);
    fs.writeSync(fd, `${WORD}"}]}}\n${said('done')}\n`);
    fs.closeSync(fd);
    const t = new Date(Date.now() - (BIG_FILES - n) * 60000);
    fs.utimesSync(file, t, t);
  }
}

async function large(name) {
  const timed = async (opts) => {
    const t0 = Date.now();
    const res = await history.search(bigCwd, WORD, opts);
    return { ...res, ms: Date.now() - t0 };
  };
  let full;
  await check(`${name}: a word only a tool printed finds nothing across ${BIG_FILES * 15} MB`, async () => {
    full = await timed({ bytes: Infinity });
    assert.deepStrictEqual(full.hits, []);
    assert.strictEqual(full.searched, BIG_FILES);
    assert.strictEqual(full.left, 0);
  });
  await check(`${name}: the default budget searches the newest chats only and counts the ones left out`, async () => {
    const capped = await timed({});
    assert.strictEqual(capped.searched, 4);
    assert.strictEqual(capped.left, BIG_FILES - 4);
  });
  await check(`${name}: a newer search stops the older one`, async () => {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), Math.max(20, full.ms * 0.1));
    const stopped = await timed({ bytes: Infinity, signal: ctl.signal });
    assert.deepStrictEqual(stopped.hits, []);
    assert.ok(stopped.ms < full.ms * 0.6, `stopped after ${stopped.ms} ms against ${full.ms} ms`);
  });
}

async function merging() {
  const { mergeResults } = require(path.join(ROOT, 'src/main/transcript-search.js'));
  await check('merge: two folders that share a transcript directory list each chat once, newest first, up to the limit', () => {
    const hit = (id, at) => ({ id, at, title: id, snippet: id });
    const twice = [hit('a', 3), hit('b', 2), hit('c', 1)];
    const merged = mergeResults([
      { provider: 'claude', project: '/a/b.c', hits: twice, searched: 3, left: 1 },
      { provider: 'claude', project: '/a/b-c', hits: twice, searched: 3, left: 0 },
      { provider: 'codex', project: '/a/b.c', hits: [hit('a', 5)], searched: 1, left: 0 },
    ], 3);
    assert.deepStrictEqual(merged.results.map((r) => `${r.provider}:${r.id}`), ['codex:a', 'claude:a', 'claude:b']);
    assert.strictEqual(merged.results[1].project, '/a/b.c');
    assert.strictEqual(merged.left, 1);
  });
}

async function handler() {
  const { createAgentSearch } = require(path.join(ROOT, 'src/main/search-handler.js'));
  const seen = [];
  const slowRow = {
    id: 'claude',
    label: 'Claude',
    history: {
      search: (dir, query, { signal }) => new Promise((resolve) => {
        const call = { query, signal };
        seen.push(call);
        const done = () => resolve({ hits: signal.aborted ? [] : [{ id: `chat-${query}`, title: query, at: 1, snippet: query }], searched: 1, left: 0 });
        if (signal.aborted) return done();
        signal.addEventListener('abort', done);
        setTimeout(done, 150);
      }),
    },
  };
  const acpRow = { id: 'cursor', label: 'Cursor', history: {} };
  const owners = new Map();
  const handle = createAgentSearch({ rows: () => [slowRow, acpRow], dirs: () => ['/p'], owners });
  const from = (id) => ({ sender: { id } });

  await check('handler: a newer search from the same window aborts the older one', async () => {
    seen.length = 0;
    const first = handle(from(1), { query: 'one' });
    await new Promise((r) => setTimeout(r, 20));
    const second = handle(from(1), { query: 'two' });
    const [a, b] = await Promise.all([first, second]);
    assert.strictEqual(seen[0].signal.aborted, true, 'the older search was left running');
    assert.strictEqual(seen[1].signal.aborted, false, 'the newer search was aborted');
    assert.deepStrictEqual(a.results, []);
    assert.deepStrictEqual(b.results.map((r) => r.id), ['chat-two']);
  });
  await check('handler: a search from another window is left alone', async () => {
    seen.length = 0;
    const first = handle(from(1), { query: 'one' });
    const second = handle(from(2), { query: 'two' });
    const [a, b] = await Promise.all([first, second]);
    assert.ok(seen.every((c) => !c.signal.aborted));
    assert.strictEqual(a.results.length + b.results.length, 2);
  });
  await check('handler: a hit records its provider and an unsearchable provider is named', async () => {
    const res = await handle(from(3), { query: 'three' });
    assert.strictEqual(owners.get('chat-three'), 'claude');
    assert.deepStrictEqual(res.titleOnly, [{ id: 'cursor', label: 'Cursor' }]);
  });
}

async function caching() {
  const { wordCache } = require(path.join(ROOT, 'src/main/transcript-search.js'));
  await check('cache: past its size the oldest threads go and the newest stay', () => {
    const cache = wordCache(10);
    for (let i = 1; i <= 5; i++) cache.set(`t${i}`, 1, ['xxxx']);
    assert.deepStrictEqual([1, 2, 3, 4, 5].map((i) => cache.get(`t${i}`, 1) !== null), [false, false, false, true, true]);
  });
  await check('cache: a thread with a new updatedAt, or none, is not served from it', () => {
    const cache = wordCache(100);
    cache.set('a', 1, ['old']);
    assert.strictEqual(cache.get('a', 2), null);
    cache.set('b', 0, ['never kept']);
    assert.strictEqual(cache.get('b', 0), null);
  });
  await check('cache: replacing a thread frees its old words', () => {
    const cache = wordCache(10);
    cache.set('a', 1, ['xxxxxxxx']);
    cache.set('a', 2, ['yyyyyyyy']);
    cache.set('b', 1, ['zz']);
    assert.deepStrictEqual(cache.get('a', 2), ['yyyyyyyy']);
    assert.deepStrictEqual(cache.get('b', 1), ['zz']);
  });
}

async function codex() {
  const { preferBinary } = require(path.join(ROOT, 'src/main/codex-driver.js'));
  const codexHistory = require(path.join(ROOT, 'src/main/codex-history.js'));
  const says = path.join(home, 'codex-says.json');
  const bin = path.join(home, 'codex');
  fs.writeFileSync(bin, `#!/bin/sh\nMOCK_CODEX_REASON=1 MOCK_CODEX_SAYS="${says}" exec "${process.execPath}" "${path.join(ROOT, 'scripts/mock-codex-cli.js')}" "$@"\n`, { mode: 0o755 });
  preferBinary(bin);
  const project = path.join(home, 'codex-project');
  fs.mkdirSync(project);
  const write = (v) => fs.writeFileSync(says, JSON.stringify(v));
  write({ updatedAt: 1, asked: 'tune the quokka cache', text: 'Done editing the config.' });

  try {
    await check('codex: an assistant message and a user message are searched', async () => {
      assert.strictEqual((await codexHistory.search(project, 'editing the config', { limit: 10 })).hits.length, 1);
      const hits = (await codexHistory.search(project, 'QUOKKA', { limit: 10 })).hits;
      assert.strictEqual(hits.length, 1);
      assert.ok(hits[0].snippet.includes('quokka'), hits[0].snippet);
    });
    await check('codex: reasoning is not a hit', async () => {
      assert.deepStrictEqual((await codexHistory.search(project, 'Reading the file', { limit: 10 })).hits, []);
    });
    await check('codex: a thread that was written to is read again', async () => {
      write({ updatedAt: 2, asked: 'tune the quokka cache', text: 'Now it says wombat.' });
      assert.strictEqual(((await codexHistory.search(project, 'wombat', { limit: 10 })).hits).length, 1);
      assert.deepStrictEqual((await codexHistory.search(project, 'editing the config', { limit: 10 })).hits, []);
    });
    await check('codex: a thread codex gives no updatedAt for is read again every time', async () => {
      for (const [updatedAt, word] of [[0, 'first'], [null, 'third']]) {
        write({ updatedAt, asked: 'tune the quokka cache', text: `The ${word} words.` });
        assert.strictEqual((await codexHistory.search(project, `${word} words`, { limit: 10 })).hits.length, 1);
        write({ updatedAt, asked: 'tune the quokka cache', text: `The ${word}-changed words.` });
        assert.strictEqual((await codexHistory.search(project, `${word}-changed words`, { limit: 10 })).hits.length, 1, `stale for updatedAt ${updatedAt}`);
      }
    });
  } finally {
    codexHistory.close();
  }
}

(async () => {
  writeBig();
  if (rgBin) {
    await withPath(`${bins}${path.delimiter}${realPath}`, async () => {
      fs.rmSync(rgLog, { force: true });
      await suite('with rg');
      await large('with rg');
      await withPath(`${slow}${path.delimiter}${realPath}`, async () => {
        await check('with rg: a newer search kills a ripgrep that is still running', async () => {
          const ctl = new AbortController();
          setTimeout(() => ctl.abort(), 100);
          const t0 = Date.now();
          const res = await history.search(cwd, WORD, { signal: ctl.signal });
          assert.deepStrictEqual(res.hits, []);
          assert.ok(Date.now() - t0 < 2000, `waited ${Date.now() - t0} ms for a ripgrep that was told to stop`);
        });
      });
      await check('with rg: ripgrep did the narrowing', () => {
        assert.ok(fs.existsSync(rgLog), 'the rg on PATH was never run');
      });
    });
  } else {
    console.log('SKIP with rg: no rg on this machine');
  }
  await withPath(empty, async () => {
    fs.rmSync(rgLog, { force: true });
    await suite('without rg');
    await large('without rg');
    await check('without rg: nothing ran ripgrep', () => assert.ok(!fs.existsSync(rgLog)));
  });
  await merging();
  await handler();
  await caching();
  await codex();

  fs.rmSync(home, { recursive: true, force: true });
  console.log(failures.length ? `\n${failures.length} failed` : '\nall passed');
  process.exit(failures.length ? 1 : 0);
})();
