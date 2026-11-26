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

fs.rmSync(home, { recursive: true, force: true });
console.log(failures.length ? `\n${failures.length} failed: ${failures.join(', ')}` : '\nboard-switched-check: all passed');
process.exit(failures.length ? 1 : 0);
