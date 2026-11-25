/* The Board's state: whether it is up, and what the other windows and the CLI
   last said.

   This window's own cards are not kept here. They are the rail's rows, read
   fresh on every render, so the Board and the rail cannot disagree about a
   chat. What this store adds is the reach past the window, which is only
   polled while the Board is on screen, and the publishing of this window's
   cards to main, which goes on all the time so another window's Board can read
   them whenever it asks.

   Same shape as the other stores here: a version counter for
   useSyncExternalStore, and changed() to bump it. */
'use strict';
import { board, cardsFromRail, externalCards, laneOf, needsCount } from '../lib/board.js';
import { grouped, liveKeys, subscribeRail } from './rail-store';

// How often an open Board asks the other windows and the CLI again.
export const POLL_MS = 4000;
// How long the rail has to sit still before this window's cards go to main.
const PUBLISH_AFTER_MS = 300;

const state = {
  open: false,
  peers: [],
  // { ok, list } or { ok: false, unsupported, error }, null before the first answer.
  outside: null,
  // When the last round came back, so the page can say how fresh it is.
  at: 0,
};

const listeners = new Set();
let version = 0;

export const getBoardVersion = () => version;
export const boardState = () => state;

export function subscribeBoard(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function changed() {
  version += 1;
  for (const fn of listeners) fn();
}

const conn = () => window.conn;

// This window's cards, as the rail has them now.
export const localCards = () => cardsFromRail(grouped());

// The Board's lanes from everything known right now.
export function lanesNow(now = Date.now()) {
  const outside = state.outside?.ok ? externalCards(state.outside.list, now) : [];
  return board({ local: localCards(), peers: state.peers, external: outside, now });
}

// What the rail's Board row counts. Only this window's chats: the others are
// not asked while the Board is closed, and a badge that only moves when the
// Board is open would be wrong the rest of the time.
export const needsHere = () => needsCount(board({ local: localCards() }));

// ------------------------------------------------------------ publishing

let publishTimer = 0;
let lastPublished = '';

function publishSoon() {
  if (publishTimer) return;
  publishTimer = setTimeout(() => {
    publishTimer = 0;
    // Only cards that are on a lane. Old history is this window's business,
    // and every other window would otherwise fetch all of it every few seconds.
    const now = Date.now();
    const cards = localCards().filter((c) => laneOf(c, now));
    const body = JSON.stringify(cards);
    if (body === lastPublished) return;
    lastPublished = body;
    conn()?.board?.publish(cards).catch(() => { lastPublished = ''; });
  }, PUBLISH_AFTER_MS);
}

// ------------------------------------------------------------ polling

let pollTimer = 0;
let polling = false;

async function poll() {
  if (polling || !state.open) return;
  polling = true;
  try {
    const [peers, outside] = await Promise.all([
      conn().board.peers().catch(() => []),
      conn().board.outside().catch((e) => ({ ok: false, error: e.message })),
    ]);
    if (!state.open) return;
    state.peers = Array.isArray(peers) ? peers : [];
    state.outside = outside || null;
    state.at = Date.now();
    changed();
  } finally {
    polling = false;
  }
}

function schedule() {
  clearTimeout(pollTimer);
  if (!state.open) return;
  pollTimer = setTimeout(async () => {
    await poll();
    schedule();
  }, POLL_MS);
}

// Asks again now, on top of the timer. The page's refresh button.
export async function refreshBoard() {
  await poll();
  schedule();
}

export function openBoard() {
  if (state.open) return;
  state.open = true;
  changed();
  refreshBoard();
}

export function closeBoard() {
  if (!state.open) return;
  state.open = false;
  clearTimeout(pollTimer);
  changed();
}

export const toggleBoard = () => (state.open ? closeBoard() : openBoard());

// ------------------------------------------------------------ opening a card

/* Brings a card's chat up. Here, the same as a click on its rail row. In
   another window, that window is asked to open it, since a chat is only ever
   driven from the window that holds it. Outside Conn there is nothing to open:
   the page offers what it can instead. */
export async function openCard(card) {
  if (!card) return { error: 'no card' };
  if (card.where === 'peer') {
    return conn().board.openPeer(card.pid, card).catch((e) => ({ error: e.message }));
  }
  if (card.where === 'outside') return { error: 'That session runs outside Conn.' };
  closeBoard();
  return openHere(card);
}

/* The rail opens a live chat by its key and a stored one by its session id.
   A key this window no longer holds, from a card a moment old, falls back to
   the session; a chat with neither has nothing left to open. */
async function openHere({ key, session, project, title, provider }) {
  const live = key && liveKeys().includes(key);
  if (!live && !session) return { error: 'That chat has closed.' };
  await window.connChat?.open({
    ...(live ? { key } : { id: session }),
    project: project || undefined,
    title: title || 'Chat',
    ...(provider && { provider }),
  });
  return { ok: true };
}

// ------------------------------------------------------------ wiring

if (typeof window !== 'undefined' && window.conn?.board) {
  subscribeRail(publishSoon);
  // Another window's Board picked a chat this window holds.
  window.conn.board.onOpen(({ key, session, project, title } = {}) => {
    closeBoard();
    openHere({ key, session, project, title });
  });
  // Once now, so a window that never changes still tells the others it is empty.
  publishSoon();
}
