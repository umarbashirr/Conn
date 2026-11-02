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

const ids_ = (hits) => hits.map((h) => h.id).sort();

async function suite(name) {
  await check(`${name}: finds exactly the chats a person or the assistant spoke the word in`, async () => {
    const hits = await history.search(cwd, WORD, 100);
    assert.deepStrictEqual(ids_(hits), [...expected].sort());
  });
  await check(`${name}: every snippet shows the word`, async () => {
    const hits = await history.search(cwd, WORD, 100);
    for (const h of hits) assert.ok(h.snippet.toLowerCase().includes(WORD), `${h.id}: ${h.snippet.slice(0, 80)}`);
  });
  await check(`${name}: a word only a tool, a thought, a subagent or a command echo said is not a hit`, async () => {
    const hits = new Set((await history.search(cwd, WORD, 100)).map((h) => h.id));
    ids.forEach((id, n) => { if (!CASES[n].hit) assert.ok(!hits.has(id), `case ${n} matched`); });
  });
  await check(`${name}: matching ignores case in the query and in the chat`, async () => {
    assert.deepStrictEqual(ids_(await history.search(cwd, 'ZePhYrInE', 100)), [...expected].sort());
  });
  await check(`${name}: the newest chats come first and the limit cuts the rest`, async () => {
    const hits = await history.search(cwd, WORD, 3);
    assert.strictEqual(hits.length, 3);
    assert.deepStrictEqual(hits.map((h) => h.id), [...expected].reverse().slice(0, 3));
  });
  await check(`${name}: a quote in the query finds the escaped text`, async () => {
    const hits = await history.search(cwd, '"hello there"', 10);
    assert.deepStrictEqual(hits.map((h) => h.id), [ids[47]]);
  });
  await check(`${name}: a backslash in the query finds the escaped text`, async () => {
    const hits = await history.search(cwd, 'C:\\Users\\zed', 10);
    assert.deepStrictEqual(hits.map((h) => h.id), [ids[47]]);
  });
  await check(`${name}: words split over lines and spaces match as one space`, async () => {
    const hits = await history.search(cwd, 'first second words', 10);
    assert.deepStrictEqual(hits.map((h) => h.id), [ids[48]]);
  });
  await check(`${name}: one character is not a search`, async () => {
    assert.deepStrictEqual(await history.search(cwd, 'z', 10), []);
    assert.deepStrictEqual(await history.search(cwd, '   ', 10), []);
  });
  await check(`${name}: a word nobody said finds nothing`, async () => {
    assert.deepStrictEqual(await history.search(cwd, 'quokka', 10), []);
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
      assert.strictEqual((await codexHistory.search(project, 'editing the config', 10)).length, 1);
      const hits = await codexHistory.search(project, 'QUOKKA', 10);
      assert.strictEqual(hits.length, 1);
      assert.ok(hits[0].snippet.includes('quokka'), hits[0].snippet);
    });
    await check('codex: reasoning is not a hit', async () => {
      assert.deepStrictEqual(await codexHistory.search(project, 'Reading the file', 10), []);
    });
    await check('codex: a thread that was written to is read again', async () => {
      write({ updatedAt: 2, asked: 'tune the quokka cache', text: 'Now it says wombat.' });
      assert.strictEqual((await codexHistory.search(project, 'wombat', 10)).length, 1);
      assert.deepStrictEqual(await codexHistory.search(project, 'editing the config', 10), []);
    });
  } finally {
    codexHistory.close();
  }
}

(async () => {
  if (rgBin) {
    await withPath(`${bins}${path.delimiter}${realPath}`, async () => {
      fs.rmSync(rgLog, { force: true });
      await suite('with rg');
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
    await check('without rg: nothing ran ripgrep', () => assert.ok(!fs.existsSync(rgLog)));
  });
  await codex();

  fs.rmSync(home, { recursive: true, force: true });
  console.log(failures.length ? `\n${failures.length} failed` : '\nall passed');
  process.exit(failures.length ? 1 : 0);
})();
