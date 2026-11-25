/* The Board's logic in plain node: which lane a chat lands in, how this
   window's cards merge with other windows' and the CLI's, and the main-process
   half that reads other windows over their bridges and runs
   `claude agents --json`. Two real bridges on a throwaway HOME stand in for two
   windows, and a fake claude binary stands in for the CLI. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import './renderer-esm.mjs';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-board-check-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

const require = createRequire(import.meta.url);
const { LANES, RECENT_MS, laneOf, lineOf, placeOf, cardsFromRail, externalCards, board, lastTurnFailed, needsCount } = await import('../src/renderer/ui/lib/board.js');
const { createBoard, cleanCards, parseList } = require('../src/main/board.js');
const { Bridge } = require('../src/main/bridge.js');
const state = require('../cli/state.js');

const NOW = 1_800_000_000_000;
const card = (extra) => ({ id: 's1', key: 'c1', session: 's1', title: 'A chat', project: '/w/shop', at: NOW - 1000, ...extra });

// ------------------------------------------------------------------ lanes

assert.deepEqual(LANES.map((l) => l.id), ['needs', 'working', 'done', 'recent'], 'four lanes, in the order they are drawn');
assert.equal(laneOf(card({ waiting: true, busy: true }), NOW), 'needs', 'a waiting card needs you even mid-turn');
assert.equal(laneOf(card({ activity: { state: 'waiting', line: 'Wants to edit a.js' } }), NOW), 'needs', 'a waiting activity needs you');
assert.equal(laneOf(card({ activity: { state: 'finished' }, failed: true }), NOW), 'needs', 'a failed turn you have not seen needs you');
assert.equal(laneOf(card({ busy: true }), NOW), 'working', 'a running turn is working');
assert.equal(laneOf(card({ agents: 2 }), NOW), 'working', 'a subagent still running keeps it working after the turn');
assert.equal(laneOf(card({ shells: 1 }), NOW), 'working', 'a background shell keeps it working');
assert.equal(laneOf(card({ activity: { state: 'finished' } }), NOW), 'done', 'a turn that ended unseen is done');
assert.equal(laneOf(card({}), NOW), 'recent', 'an idle chat from the last day is recent');
assert.equal(laneOf(card({ at: NOW - RECENT_MS - 1 }), NOW), null, 'an idle chat older than a day is on no lane');
assert.equal(laneOf(card({ failed: true }), NOW), 'recent', 'a failure already looked at does not need you again');
assert.equal(laneOf(null, NOW), null, 'nothing is on no lane');

assert.equal(lineOf(card({ activity: { state: 'working', line: 'Editing a.js' } })), 'Editing a.js', 'the live activity is the line');
assert.equal(lineOf(card({ agents: 1 })), '1 agent running', 'one agent');
assert.equal(lineOf(card({ agents: 3 })), '3 agents running', 'agents counted');
assert.equal(lineOf(card({ activity: { state: 'idle' } })), '', 'an idle chat has no line');

assert.deepEqual(placeOf('/home/me/shop'), { name: 'shop', worktree: null }, 'a plain folder');
assert.deepEqual(placeOf('/home/me/shop/.claude/worktrees/fix-coupon'), { name: 'shop', worktree: 'fix-coupon' }, 'a worktree is named under its repository');
assert.deepEqual(placeOf('C:\\code\\shop\\.claude\\worktrees\\wt1'), { name: 'shop', worktree: 'wt1' }, 'a Windows worktree too');

assert.equal(lastTurnFailed([{ kind: 'user' }, { kind: 'note', ended: true, error: true }]), true, 'the last turn failed');
assert.equal(lastTurnFailed([{ kind: 'note', ended: true, error: true }, { kind: 'user' }]), false, 'a new message starts a new turn');
assert.equal(lastTurnFailed([{ kind: 'note', ended: true, error: false }]), false, 'a clean end');
assert.equal(lastTurnFailed([]), false, 'no turn at all');

{
  const groups = [{ dir: '/w/shop', rows: [{ id: 's1', key: 'c1', title: 'Open', at: 5, busy: true }], done: [{ id: 's2', title: 'Put away', at: 9 }] }];
  const cards = cardsFromRail(groups);
  assert.deepEqual(cards.map((c) => c.id), ['s1'], 'a chat marked completed stays off the Board');
  assert.equal(cards[0].project, '/w/shop', 'a row with no folder of its own takes its group\'s');
  assert.equal(cards[0].session, 's1', 'a saved chat carries its session');
  const pinnedDone = [{ dir: '/w', rows: [{ id: 'p1', title: 'Pinned, done' }, { id: 'p2', title: 'Done but waiting', waiting: true }, { id: 'p3', title: 'Open' }] }];
  assert.deepEqual(cardsFromRail(pinnedDone, { isDone: (r) => r.id !== 'p3' }).map((c) => c.id), ['p2', 'p3'],
    'a completed chat the rail keeps open (a pin) is off the Board too, unless it is waiting on you');
  const fresh = cardsFromRail([{ dir: '/w', rows: [{ id: 'c9', key: 'c9', title: 'New' }] }]);
  assert.equal(fresh[0].session, null, 'a chat not written yet has no session, only its key');
}

// ------------------------------------------------------------------ outside sessions

{
  const list = [
    { id: 'a1', sessionId: 'x1', name: 'fix flaky test', cwd: '/w/api', kind: 'background', state: 'blocked', startedAt: NOW - 5000 },
    { pid: 4, sessionId: 'x2', name: 'refactor', cwd: '/w/web', kind: 'interactive', status: 'busy', startedAt: NOW - 4000 },
    { id: 'a3', sessionId: 'x3', cwd: '/w/web', kind: 'background', state: 'completed', startedAt: NOW - 3000 },
    { id: 'a4', sessionId: 'x4', kind: 'background', state: 'something-new', startedAt: NOW - 2000 },
    { id: 'junk' },
    null,
    'nope',
  ];
  const ext = externalCards(list, NOW);
  assert.deepEqual(ext.map((c) => c.session), ['x1', 'x2', 'x3', 'x4'], 'rows without a session id are dropped');
  assert.deepEqual(ext.map((c) => c.lane), ['needs', 'working', 'done', 'recent'], 'blocked needs you, busy works, completed is done, the unknown is recent');
  assert.equal(ext[0].short, 'a1', 'a background session keeps the id claude attach takes');
  assert.equal(ext[1].kind, 'interactive', 'a terminal session says so');
  assert.equal(ext[2].title, 'Claude Code session', 'an unnamed session gets a name');
  assert.equal(ext[0].state, 'Blocked in the background', 'the state reads as a line');
  assert.deepEqual(externalCards({ not: 'a list' }), [], 'anything but a list is nothing');
  assert.equal(ext[3].at, NOW - 2000, 'when it started is kept');
  assert.equal(externalCards([{ sessionId: 'n', kind: 'background', state: 'working' }], NOW)[0].at, 0, 'a session that does not say when it started is not made to look new');
  const aged = board({ external: externalCards([
    { sessionId: 'old-done', state: 'completed', kind: 'background', startedAt: NOW - RECENT_MS - 5 },
    { sessionId: 'old-busy', status: 'busy', kind: 'interactive', startedAt: NOW - RECENT_MS - 5 },
    { sessionId: 'no-time', state: 'completed', kind: 'background' },
  ], NOW), now: NOW });
  assert.deepEqual(aged.done, [], 'a session that finished over a day ago, or never said when, is history');
  assert.deepEqual(aged.working.map((c) => c.session), ['old-busy'], 'one still working is work, however long it has run');
}

// ------------------------------------------------------------------ merging

{
  const local = [
    card({ id: 's1', key: 'c1', session: 's1', waiting: true, at: NOW - 3000 }),
    // The verify stand-in gives every chat one session id. The window's own
    // rows are distinct chats all the same, and none may swallow another.
    card({ id: 's1', key: 'c2', session: 's1', busy: true, at: NOW - 2000 }),
    card({ id: 'c3', key: 'c3', session: null, activity: { state: 'finished' }, at: NOW - 1000 }),
  ];
  const peers = [{ pid: 77, cards: [
    card({ id: 's1', key: 'p1', session: 's1', busy: true }), // the same session as a local chat: drawn once, here
    card({ id: 'p2', key: 'p2', session: 'p2', waiting: true, at: NOW - 500 }),
  ] }];
  const external = [
    { session: 'p2', id: 'p2', lane: 'working', at: NOW }, // open in a peer window
    { session: 'x9', id: 'x9', lane: 'working', at: NOW - 100 },
    { session: 'x8', id: 'x8', lane: 'recent', at: NOW - RECENT_MS - 10 },
  ];
  const lanes = board({ local, peers, external, now: NOW });
  assert.deepEqual(lanes.needs.map((c) => `${c.where}:${c.key || c.id}`), ['peer:p2', 'here:c1'], 'needs you, newest first, from both windows');
  assert.deepEqual(lanes.working.map((c) => `${c.where}:${c.key || c.id}`), ['outside:x9', 'here:c2'], 'a session open here is not drawn again for the other window or the CLI');
  assert.deepEqual(lanes.done.map((c) => c.key), ['c3'], 'done');
  assert.equal(lanes.recent.length, 0, 'an outside session quiet for over a day is left off');
  assert.equal(lanes.needs.find((c) => c.where === 'peer').pid, 77, 'a peer card knows which window holds it');
  assert.equal(needsCount(lanes), 2, 'the badge counts what needs you');
  const untitled = board({ peers: [{ pid: 1, cards: [{ id: 'u', key: 'u', session: 'u', waiting: true }] }], now: NOW });
  assert.equal(untitled.needs[0].title, 'Untitled chat', 'a peer card with no title gets one');
}

// ------------------------------------------------------------------ main: cleaning and parsing

{
  const [c] = cleanCards([{ id: 'a', title: 'x'.repeat(900), evil: 'drop me', busy: 'yes', at: 5, activity: { state: 'working', line: 'Editing', extra: 1 }, pipeline: { name: 'Feature', stage: 'Plan', run: 9 } }]);
  assert.equal(c.title.length, 500, 'strings are capped');
  assert.equal(c.evil, undefined, 'unknown fields are dropped');
  assert.equal(c.busy, undefined, 'a field of the wrong type is dropped');
  assert.deepEqual(c.activity, { state: 'working', line: 'Editing' }, 'activity keeps its two fields');
  assert.deepEqual(c.pipeline, { name: 'Feature', stage: 'Plan' }, 'pipeline keeps its two fields');
  assert.deepEqual(cleanCards([{ title: 'no id' }, null, 7]), [], 'a card without an id is not a card');
  assert.deepEqual(cleanCards('nope'), [], 'anything but a list is nothing');
  assert.equal(cleanCards(Array.from({ length: 500 }, (_, i) => ({ id: String(i) }))).length, 200, 'one window sends at most 200 cards');
  assert.deepEqual(cleanCards([{ id: 'a', key: 'k', title: 'A' }, { id: 'b', key: 'k', title: 'B' }, { id: 'a', title: 'C' }, { id: 'a', title: 'D' }]).map((c) => c.title), ['A', 'C'],
    'a chat is one card: a repeated key, or id where there is no key, is dropped');
}

assert.deepEqual(parseList('[{"sessionId":"a"}]', 0), { ok: true, list: [{ sessionId: 'a' }] }, 'a list parses');
assert.equal(parseList('{"a":1}', 0).ok, false, 'an object is not a list');
assert.equal(parseList('not json', 0).ok, false, 'garbage is not a list');
assert.equal(parseList('', 1, "error: unknown command 'agents'").unsupported, true, 'a CLI without the command is unsupported, not an error');
assert.equal(parseList('', 1, 'Not logged in').unsupported, false, 'any other failure is an error');

// ------------------------------------------------------------------ main: two windows over their bridges

const opened = [];
const a = new Bridge({ cwds: [path.join(home, 'a')], board: { cards: () => [], open: () => ({ ok: true }) } });
const b = new Bridge({
  cwds: [path.join(home, 'b1'), path.join(home, 'b2')],
  board: {
    cards: () => [{ id: 'sb', key: 'kb', session: 'sb', title: 'In window B', project: '/w/b1', waiting: true, at: NOW, secret: 'x' }],
    open: (c) => { opened.push(c); return c.key === 'gone' ? { error: 'That chat is not open in that window any more.' } : { ok: true }; },
  },
});
try {
  await a.start();
  await b.start();
  // Both run in this process, so they share a pid. Give B its own the way a
  // second window would have one.
  const FAKE_PID = process.ppid;
  for (const f of fs.readdirSync(path.join(home, '.conn', 'projects'))) {
    const file = path.join(home, '.conn', 'projects', f);
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (s.url === b.url) fs.writeFileSync(file, JSON.stringify({ ...s, pid: FAKE_PID }));
  }
  // A window that crashed left its file behind.
  fs.writeFileSync(path.join(home, '.conn', 'projects', 'dead.json'), JSON.stringify({ url: 'http://127.0.0.1:1', token: 't', pid: 999999999, cwds: ['/gone'] }));

  const wins = state.windows();
  assert.equal(wins.length, 2, `two live windows, each once, the dead one skipped: ${JSON.stringify(wins)}`);
  assert.deepEqual(wins.find((w) => w.pid === FAKE_PID).cwds.sort(), [path.join(home, 'b1'), path.join(home, 'b2')].sort(), 'a window lists every folder it has open');

  const mine = createBoard({ pid: process.pid });
  const peers = await mine.peers();
  assert.equal(peers.length, 1, 'only the other window is a peer');
  assert.equal(peers[0].pid, FAKE_PID, 'the peer is window B');
  assert.deepEqual(peers[0].cards.map((c) => c.title), ['In window B'], 'its cards come over the bridge');
  assert.equal(peers[0].cards[0].secret, undefined, 'and are cleaned on the way in');

  const res = await mine.openOn(FAKE_PID, { ...peers[0].cards[0], busy: true });
  assert.deepEqual(res, { ok: true }, 'opening a card in another window is answered');
  assert.deepEqual(opened, [{ key: 'kb', session: 'sb', project: '/w/b1', title: 'In window B' }], 'that window is told only how to find the chat');
  assert.equal((await mine.openOn(123, {})).error, 'That window has closed.', 'a window that has gone says so');
  assert.equal((await mine.openOn(FAKE_PID, { key: 'gone' })).error, 'That chat is not open in that window any more.', 'a window that no longer holds the chat says so');

  const bad = await fetch(`${b.url}/board`, { headers: { 'x-conn-token': 'wrong' } });
  assert.equal(bad.status, 401, 'the board route needs the token like every other');
  assert.equal((await fetch(`${b.url}/board/open`, { method: 'POST', headers: { 'x-conn-token': b.token }, body: 'x'.repeat(20000) })).status, 413, 'an oversized open is refused');
} finally {
  await a.stop?.();
  await b.stop?.();
}

// ------------------------------------------------------------------ main: the CLI's own list

{
  const bin = path.join(home, 'fake-claude.js');
  const count = path.join(home, 'calls');
  fs.writeFileSync(bin, `
    require('fs').appendFileSync(${JSON.stringify(count)}, 'x');
    if (process.argv[2] !== 'agents' || process.argv[3] !== '--json') { console.error('bad args'); process.exit(2); }
    console.log(JSON.stringify([{ id: 'a1', sessionId: 'x1', kind: 'background', state: 'working', cwd: '/w' }]));
  `);
  const cli = createBoard({ claudeBin: () => bin });
  const first = await cli.outside();
  assert.deepEqual(first, { ok: true, list: [{ id: 'a1', sessionId: 'x1', kind: 'background', state: 'working', cwd: '/w' }] }, 'the CLI list is read');
  const [again, twice] = await Promise.all([cli.outside(), cli.outside()]);
  assert.deepEqual(again, first, 'a second ask inside the window reuses the answer');
  assert.equal(twice, again, 'concurrent asks share one');
  assert.equal(fs.readFileSync(count, 'utf8').length, 1, 'the CLI ran once');

  const old = path.join(home, 'old-claude.js');
  fs.writeFileSync(old, `console.error("error: unknown command 'agents'"); process.exit(1);`);
  const before = await createBoard({ claudeBin: () => old }).outside();
  assert.equal(before.ok, false, 'an old CLI is not ok');
  assert.equal(before.unsupported, true, 'and is unsupported, which hides the section');
  assert.equal((await createBoard({ claudeBin: () => null }).outside()).unsupported, true, 'no claude at all is unsupported too');
}

fs.rmSync(home, { recursive: true, force: true });
console.log('board-check: all passed');
