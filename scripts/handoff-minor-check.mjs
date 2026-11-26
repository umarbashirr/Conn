/* The verifier's round-three minor findings on switching a chat between
   agents, under plain node, on a throwaway HOME. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-handoff-minor-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.SHELL = '/bin/false';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const A = 'aaaaaaaa-1111';
const B = 'bbbbbbbb-2222';
const C = 'cccccccc-3333';
const failures = [];
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`); } catch (e) { failures.push(name); console.log(`FAIL ${name}: ${e.message.split('\n')[0]}`); }
};

// A call handed over while still running is still running when carried on again.
await check('a handed-over call goes to the next agent as running, not done', () => {
  const { entriesOf } = require('../src/shared/handoff.js');
  const [e] = entriesOf([{ id: 't', kind: 'tool', name: 'Bash', input: { command: 'make' }, state: 'handed-over' }]);
  assert.equal(e.status, 'running');
});

// Show again gives back one chat, not one row per part.
await check('the parts a delete left of one chat come back as that one chat', () => {
  const hidden = require('../src/main/hidden-sessions.js');
  const records = require('../src/main/chat-segments.js');
  const { hideParts, showAgain } = require('../src/main/hidden-chats.js');
  const { collapseRows } = require('../src/shared/chat-segments.js');
  assert.ok(hidden.FILE.startsWith(home) && records.FILE.startsWith(home));
  // Claude A -> Copilot B -> Cursor C, deleted: Claude went, Copilot and Cursor stayed.
  const segs = [{ provider: 'claude', session: A }, { provider: 'copilot', session: B, cut: 0, context: 40 }, { provider: 'cursor', session: C, cut: 0 }];
  hideParts({ hidden, head: A, segments: segs, left: [{ session: B, provider: 'copilot' }, { session: C, provider: 'cursor' }], meta: { project: '/w', title: 'Fix login', atOf: () => 5 } });
  const rows = hidden.list();
  assert.equal(rows.length, 1, 'Settings lists the chat once');
  assert.deepEqual([rows[0].title, rows[0].sessions, rows[0].providers], ['Fix login', [B, C], ['copilot', 'cursor']]);
  const res = showAgain({ hidden, records, session: C });
  assert.deepEqual([res.ok, res.sessions, res.joined], [true, [B, C], true]);
  assert.deepEqual(hidden.list(), [], 'every part is shown again, not only the one clicked');
  assert.deepEqual(records.get(B), [{ provider: 'copilot', session: B, context: 40, cut: 0 }, { provider: 'cursor', session: C, cut: 0 }], 'the record is back, under the first part that stayed');
  assert.deepEqual(collapseRows([{ id: B, at: 1 }, { id: C, at: 2 }], records.all()).map((r) => r.id), [B], 'the rail draws it as one row');
  records.forget(B);
});
await check('a chat that left one part comes back as that part, and a retry keeps the rest together', () => {
  const hidden = require('../src/main/hidden-sessions.js');
  const records = require('../src/main/chat-segments.js');
  const { hideParts, showAgain, afterRetry } = require('../src/main/hidden-chats.js');
  hideParts({ hidden, head: A, segments: [{ provider: 'claude', session: A }, { provider: 'copilot', session: B, cut: 0 }], left: [{ session: B, provider: 'copilot' }], meta: { title: 'One' } });
  assert.deepEqual(showAgain({ hidden, records, session: B }), { ok: true, sessions: [B], joined: false });
  assert.equal(records.get(B), null, 'one part needs no record');
  const segs = [{ provider: 'claude', session: A }, { provider: 'copilot', session: B, cut: 0 }, { provider: 'cursor', session: C, cut: 0 }];
  hideParts({ hidden, head: A, segments: [...segs, { provider: 'grok', session: 'dddddddd-4444', cut: 0 }], left: [{ session: B, provider: 'copilot' }, { session: C, provider: 'cursor' }, { session: 'dddddddd-4444', provider: 'grok' }], meta: { title: 'Three' } });
  assert.deepEqual(afterRetry({ hidden, session: B, removed: ['dddddddd-4444'] }).left, [B, C]);
  assert.deepEqual(hidden.list()[0].sessions, [B, C], 'still one chat');
  assert.deepEqual(hidden.get(B).segments.map((s) => s.session), [B, C], 'and its run is what is left');
  showAgain({ hidden, records, session: B });
  records.forget(B);
  const main = read('src/main/index.js');
  assert.ok(/hideParts\(\{/.test(main) && /showAgain\(\{ hidden: hiddenSessions, records: chatSegments, titles: chatTitles, session \}\)/.test(main) && /afterRetry\(\{ hidden: hiddenSessions, session, removed \}\)/.test(main), 'main hides, shows and retries by chat');
});

// A phone send is taken once, at once.
await check('a phone send carries its id to the window, which takes it once and at once', async () => {
  assert.ok(/provider: parsed\.provider,\n\s+nonce,/.test(read('src/main/mobile-gate.js')), 'the gate passes the phone\'s id on');
  const main = read('src/main/index.js');
  assert.ok(/turnId: nonce\.slice\(0, 200\)/.test(main), 'main hands it to the window');
  const { createRelay } = require('../src/main/window-relay.js');
  const sent = [];
  const relay = createRelay({ send: (p) => { sent.push(p); return true; }, setTimer: () => 0, clearTimer: () => {} });
  const answer = relay.forward({ chat: 'c', text: 'hi', turnId: 'n7' });
  assert.equal(sent[0].turnId, 'n7');
  relay.settle(sent[0].id, { ok: true });
  assert.deepEqual(await answer, { ok: true });
  const agent = read('src/renderer/ui/useAgent.js');
  const handler = agent.slice(agent.indexOf('offs.push(conn().agent.onPhoneTurn'), agent.indexOf('offs.push(conn().agent.onPhoneTurn') + 900);
  assert.ok(/phoneTaken\.current\.has\(turnId\)/.test(handler), 'a repeat is answered and not queued again');
  const queued = handler.indexOf('queued: [...c.queued');
  const answered = handler.indexOf("phoneTurnTaken?.(id, { ok: true });\n    })");
  assert.ok(queued > 0 && answered > queued, 'it is queued, then answered, with no read of the chat in between');
  assert.ok(!/sendTo/.test(handler), 'the queue sends it, not a send the answer waits on');
});

// The phone cache stamps a codex chat by its rollout file.
await check('a codex thread is stamped by its rollout file\'s size and time', async () => {
  const { preferBinary } = require('../src/main/codex-driver.js');
  const codexHistory = require('../src/main/codex-history.js');
  const says = path.join(home, 'codex-says.json');
  const rollout = path.join(home, 'rollout.jsonl');
  fs.writeFileSync(rollout, '{"a":1}\n');
  fs.writeFileSync(says, JSON.stringify({ updatedAt: 1, asked: 'hi', text: 'Done.' }));
  const bin = path.join(home, 'codex');
  fs.writeFileSync(bin, `#!/bin/sh\nMOCK_CODEX_REASON=1 MOCK_CODEX_SAYS="${says}" MOCK_CODEX_ROLLOUT="${rollout}" exec "${process.execPath}" "${path.join(ROOT, 'scripts/mock-codex-cli.js')}" "$@"\n`, { mode: 0o755 });
  preferBinary(bin);
  const project = path.join(home, 'codex-project');
  fs.mkdirSync(project, { recursive: true });
  try {
    const [row] = await codexHistory.listSessions(project);
    assert.ok(row?.id, 'the mock lists a thread');
    const one = codexHistory.stamp(project, row.id);
    assert.ok(one, 'a listed thread has a stamp');
    fs.appendFileSync(rollout, '{"b":2}\n');
    assert.notEqual(codexHistory.stamp(project, row.id), one, 'a write in the same second moves it');
    assert.equal(codexHistory.stamp(project, 'unknown-thread'), null);
  } finally {
    codexHistory.close?.();
  }
  assert.ok(/rowOf\(p\)\?\.history\?\.stamp\?\.\(dir, session\)/.test(read('src/main/index.js')), 'the phone cache asks every agent\'s history for one');
});

// A chat whose first part is gone comes back under its own title.
await check('Show again carries the chat\'s title to the part that is now its first', () => {
  const hidden = require('../src/main/hidden-sessions.js');
  const records = require('../src/main/chat-segments.js');
  const titles = require('../src/main/chat-titles.js');
  const { hideParts, showAgain } = require('../src/main/hidden-chats.js');
  assert.ok(titles.FILE.startsWith(home));
  // Claude A went; only Copilot B, whose own first message carried the handoff, stayed.
  hideParts({ hidden, head: A, segments: [{ provider: 'claude', session: A }, { provider: 'copilot', session: B, cut: 0 }], left: [{ session: B, provider: 'copilot' }], meta: { title: 'Fix login' } });
  showAgain({ hidden, records, titles, session: B });
  assert.equal(titles.get(B), 'Fix login', 'the part shows under the chat\'s name, not its first message');
  titles.forget(B);
  // Two later parts stayed: the title goes to the one the chat now starts on.
  hideParts({ hidden, head: A, segments: [{ provider: 'claude', session: A }, { provider: 'copilot', session: B, cut: 0 }, { provider: 'cursor', session: C, cut: 0 }], left: [{ session: B, provider: 'copilot' }, { session: C, provider: 'cursor' }], meta: { title: 'Two left' } });
  showAgain({ hidden, records, titles, session: C });
  assert.equal(titles.get(B), 'Two left');
  assert.equal(titles.get(C), null);
  titles.forget(B);
  records.forget(B);
  // A chat whose first part is the one that stayed already has its title there.
  hideParts({ hidden, head: A, segments: [{ provider: 'claude', session: A }], left: [{ session: A, provider: 'claude' }], meta: { title: 'Whole' } });
  showAgain({ hidden, records, titles, session: A });
  assert.equal(titles.get(A), null, 'nothing is written for a chat that kept its first part');
  assert.ok(/showAgain\(\{ hidden: hiddenSessions, records: chatSegments, titles: chatTitles, session \}\)/.test(read('src/main/index.js')), 'main passes the titles on');
});

fs.rmSync(home, { recursive: true, force: true });
console.log(failures.length ? `\n${failures.length} failed: ${failures.join(', ')}` : '\nhandoff-minor-check: all passed');
process.exit(failures.length ? 1 : 0);
