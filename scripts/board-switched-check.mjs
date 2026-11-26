/* A chat that changed agent on the Board, under plain node. Every path takes
   it as one chat: its card keeps every session and shows the agent it is on
   now, opening it opens all of it here or in another window, none of its
   sessions comes back as another card, and a pipeline stage that changed agent
   is still that stage. Two real bridges on a throwaway HOME stand in for two
   windows. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import './renderer-esm.mjs';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-board-switched-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

const require = createRequire(import.meta.url);
const { cardsFromRail, externalCards, board, laneOf } = await import('../src/renderer/ui/lib/board.js');
const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

const A = 'aaaaaaaa-1111-4000-8000-000000000001';
const B = 'bbbbbbbb-2222-4000-8000-000000000002';
const C = 'cccccccc-3333-4000-8000-000000000003';
const segments = [{ provider: 'claude', session: A, context: 9 }, { provider: 'codex', session: B, cut: 0 }, { provider: 'claude', session: C, cut: 0 }];
const bare = segments.map(({ provider, session }) => ({ provider, session }));
const now = Date.now();
const failures = [];
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`); } catch (e) { failures.push(name); console.log(`FAIL ${name}: ${e.message.split('\n')[0]}`); }
};

// 1. The card carries every session, and every one of them is that card's.
await check('the card keeps every session it ran on', () => {
  const [card] = cardsFromRail([{ dir: '/work/shop', rows: [{ id: A, title: 'Fix login', provider: 'claude', at: now, segments }] }]);
  assert.equal(card.session, A);
  assert.deepEqual(card.segments, bare);
  assert.equal(cardsFromRail([{ dir: '/w', rows: [{ id: B, title: 'plain', at: now }] }])[0].segments, null);
});
await check('a later session of a card is not drawn again as an outside card', () => {
  const [card] = cardsFromRail([{ dir: '/work/shop', rows: [{ id: A, title: 'Fix login', provider: 'claude', at: now, segments }] }]);
  const outside = externalCards([
    { sessionId: C, status: 'working', cwd: '/work/shop', startedAt: now, name: 'claude in conn' },
    { sessionId: 'dddddddd-4444-4000-8000-000000000004', status: 'working', cwd: '/elsewhere', startedAt: now, name: 'a terminal' },
  ], now);
  const all = Object.values(board({ local: [card], external: outside, now })).flat();
  assert.equal(all.filter((c) => c.session === C).length, 0);
  assert.equal(all.filter((c) => c.where === 'outside').length, 1, 'a real outside session still shows');
});
await check('another window\'s card for one of its sessions is the same chat', () => {
  const [card] = cardsFromRail([{ dir: '/work/shop', rows: [{ id: A, title: 'Fix login', provider: 'claude', at: now, segments }] }]);
  const merged = Object.values(board({ local: [card], peers: [{ pid: 9, cards: [{ id: C, session: C, title: 'later part', at: now, provider: 'claude' }] }], now })).flat();
  assert.equal(merged.length, 1, merged.map((c) => `${c.where}:${c.session}`).join(', '));
});
await check('a card keeps its sessions when it crosses windows', () => {
  const { cleanCards } = require('../src/main/board.js');
  assert.deepEqual(cleanCards([{ id: A, session: A, title: 't', segments }])[0].segments, bare);
  assert.equal(cleanCards([{ id: A, session: A, title: 't', segments: [...segments, { provider: 'Bad!', session: 'x' }] }])[0].segments, undefined, 'a malformed list is dropped whole');
});

// 2. Opening a card opens the whole chat, here or in another window.
await check('a session id names the whole chat it belongs to', () => {
  const { recordOf } = require('../src/shared/chat-segments.js');
  const records = { [A]: bare };
  assert.deepEqual(recordOf(records, A), { head: A, segments: bare });
  assert.deepEqual(recordOf(records, C), { head: A, segments: bare }, 'a later session answers with the chat');
  assert.equal(recordOf(records, 'eeeeeeee-5555'), null);
  assert.equal(recordOf(records, ''), null);
});
await check('opening a card in another window sends its sessions, and that window opens it whole', async () => {
  const state = require('../cli/state');
  const { Bridge } = require('../src/main/bridge.js');
  const { createBoard } = require('../src/main/board.js');
  const opened = [];
  const peer = new Bridge({ cwds: [path.join(home, 'p')], board: { cards: () => [], open: (c) => { opened.push(c); return { ok: true }; } } });
  await peer.start();
  try {
    const FAKE_PID = process.ppid;
    for (const f of fs.readdirSync(path.join(home, '.conn', 'projects'))) {
      const file = path.join(home, '.conn', 'projects', f);
      const s = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (s.url === peer.url) fs.writeFileSync(file, JSON.stringify({ ...s, pid: FAKE_PID }));
    }
    assert.ok(state.windows().some((w) => w.pid === FAKE_PID));
    const mine = createBoard({ pid: process.pid });
    assert.deepEqual(await mine.openOn(FAKE_PID, { key: null, session: A, project: '/w', title: 'Fix login', segments }), { ok: true });
    assert.deepEqual(opened.at(-1).segments, bare, 'the sessions go with the open');
    await mine.openOn(FAKE_PID, { key: 'k', session: B, project: '/w', title: 'plain' });
    assert.equal(opened.at(-1).segments, undefined, 'a plain chat sends none');
  } finally {
    await peer.stop?.();
  }
  const main = read('src/main/index.js');
  const relay = main.slice(main.indexOf("send('board:open'") - 400, main.indexOf("send('board:open'") + 500);
  assert.ok(/const segments = cleanSegments\(card\?\.segments\)/.test(relay), 'the receiving main cleans them');
  const store = read('src/renderer/ui/shell/board-store.js');
  assert.ok(/openHere\(\{ key, session, project, title, segments, vetted: true \}\)/.test(store), 'and the window opens it even before its rail lists it');
  assert.ok(/\.\.\.\(segs && \{ segments: segs \}\)/.test(store), 'opening passes the sessions on');
  assert.ok(/agent\.segmentsOf\?\.\(s\.id\)/.test(read('src/renderer/ui/useAgent.js')), 'and open() looks a bare id up');
});

fs.rmSync(home, { recursive: true, force: true });
console.log(failures.length ? `\n${failures.length} failed: ${failures.join(', ')}` : '\nboard-switched-check: all passed');
process.exit(failures.length ? 1 : 0);
