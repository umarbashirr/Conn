/* The Board with a chat that changed agent. Plain node, against the Board's
   own pure functions. Cases that fail here are bugs, kept failing on purpose.

   - A switched chat is one card, and the card carries what opening it needs:
     its run of sessions, so the chat opens whole rather than as its first.
   - The chat's newer session, running as Claude, is not drawn a second time
     as a Claude Code session "outside Conn". */
import assert from 'node:assert/strict';
import './renderer-esm.mjs';

const { cardsFromRail, externalCards, board } = await import('../src/renderer/ui/lib/board.js');

const failures = [];
const check = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); } catch (e) { failures.push(name); console.log(`FAIL ${name}: ${e.message.split('\n')[0]}`); }
};

const now = Date.now();
const HEAD = 'aaaaaaaa-0000-4000-8000-000000000001';
const FOLLOWER = 'bbbbbbbb-0000-4000-8000-000000000002';
// The rail's row for a chat that went Codex -> Claude: one row under its first
// session, with the run of sessions on it (collapseRows in shared/chat-segments).
const segments = [{ provider: 'codex', session: HEAD }, { provider: 'claude', session: FOLLOWER }];
const groups = [{ dir: '/work/shop', rows: [{ id: HEAD, title: 'Fix login', provider: 'codex', at: now - 1000, segments }] }];

check('a switched chat is one card', () => {
  assert.equal(cardsFromRail(groups).length, 1);
});

check('the card carries the chat\'s sessions, so opening it opens every stretch', () => {
  const [card] = cardsFromRail(groups);
  assert.deepEqual(card.segments, segments, `the card has ${JSON.stringify(card.segments)}; board-store openHere then opens { id: head } alone`);
});

check('the card names the agent the chat is on now', () => {
  const [card] = cardsFromRail(groups);
  assert.equal(card.provider, 'claude', `the card says ${card.provider}, the chat's first agent`);
});

check('the chat\'s newer Claude session is not a second card outside Conn', () => {
  const local = cardsFromRail(groups);
  const external = externalCards([{ sessionId: FOLLOWER, kind: 'interactive', name: 'Fix login', cwd: '/work/shop', startedAt: now - 500, status: 'busy' }], now);
  const lanes = board({ local, external, now });
  const all = Object.values(lanes).flat();
  const forChat = all.filter((c) => c.id === HEAD || c.session === FOLLOWER);
  assert.equal(forChat.length, 1, `drawn ${forChat.length} times: ${JSON.stringify(forChat.map((c) => [c.where, c.session]))}`);
});

console.log(failures.length ? `\n${failures.length} failed: ${failures.join(', ')}` : '\nall passed');
process.exit(failures.length ? 1 : 0);
