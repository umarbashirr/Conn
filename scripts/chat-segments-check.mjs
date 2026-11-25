/* A chat that changes agent in place: what is kept on disk about it, how the
   rail folds its sessions into one row, how a switch moves the chat and a
   switch back resumes, and how a reopened chat is put back in order. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { cleanSegments, collapseRows, followers, headOf, priorOf, providerAt, stitch, switchChat } = require('../src/shared/chat-segments.js');

const A = 'aaaaaaaa-1111';
const B = 'bbbbbbbb-2222';
const C = 'cccccccc-3333';

// On disk: two or more segments, each a provider and a session, nothing else.
assert.equal(cleanSegments([{ provider: 'claude', session: A }]), null, 'one segment is an ordinary chat');
assert.equal(cleanSegments('nope'), null);
assert.equal(cleanSegments([{ provider: 'claude', session: A }, { provider: 'codex', session: 'x' }]), null, 'a bad session id drops the record');
assert.equal(cleanSegments([{ provider: 'Claude!', session: A }, { provider: 'codex', session: B }]), null);
assert.deepEqual(
  cleanSegments([{ provider: 'claude', session: A, from: 4, context: 9 }, { provider: 'codex', session: B }]),
  [{ provider: 'claude', session: A }, { provider: 'codex', session: B }],
  'where a segment starts is not kept: it is worked out again on reopen',
);

// The store itself, against a throwaway HOME so nothing real is touched.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-segments-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
const store = require('../src/main/chat-segments.js');
assert.ok(store.FILE.startsWith(home), `the store writes under the throwaway HOME, not ${store.FILE}`);
store.set(A, [{ provider: 'claude', session: A }, { provider: 'codex', session: B }]);
assert.deepEqual(store.get(A), [{ provider: 'claude', session: A }, { provider: 'codex', session: B }]);
assert.throws(() => store.set(A, [{ provider: 'claude', session: A }]), /two or more/);
assert.ok(JSON.parse(fs.readFileSync(store.FILE, 'utf8'))[A]);
store.forget(A);
assert.equal(store.get(A), null);

// The rail: one row per switched chat, under its first session, as new as its newest.
const records = { [A]: [{ provider: 'claude', session: A }, { provider: 'codex', session: B }, { provider: 'claude', session: A }] };
assert.deepEqual([...followers(records)], [[B, A]]);
const rows = [
  { id: C, at: 50, provider: 'claude', title: 'other' },
  { id: B, at: 90, provider: 'codex', title: 'handoff text' },
  { id: A, at: 10, provider: 'claude', title: 'Fix login' },
];
const folded = collapseRows(rows, records);
assert.deepEqual(folded.map((r) => r.id), [A, C], 'the follower is hidden and the head sorts by its newest session');
assert.equal(folded[0].at, 90);
assert.equal(folded[0].title, 'Fix login', 'the head keeps its own title');
assert.deepEqual(folded[0].segments, records[A]);
assert.deepEqual(collapseRows([{ id: B, at: 1 }], records).map((r) => r.id), [B], 'an orphaned follower stays visible');

// Switching in place.
let uid = 0;
const id = () => `h${++uid}`;
const label = (p) => ({ claude: 'Claude', codex: 'ChatGPT', cursor: 'Cursor' }[p] || p);
const typed = (n) => ({ id: `u${n}`, kind: 'user', text: `ask ${n}` });
const reply = (n) => ({ id: `a${n}`, kind: 'assistant', text: `reply ${n}` });

const fresh = { provider: 'claude', session: null, segments: [], items: [typed(0)], usage: {} };
assert.deepEqual(switchChat(fresh, { provider: 'codex', id: 'h0', label }), { ...fresh, provider: 'codex' },
  'a chat no agent answered has nothing to hand over');

let chat = { provider: 'claude', session: A, segments: [], items: [typed(1), reply(1)], usage: { context: 42000 } };
chat = switchChat(chat, { provider: 'codex', model: 'gpt-5.5', id: id(), label });
assert.equal(chat.provider, 'codex');
assert.equal(chat.session, null, 'an agent new to the chat starts a fresh session');
assert.deepEqual(chat.segments.map((s) => [s.provider, s.session, s.from]), [['claude', A, 0], ['codex', null, 2]]);
assert.equal(chat.segments[0].context, 42000, 'how full the left session was is kept for coming back');
assert.deepEqual(chat.items.at(-1), { id: 'h1', kind: 'handoff', from: 'Claude', to: 'ChatGPT', model: 'gpt-5.5', pending: true });
assert.deepEqual(chat.handoff, { since: 0, used: 0, from: 'claude', marker: 'h1' });
assert.equal(headOf(chat), A, 'the chat is still known by its first session');

// Changing your mind before saying anything takes the switch back.
const undone = switchChat(chat, { provider: 'claude', model: 'opus', id: id(), label });
assert.equal(undone.provider, 'claude');
assert.equal(undone.session, A);
assert.deepEqual(undone.segments, []);
assert.equal(undone.handoff, null);
assert.ok(!undone.items.some((it) => it.kind === 'handoff'), 'no row is left for a switch nothing was said on');
const onward = switchChat(chat, { provider: 'cursor', model: 'auto', id: 'hc', label });
assert.deepEqual(onward.segments.map((s) => s.provider), ['claude', 'cursor'], 'trying a third agent replaces the unused one');
assert.equal(onward.items.filter((it) => it.kind === 'handoff').length, 1);
assert.equal(onward.items.at(-1).from, 'Claude');

// Talk on codex, then go back: claude resumes its own session and gets only what it missed.
chat = { ...chat, session: B, segments: chat.segments.map((s, i) => (i === 1 ? { ...s, session: B } : s)), handoff: null,
  items: [...chat.items, typed(2), reply(2)], usage: { context: 7000 } };
assert.equal(providerAt(chat.segments, 1), 'claude');
assert.equal(providerAt(chat.segments, 4), 'codex');
const back = switchChat(chat, { provider: 'claude', model: 'opus', id: 'hb', label });
assert.equal(back.session, A, 'the agent switched back to resumes its own session');
assert.deepEqual(back.segments.map((s) => [s.provider, s.session, s.from]), [['claude', A, 0], ['codex', B, 2], ['claude', A, 5]]);
assert.deepEqual(back.handoff, { since: 2, used: 42000, from: 'codex', marker: 'hb' }, 'it is handed only what came after it left');
assert.deepEqual(priorOf(back.segments, 'codex'), { session: B, since: 5, context: 7000 });
assert.equal(priorOf(back.segments, 'cursor'), null);

// Reopening: each session's replay splits at its handoff rows and the pieces go back in order.
const hand = (n) => ({ id: `x${n}`, kind: 'handoff' });
const read = {
  [A]: [typed(1), reply(1), hand(3), typed(3), reply(3)],
  [B]: [hand(2), typed(2), reply(2)],
};
const segs = [{ provider: 'claude', session: A }, { provider: 'codex', session: B }, { provider: 'claude', session: A }];
const put = stitch(segs, read);
assert.deepEqual(put.items.map((it) => it.id), ['u1', 'a1', 'x2', 'u2', 'a2', 'x3', 'u3', 'a3']);
assert.deepEqual(put.segments.map((s) => s.from), [0, 2, 5]);
assert.deepEqual(stitch(segs, { [A]: read[A] }).items.map((it) => it.id), ['u1', 'a1', 'x3', 'u3', 'a3'],
  'a session that could not be read leaves its stretch out rather than failing the chat');

fs.rmSync(home, { recursive: true, force: true });
console.log('chat-segments-check: ok');
