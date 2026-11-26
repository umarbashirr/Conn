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
const F_ = 'ffffffff-4444';
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
  const awaitAt = sw.indexOf('await conn().agent.setModel(key, value, want)');
  assert.ok(awaitAt > 0 && sw.indexOf('?.busy', awaitAt + 1) > awaitAt && /chatsRef\.current\.find\(\(c\) => c\.key === key\)\?\.busy/.test(sw.slice(awaitAt)),
    'busy is read again after the await');
  assert.ok(/finally \{\s*if \(!landed\) switching\.current\.delete\(key\)/.test(sw), 'a refused switch releases the queue at once; a landed one waits for the commit');
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
  assert.deepEqual(res.removed, [B, A]);
  assert.deepEqual(res.left.map((l) => [l.session, l.provider]), [[C, 'cursor']]);
  assert.match(res.left[0].error, /outside itself/);
});

await check('a first session that will not go is left like any other, and the rest still go', async () => {
  const res = await deleteChat({
    id: A,
    segments: [{ provider: 'cursor', session: A }, { provider: 'codex', session: B }],
    remove: async (session) => { if (session === A) throw new Error('refuses'); return true; },
  });
  assert.deepEqual(res.removed, [B]);
  assert.deepEqual(res.left.map((l) => [l.session, l.provider]), [[A, 'cursor']]);
  const plain = await deleteChat({ id: C, segments: [{ session: C, provider: 'claude' }], remove: async () => false });
  assert.deepEqual([plain.removed, plain.left], [[C], []], 'a reader that found nothing to delete is gone, not left');
});

await check('delete always drops the row and the record, and hides what was left', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src/main/index.js'), 'utf8');
  const del = main.slice(main.indexOf("ipcMain.handle('agent:deleteSession'"), main.indexOf("ipcMain.on('agent:pendingHandoffs'"));
  assert.ok(/hiddenSessions\.set\(l\.session, \{ provider: l\.provider, project: dir, title/.test(del));
  assert.ok(/\n      chatSegments\.forget\(id\);/.test(del), 'the record goes unconditionally');
  assert.ok(/return \{ ok: true/.test(del));
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

// Round 2 -----------------------------------------------------------------

const { escape, unescape } = require('../src/shared/handoff.js');
const { modelEntry } = require('../src/shared/model-pick.js');

await check('escaping carried text round-trips any marker-like text and leaves no marker', () => {
  const parts = ['<', '/', '\\', 'item', 'ITEM', 'conn-handoff', '</item>', '<\\/item', '<\\\\/conn-handoff', 'x', ' ', '>', '\n'];
  let seed = 7;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let i = 0; i < 20000; i++) {
    let s = '';
    for (let j = rand(14); j > 0; j--) s += parts[rand(parts.length)];
    const e = escape(s);
    assert.equal(unescape(e), s, `round trip of ${JSON.stringify(s)}`);
    assert.ok(!/<\/(item|conn-handoff)\b/i.test(e), `a marker survived in ${JSON.stringify(e)}`);
  }
  const h = buildHandoff({ items: [reply(1, 'already escaped: <\\/item> and </item>')], from: 'claude', to: 'codex', window: 200000, fork: true });
  assert.equal(unwrapHandoff(wrapMessage(h.text, 'x')).entries()[0].body, 'already escaped: <\\/item> and </item>');
});

await check('a carried call that was still running does not come back as failed', () => {
  const h = buildHandoff({ items: [{ id: 't1', kind: 'tool', name: 'Bash', input: { command: 'sleep 9' }, state: 'input-available' }], from: 'claude', to: 'codex', window: 200000, fork: true });
  const [row] = itemsFromEntries(unwrapHandoff(wrapMessage(h.text, 'x')).entries(), 'p:');
  assert.notEqual(row.state, 'output-error');
});

await check('a session from the CLI the chat has left is not taken as this chat\'s', () => {
  const c = { provider: 'copilot', session: null, segments: [{ provider: 'claude', session: A, from: 0 }, { provider: 'copilot', session: null, from: 2, cut: 0 }] };
  assert.equal(withSession(c, B, 'claude'), c, 'the old CLI finishing up reports in late');
  assert.equal(withSession(c, C, 'copilot').segments[1].session, C);
  assert.equal(withSession({ provider: 'codex', session: null, segments: [] }, A, 'claude').session, null);
});

await check('a switch records where it starts in its session, and reopen follows that', () => {
  // A fork's chat opens on the handoff it was forked with.
  let c = { provider: 'codex', session: F_, segments: [], items: [{ id: 'x0', kind: 'handoff', fork: true }, user(1), reply(1)], usage: {} };
  c = switchChat(c, { provider: 'claude', id: 'h1', label });
  assert.equal(c.segments[1].cut, 0, 'a fresh session starts at its first handoff');
  c = { ...withSession(c, B, 'claude'), handoff: null, items: [...c.items, user(2), reply(2)] };
  c = switchChat(c, { provider: 'codex', id: 'h2', label });
  assert.equal(c.session, F_);
  assert.equal(c.segments[2].cut, 1, 'the fork\'s own first handoff is number 0, so coming back is number 1');
  const saved = persistable(c.segments.map((x, i) => (i === 2 ? x : x)));
  assert.deepEqual(saved.map((x) => x.cut ?? null), [null, 0, 1]);
  const read = {
    [F_]: [{ id: 'c1', kind: 'user', carried: true }, { id: 'x0', kind: 'handoff', fork: true }, user(1), reply(1), { id: 'x3', kind: 'handoff' }, user(3)],
    [B]: [{ id: 'x2', kind: 'handoff' }, user(2), reply(2)],
  };
  assert.deepEqual(stitch(saved, read).items.map((it) => it.id), ['c1', 'x0', 'u1', 'a1', 'x2', 'u2', 'a2', 'x3', 'u3']);
  const old = stitch(saved.map(({ cut, ...x }) => x), read);
  assert.deepEqual(old.segments.map((x) => x.cut ?? null), [null, 0, 1], 'a record from before cuts learns them on reopen');
});

await check('a pick names its CLI, and the name alone is only a fallback', () => {
  const models = [{ value: 'gpt-6.2-sol', provider: 'copilot' }, { value: 'gpt-6.2-sol', provider: 'codex' }];
  assert.equal(modelEntry(models, 'gpt-6.2-sol', 'codex').provider, 'codex');
  assert.equal(modelEntry(models, 'gpt-6.2-sol', 'cursor'), null);
  assert.equal(modelEntry(models, 'gpt-6.2-sol').provider, 'copilot');
  const composer = fs.readFileSync(path.join(ROOT, 'src/renderer/ui/components/composer.jsx'), 'utf8');
  assert.ok(/onPick\(long && all\.has\(m\.value \+ LONG\) \? m\.value \+ LONG : m\.value, m\.provider\)/.test(composer), 'the picker hands over the row\'s CLI');
  const main = fs.readFileSync(path.join(ROOT, 'src/main/index.js'), 'utf8');
  assert.ok(/const nextProvider = isProviderId\(picked\) \? picked :/.test(main), 'main takes the CLI it is given');
  assert.equal((agentSource.match(/agent\.setModel\([^)]*\)/g) || []).filter((c) => !/, want\)$/.test(c)).length, 0, 'every pick passes its CLI to main');
});

await check('a refused switch puts back what the next session starts on, busy or not', () => {
  const sw = agentSource.slice(agentSource.indexOf('const switchChatTo = useCallback'), agentSource.indexOf('const pickModel = useCallback'));
  assert.ok(/agent\.restoreModel\(key, chat\.usage\?\.model \|\| '', chat\.provider\)/.test(sw));
  const main = fs.readFileSync(path.join(ROOT, 'src/main/index.js'), 'utf8');
  const restore = main.slice(main.indexOf("ipcMain.handle('agent:restoreModel'"), main.indexOf("ipcMain.handle('agent:setProvider'"));
  assert.ok(/chatPrefs\.setProvider\(chat, was\)/.test(restore) && !/busy/.test(restore));
});

await check('the queue flushes from committed state, and a handoff goes once', () => {
  const flush = agentSource.slice(agentSource.indexOf('const flushChat = useCallback'), agentSource.indexOf('const decide = useCallback'));
  assert.ok(/flushChat\(c\.key, c\)/.test(flush) && /committed: chat/.test(flush));
  assert.ok(/if \(!s\.landing\) continue;/.test(flush), 'a switch counts as landed only once committed');
  const send = agentSource.slice(agentSource.indexOf('const sendTo = useCallback'), agentSource.indexOf('sendToRef.current = sendTo'));
  assert.ok(/reading\.current\.has\(key\)/.test(send) && /carried\.current\.add\(owed\.marker\)/.test(send));
});

await check('a reopened chat knows how full its window was', async () => {
  await import('./renderer-esm.mjs');
  const { storedContext } = await import('../src/renderer/ui/lib/usage.js');
  assert.equal(storedContext({ messages: [{ type: 'assistant', message: { usage: { input_tokens: 10, cache_read_input_tokens: 90 } } }, { type: 'user', message: {} }] }), 100);
  assert.equal(storedContext({ usage: { message: { usage: { input_tokens: 5, context_window: 1000 } } }, messages: [] }), 5);
  assert.equal(storedContext({ messages: [] }), 0);
});

await check('a chat that starts on an ACP agent and moves to Claude is written down under the ACP session', () => {
  const cop = '2629255a-acaa-45c7-9688-fcf68dfc8949';
  const cla = '43a53e52-c9db-4cb7-ad42-883f4efa72db';
  // A new chat picked onto Copilot before its first message, then Copilot's ready.
  let c = { provider: 'copilot', session: null, segments: [], items: [], usage: {} };
  c = withSession(c, cop, 'copilot');
  assert.equal(c.session, cop, 'the ACP agent\'s session is taken');
  c = { ...c, items: [user(1), reply(1)], usage: { context: 14831 } };
  c = switchChat(c, { provider: 'claude', model: 'Opus 5.5', id: 'h1', label });
  assert.deepEqual(c.segments.map((x) => [x.provider, x.session, x.cut ?? null]), [['copilot', cop, null], ['claude', null, 0]]);
  // Copilot finishing late must not fill Claude's segment; Claude's own ready does.
  assert.equal(withSession(c, 'ffffffff-late', 'copilot'), c);
  c = withSession(c, cla, 'claude');
  assert.deepEqual(persistable(c.segments), [
    { provider: 'copilot', session: cop, context: 14831 },
    { provider: 'claude', session: cla, cut: 0 },
  ]);
  const { cleanSegments } = require('../src/shared/chat-segments.js');
  assert.ok(cleanSegments(persistable(c.segments)), 'and the store accepts it');
});

// Round 3 -----------------------------------------------------------------

const { createStitchCache } = require('../src/main/stitch-cache.js');
const { createRelay } = require('../src/main/window-relay.js');
const { cutFor } = require('../src/shared/chat-segments.js');
const { deleteNote } = require('../src/shared/delete-note.js');

await check('the phone cache reads again whenever a session\'s stamp moves, and never keeps an unstamped one', async () => {
  const stamps = { [A]: 'a1', [B]: 'b1' };
  let reads = 0;
  const get = createStitchCache({ read: async () => { reads += 1; return [`read ${reads}`]; }, stampOf: (dir, s) => stamps[s] || null });
  const segs = [{ provider: 'claude', session: A }, { provider: 'codex', session: B }];
  assert.deepEqual(await get('/p', segs), ['read 1']);
  assert.deepEqual(await get('/p', segs), ['read 1'], 'nothing moved, nothing read');
  stamps[B] = 'b2';
  assert.deepEqual(await get('/p', segs), ['read 2'], 'a write to one session reads the chat again');
  delete stamps[A];
  await get('/p', segs);
  await get('/p', segs);
  assert.equal(reads, 4, 'a session with no stamp is read every time');
});

await check('the phone cache stamp for a transcript on disk is its size and time, statted each read', () => {
  const history = require('../src/main/history.js');
  const cwd = path.join(home, 'work', 'stamp');
  const dir = path.join(home, '.claude', 'projects', cwd.replace(/[/.]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${A}.jsonl`);
  fs.writeFileSync(file, '{}\n');
  const one = history.stamp(cwd, A);
  fs.appendFileSync(file, '{"more":true}\n');
  assert.notEqual(history.stamp(cwd, A), one, 'a write in the same second still moves the size');
  assert.equal(history.stamp(cwd, 'zzzzzzzz-none'), null);
  const main = fs.readFileSync(path.join(ROOT, 'src/main/index.js'), 'utf8');
  assert.ok(/agent\.on\('message', \(m\) => \{\n    wrote\(agent\.sessionId\);/.test(main), 'every message a session sends here moves its stamp');
});

await check('a phone message is ok only once the window has it, and an error otherwise', async () => {
  const timers = [];
  const sent = [];
  const relay = createRelay({
    send: (p) => { sent.push(p); return true; },
    timeoutMs: 50,
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimer: (t) => { t.cleared = true; },
  });
  const one = relay.forward({ chat: 'c1', text: 'hi' });
  assert.equal(sent[0].chat, 'c1');
  assert.equal(relay.settle(sent[0].id, { ok: true }), true);
  assert.deepEqual(await one, { ok: true });
  assert.equal(timers[0].cleared, true);
  const two = relay.forward({ chat: 'c1', text: 'lost' });
  timers[1].fn();
  assert.match((await two).error, /did not take/);
  assert.equal(relay.settle(sent[1].id, { ok: true }), false, 'a late answer changes nothing');
  const three = relay.forward({ chat: 'c1', text: 'reload' });
  relay.failAll('Conn reloaded');
  assert.deepEqual(await three, { error: 'Conn reloaded' });
  const none = createRelay({ send: () => false, setTimer: () => 0, clearTimer: () => {} });
  assert.match((await none.forward({})).error, /no window/);
  const refused = relay.forward({ chat: 'gone' });
  relay.settle(sent.at(-1).id, { ok: false, error: 'That chat is not open in Conn any more.' });
  assert.match((await refused).error, /not open/);
});

await check('a resume that comes back as a new session starts that session at its first handoff', () => {
  const c = { provider: 'claude', session: A, segments: [{ provider: 'claude', session: A, from: 0 }, { provider: 'codex', session: B, from: 2 }, { provider: 'claude', session: A, from: 5, cut: 1 }], items: [] };
  assert.equal(withSession(c, A, 'claude').segments[2].cut, 1, 'the same session keeps its cut');
  const moved = withSession(c, C, 'claude');
  assert.equal(moved.segments[2].session, C);
  assert.equal(moved.segments[2].cut, 0);
  assert.equal(withSession({ ...c, segments: c.segments.map((x, i) => (i === 2 ? { ...x, session: null, cut: 0 } : x)) }, C, 'claude').segments[2].cut, 0);
});

await check('where a stretch starts is read off the session\'s own handoff rows', () => {
  const fork = { id: 'x0', kind: 'handoff', fork: true };
  const segs = [{ provider: 'codex', session: F_, from: 0 }, { provider: 'claude', session: B, from: 3 }, { provider: 'codex', session: F_, from: 6 }];
  const whole = [fork, user(1), reply(1), { id: 'h1', kind: 'handoff' }, user(2), reply(2), { id: 'h2', kind: 'handoff' }];
  assert.equal(cutFor(whole, segs), 1, 'the fork\'s own handoff is in its first stretch');
  // A long fork opened with only its end read in has no fork row loaded yet:
  // the count is short until the rest is read, which sendTo does first.
  const partial = [user(1), reply(1), { id: 'h0', kind: 'user' }, { id: 'h1', kind: 'handoff' }, user(2), reply(2), { id: 'h2', kind: 'handoff' }];
  assert.equal(cutFor(partial, segs), 0);
  const send = agentSource.slice(agentSource.indexOf('const sendTo = useCallback'), agentSource.indexOf('sendToRef.current = sendTo'));
  assert.ok(send.indexOf('readWhole(key, chat)') < send.indexOf('segments: recut(c)'), 'the cut is counted again after the whole chat is read in');
  assert.equal(cutFor([user(1)], [{ provider: 'claude', session: A, from: 0 }, { provider: 'codex', session: null, from: 1 }]), 0);
});

await check('a carried call that was still running reads as handed over, not finished', () => {
  const h = buildHandoff({ items: [{ id: 't1', kind: 'tool', name: 'Bash', input: { command: 'sleep 9' }, state: 'input-available' }], from: 'claude', to: 'codex', window: 200000, fork: true });
  const [row] = itemsFromEntries(unwrapHandoff(wrapMessage(h.text, 'x')).entries(), 'p:');
  assert.equal(row.state, 'handed-over');
  assert.equal(row.output, undefined);
  const toolRow = fs.readFileSync(path.join(ROOT, 'src/renderer/ui/components/tool-row.jsx'), 'utf8');
  assert.ok(/state === 'handed-over'/.test(toolRow) && /still running when handed over/.test(toolRow));
});

await check('hidden chats round-trip: added on delete, listed for Settings, removed by Show again', () => {
  const hidden = require('../src/main/hidden-sessions.js');
  assert.ok(hidden.FILE.startsWith(home));
  hidden.set(A, { provider: 'copilot', project: '/work/shop', title: 'Fix login', at: 1700000000000, hiddenAt: 2 });
  hidden.set(B, true);
  hidden.set(C, { provider: 'cursor', project: '/work/shop', title: 'Old', at: 5, hiddenAt: 9 });
  assert.deepEqual(hidden.list().map((h) => [h.session, h.provider || null, h.title || null]), [[C, 'cursor', 'Old'], [A, 'copilot', 'Fix login'], [B, null, null]]);
  assert.equal(JSON.parse(fs.readFileSync(hidden.FILE, 'utf8'))[A].title, 'Fix login', 'written to disk');
  assert.throws(() => hidden.set(A, 'yes'), /not a hidden chat/);
  assert.equal(hidden.forget(A), true);
  assert.deepEqual(hidden.list().map((h) => h.session), [C, B]);
  assert.equal(hidden.forget(A), false);
  const main = fs.readFileSync(path.join(ROOT, 'src/main/index.js'), 'utf8');
  assert.ok(/ipcMain\.handle\('agent:hidden', \(\) => hiddenSessions\.list\(\)\)/.test(main));
  assert.ok(/ipcMain\.handle\('agent:unhide'/.test(main) && /ipcMain\.handle\('agent:deleteHidden'/.test(main));
});

await check('the delete toast says plainly what stayed', () => {
  assert.equal(deleteNote({ left: [] }), null);
  const whole = deleteNote({ left: [{ provider: 'copilot' }], deleted: [] });
  assert.equal(whole.title, 'Removed from Conn.');
  assert.match(whole.description, /^Copilot kept its copy on disk\./);
  const part = deleteNote({ left: [{ provider: 'copilot' }], deleted: ['claude', 'claude'] });
  assert.equal(part.title, 'Deleted the Claude part.');
  assert.match(part.description, /^Copilot kept its part on disk\./);
  const two = deleteNote({ left: [{ provider: 'copilot' }, { provider: 'cursor' }], deleted: [] });
  assert.match(two.description, /^Copilot and Cursor kept their copies on disk/);
  for (const n of [whole, part, two]) assert.ok(!/except one part/.test(`${n.title} ${n.description}`));
});

fs.rmSync(home, { recursive: true, force: true });
console.log(failures.length ? `\n${failures.length} failed: ${failures.join(', ')}` : '\nall passed');
process.exit(failures.length ? 1 : 0);
