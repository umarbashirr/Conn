/* The fixes from the first review of switching a chat between agents in place,
   each held in plain node: state written from committed chats rather than from
   inside an update, picks run one at a time, a send that never reached its
   agent, a switched chat's name and search hits under its first session,
   search reading only what was typed, delete leaving nothing loose, and a
   fork reopened off disk. Prints PASS or FAIL per case; exits 1 on any FAIL. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-handoff-fixes-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.SHELL = '/bin/false';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const { buildHandoff, wrapMessage, unwrapHandoff, itemsFromEntries, carriesHandoff } = require('../src/shared/handoff.js');
const { foldHits, persistable, priorOf, stitch, switchChat, withSession, headOf } = require('../src/shared/chat-segments.js');
const { createSerial, mayApplyModel } = require('../src/shared/model-pick.js');
const { deleteChat } = require('../src/main/delete-chat.js');

const failures = [];
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`FAIL ${name}: ${e.message.split('\n')[0]}`);
  }
};

const A = 'aaaaaaaa-1111';
const B = 'bbbbbbbb-2222';
const C = 'cccccccc-3333';
const label = (p) => ({ claude: 'Claude', codex: 'ChatGPT', cursor: 'Cursor' }[p] || p);
const user = (n, text = `ask ${n}`) => ({ id: `u${n}`, kind: 'user', text });
const reply = (n, text = `reply ${n}`) => ({ id: `a${n}`, kind: 'assistant', text });
const agentSource = fs.readFileSync(path.join(ROOT, 'src/renderer/ui/useAgent.js'), 'utf8');

// #1 ---------------------------------------------------------------------

await check('no value is carried out of a state update in useAgent', () => {
  // `let x = null; edit(..., (c) => { x = ... })` reads x before React has run
  // the updater whenever another update is pending.
  const lines = agentSource.split('\n');
  const bad = [];
  lines.forEach((l, i) => {
    const m = /^\s*let (\w+)( = [^;]+)?;\s*$/.exec(l);
    if (!m) return;
    const after = lines.slice(i + 1, i + 25).join('\n');
    const update = /(set[A-Z]\w*|edit)\(\w*,?\s*\(?\w*\)? =>/.exec(after);
    if (update && new RegExp(`\\b${m[1]}\\s*=[^=>]`).test(after.slice(update.index))) bad.push(`${i + 1}: ${l.trim()}`);
  });
  assert.deepEqual(bad.filter((b) => !/let st = /.test(b)), []);
});

await check('the newest segment learns its session, and what is written comes from that state', () => {
  const c = { provider: 'codex', session: null, segments: [{ provider: 'claude', session: A, from: 0, context: 900 }, { provider: 'codex', session: null, from: 2 }] };
  const next = withSession(c, B);
  assert.equal(next.session, B);
  assert.deepEqual(next.segments.map((s) => s.session), [A, B]);
  assert.deepEqual(persistable(next.segments), [{ provider: 'claude', session: A, context: 900 }, { provider: 'codex', session: B }]);
  assert.equal(persistable(c.segments), null, 'nothing to write until a second session exists');
  assert.equal(withSession({ session: A, segments: [] }, C).session, C, 'a one-session chat just takes the id');
});

// #2, #17 ----------------------------------------------------------------

await check('one chat\'s picks run in order, another chat\'s alongside', async () => {
  const serial = createSerial();
  const log = [];
  const slow = (tag, ms) => () => new Promise((r) => setTimeout(() => { log.push(tag); r(tag); }, ms));
  const runs = [serial('c1', slow('A', 40)), serial('c1', slow('B', 5)), serial('c2', slow('X', 1)), serial('c1', slow('C', 1))];
  assert.deepEqual(await Promise.all(runs), ['A', 'B', 'X', 'C']);
  assert.deepEqual(log, ['X', 'A', 'B', 'C']);
  const failing = serial('c3', () => Promise.reject(new Error('no')));
  await assert.rejects(failing);
  assert.equal(await serial('c3', () => 'after'), 'after', 'a failed pick does not block the next');
});

await check('a model name is only handed to a session on its own CLI', () => {
  assert.equal(mayApplyModel({ provider: 'claude' }, 'codex', 'claude'), false);
  assert.equal(mayApplyModel({ provider: 'codex' }, 'codex', 'claude'), true);
  assert.equal(mayApplyModel({}, 'claude', 'claude'), true, 'a session that never said falls back to the chat\'s CLI');
  assert.equal(mayApplyModel({ provider: 'codex', closed: true }, 'codex'), false);
  assert.equal(mayApplyModel(null, 'codex'), false);
});

await check('a message sent mid-switch waits, and the switch checks busy again after main answers', () => {
  const send = agentSource.slice(agentSource.indexOf('const sendTo = useCallback'), agentSource.indexOf('const send = useCallback'));
  assert.ok(/switching\.current\.has\(key\)[\s\S]{0,200}queued/.test(send), 'sendTo queues while the chat is switching');
  const sw = agentSource.slice(agentSource.indexOf('const switchChatTo = useCallback'), agentSource.indexOf('const pickModel = useCallback'));
  const awaitAt = sw.indexOf('await conn().agent.setModel(key, value)');
  assert.ok(awaitAt > 0 && sw.indexOf('?.busy', awaitAt + 1) > awaitAt && /chatsRef\.current\.find\(\(c\) => c\.key === key\)\?\.busy/.test(sw.slice(awaitAt)),
    'busy is read again after the await');
  assert.ok(/finally \{\s*switching\.current\.delete\(key\)/.test(sw));
});

// #5 ---------------------------------------------------------------------

await check('a stretch whose first send failed is dropped on leaving, row and all', () => {
  let c = { provider: 'claude', session: A, segments: [], items: [user(1), reply(1)], usage: {} };
  c = switchChat(c, { provider: 'codex', id: 'h1', label });
  c = { ...c, items: [...c.items, user(2), { id: 'e1', kind: 'note', error: true, text: 'codex is not installed' }] };
  c = switchChat(c, { provider: 'cursor', id: 'h2', label });
  assert.deepEqual(c.segments.map((s) => s.provider), ['claude', 'cursor']);
  assert.deepEqual(c.items.map((it) => it.id), ['u1', 'a1', 'u2', 'e1', 'h2'], 'the failed message and its error stay, its row goes');
  assert.equal(c.handoff.since, 0, 'cursor is new to the chat');
});

await check('an agent whose only stretch has no session is new to the chat', () => {
  const segs = [{ provider: 'claude', session: A, from: 0 }, { provider: 'codex', session: null, from: 2 }, { provider: 'claude', session: A, from: 5 }, { provider: 'codex', from: 8 }];
  assert.equal(priorOf(segs, 'codex'), null);
  assert.deepEqual(persistable(segs), null, 'claude twice on one session is still one chat on disk');
  assert.deepEqual(persistable([...segs.slice(0, 3), { provider: 'cursor', session: C }]).map((s) => s.session), [A, C]);
});

// #6, #7 -----------------------------------------------------------------

await check('a switched chat is renamed under its first session', () => {
  const rename = agentSource.slice(agentSource.indexOf('const renameChat = useCallback'), agentSource.indexOf('return {\n    items: tree'));
  assert.ok(/const head = headOf\(chat\)/.test(rename) && /agent\.rename\(head, next\)/.test(rename));
  assert.equal(headOf({ session: B, segments: [{ session: A }, { session: B }] }), A);
});

await check('search hits fold into the chat they belong to, under its title', () => {
  const records = { [A]: [{ provider: 'claude', session: A }, { provider: 'codex', session: B }] };
  const hits = [
    { id: B, provider: 'codex', title: '<conn-handoff', at: 9, snippet: 'b' },
    { id: C, provider: 'claude', title: 'Other', at: 8, snippet: 'c' },
    { id: A, provider: 'claude', title: 'Fix login', at: 2, snippet: 'a' },
    { id: 'dddddddd-4444', provider: 'cursor', title: 'left', at: 1, snippet: 'd' },
  ];
  const out = foldHits(hits, { records, hidden: { 'dddddddd-4444': true }, titleOf: (id) => (id === A ? 'Fix login' : null) });
  assert.deepEqual(out.map((h) => [h.id, h.provider, h.title, h.snippet]), [[A, 'claude', 'Fix login', 'b'], [C, 'claude', 'Other', 'c']]);
  assert.deepEqual(out[0].segments, records[A], 'opening the hit opens every session');
});

await check('claude search matches what was typed, not what a handoff carried in', async () => {
  const history = require('../src/main/history.js');
  const cwd = path.join(home, 'work', 'shop');
  const dir = path.join(home, '.claude', 'projects', cwd.replace(/[/.]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const line = (type, content) => JSON.stringify({ type, cwd, message: { role: type, content } });
  const h = buildHandoff({ items: [user(1, 'look at the PANGOLIN module'), reply(1)], from: 'codex', to: 'claude', window: 200000 });
  fs.writeFileSync(path.join(dir, `${A}.jsonl`), [line('user', wrapMessage(h.text, 'now tidy the cart')), line('assistant', [{ type: 'text', text: 'ok' }])].join('\n'));
  fs.writeFileSync(path.join(dir, `${C}.jsonl`), [line('user', 'is the pangolin module slow?'), line('assistant', [{ type: 'text', text: 'no' }])].join('\n'));
  const hits = (await history.search(cwd, 'pangolin', { limit: 10 })).hits;
  assert.deepEqual(hits.map((x) => x.id), [C]);
  const typed = (await history.search(cwd, 'tidy the cart', { limit: 10 })).hits;
  assert.equal(typed.length, 1);
  assert.ok(!typed[0].snippet.includes('conn-handoff') && typed[0].snippet.includes('tidy the cart'), typed[0].snippet);
  assert.equal(typed[0].title, 'now tidy the cart');
});

await check('codex search matches what was typed, not what a handoff carried in', async () => {
  const { preferBinary } = require('../src/main/codex-driver.js');
  const codexHistory = require('../src/main/codex-history.js');
  const says = path.join(home, 'codex-says.json');
  const bin = path.join(home, 'codex');
  fs.writeFileSync(bin, `#!/bin/sh\nMOCK_CODEX_REASON=1 MOCK_CODEX_SAYS="${says}" exec "${process.execPath}" "${path.join(ROOT, 'scripts/mock-codex-cli.js')}" "$@"\n`, { mode: 0o755 });
  preferBinary(bin);
  const project = path.join(home, 'codex-project');
  fs.mkdirSync(project, { recursive: true });
  const h = buildHandoff({ items: [user(1, 'the AARDVARK config'), reply(1)], from: 'claude', to: 'codex', window: 200000 });
  fs.writeFileSync(says, JSON.stringify({ updatedAt: 1, asked: wrapMessage(h.text, 'rename the job'), text: 'Done.' }));
  try {
    assert.deepEqual((await codexHistory.search(project, 'aardvark', { limit: 10 })).hits, []);
    const hits = (await codexHistory.search(project, 'rename the job', { limit: 10 })).hits;
    assert.equal(hits.length, 1);
    assert.ok(!hits[0].snippet.includes('conn-handoff'), hits[0].snippet);
  } finally {
    codexHistory.close?.();
  }
});

// #9 ---------------------------------------------------------------------

await check('delete removes the other sessions first and reports what it could not', async () => {
  const gone = [];
  const remove = async (session, provider) => {
    if (provider === 'cursor') throw new Error('Cursor cannot delete a chat from outside itself.');
    gone.push(session);
    return true;
  };
  const segs = [{ provider: 'claude', session: A }, { provider: 'cursor', session: C }, { provider: 'codex', session: B }, { provider: 'claude', session: A }];
  const res = await deleteChat({ id: A, segments: segs, remove });
  assert.deepEqual(gone, [B, A], 'the first session goes last');
  assert.deepEqual(res.removed, [B]);
  assert.deepEqual(res.left.map((l) => [l.session, l.provider]), [[C, 'cursor']]);
  assert.match(res.left[0].error, /outside itself/);
  assert.equal(res.gone, true);
});

await check('a failed delete of the first session comes back with what was already removed', async () => {
  const res = await deleteChat({
    id: A,
    segments: [{ provider: 'claude', session: A }, { provider: 'codex', session: B }],
    remove: async (session) => { if (session === A) throw new Error('busy'); return true; },
  });
  assert.equal(res.error, 'busy');
  assert.deepEqual(res.removed, [B]);
});

await check('delete keeps the record and hides what was left behind', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src/main/index.js'), 'utf8');
  const del = main.slice(main.indexOf("ipcMain.handle('agent:deleteSession'"), main.indexOf("ipcMain.on('agent:active'"));
  assert.ok(/for \(const l of left\) hiddenSessions\.set\(l\.session, true\)/.test(del));
  assert.ok(/if \(!left\.length\) chatSegments\.forget\(id\)/.test(del));
  assert.ok(del.indexOf('removed.forEach(forgetMarks)') < del.indexOf('if (error) return { error }'));
});

// #3, #4, #12, #15 -------------------------------------------------------

await check('a reopened fork shows what it was given and still reads as a fork', () => {
  const items = [user(1, 'Fix login'), reply(1, 'Done </item> mostly'), { id: 't1', kind: 'tool', name: 'Bash', input: { command: 'npm test' }, output: 'ok', state: 'output-available' }];
  const h = buildHandoff({ items, from: 'claude', to: 'codex', model: 'GPT-6.2-Sol', fork: true, window: 200000 });
  const u = unwrapHandoff(wrapMessage(h.text, 'carry on'));
  assert.equal(u.fork, true);
  assert.equal(u.model, 'GPT-6.2-Sol', 'the row keeps the name it showed live');
  const back = itemsFromEntries(u.entries(), 'h0:c:');
  assert.deepEqual(back.map((it) => [it.id, it.kind]), [['h0:c:u1', 'user'], ['h0:c:a1', 'assistant'], ['h0:c:t1', 'tool']]);
  assert.equal(back[1].text, 'Done </item> mostly');
  assert.deepEqual(back[2].input, { command: 'npm test' });
  assert.equal(back[2].output, 'ok');
  assert.ok(carriesHandoff({ type: 'user', message: { content: [{ type: 'text', text: wrapMessage(h.text, 'x') }] } }));
  assert.ok(!carriesHandoff({ type: 'user', message: { content: 'plain' } }));
});

await check('a forked chat later switched reopens with its own first stretch', () => {
  const read = { [A]: [{ id: 'x0', kind: 'handoff' }, user(1), reply(1), { id: 'x3', kind: 'handoff' }, user(3)], [B]: [{ id: 'x2', kind: 'handoff' }, user(2)] };
  const put = stitch([{ provider: 'codex', session: A }, { provider: 'claude', session: B }, { provider: 'codex', session: A }], read);
  assert.deepEqual(put.items.map((it) => it.id), ['x0', 'u1', 'a1', 'x2', 'u2', 'x3', 'u3']);
});

fs.rmSync(home, { recursive: true, force: true });
console.log(failures.length ? `\n${failures.length} failed: ${failures.join(', ')}` : '\nall passed');
process.exit(failures.length ? 1 : 0);
