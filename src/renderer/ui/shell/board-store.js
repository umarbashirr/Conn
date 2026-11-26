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
import { grouped, isDone, liveKeys, subscribeRail } from './rail-store';
import { toast } from './toast';
import { gatedChats, loadRuns, stageOfChat, subscribeRuns } from './pipeline-store';

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

/* This window's cards, as the rail has them now, each marked with the
   pipeline it belongs to and whether a run is waiting on you in it. */
export function localCards() {
  const gates = gatedChats();
  return cardsFromRail(grouped(), { isDone }).map((c) => {
    if (!c.key) return c;
    const pipeline = stageOfChat(c.key);
    if (!pipeline) return c;
    return { ...c, pipeline: { name: pipeline.name, stage: pipeline.stage }, gate: gates.has(c.key) };
  });
}

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
let askingPeers = false;
let askingCli = false;

/* The other windows and the CLI are asked apart, each with its own one
   request in flight, and each answer is drawn when it lands. A CLI that hangs
   for its whole timeout must not hold up what the other windows say. */
function askPeers() {
  if (askingPeers || !state.open) return Promise.resolve();
  askingPeers = true;
  return conn().board.peers().catch(() => []).then((peers) => {
    if (!state.open) return;
    state.peers = Array.isArray(peers) ? peers : [];
    state.at = Date.now();
    changed();
  }).finally(() => { askingPeers = false; });
}

function askCli() {
  if (askingCli || !state.open) return Promise.resolve();
  askingCli = true;
  return conn().board.outside().catch((e) => ({ ok: false, error: e.message })).then((outside) => {
    if (!state.open) return;
    state.outside = outside || null;
    changed();
  }).finally(() => { askingCli = false; });
}

function poll() {
  askCli();
  return askPeers();
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
  // A run another window let go of since this one started is picked up here.
  loadRuns();
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
  const res = await openHere(card);
  if (!res?.error) closeBoard();
  return res;
}

/* The rail opens a live chat by its key and a stored one by its session id.
   A key this window no longer holds, from a card a moment old, falls back to
   the session; a chat with neither has nothing left to open. */
// `vetted` is for a chat another window's Board asked this one to open: main
// has checked its folder is open here, and a switched chat comes with its
// sessions, so it opens whole even before this rail has listed it.
async function openHere({ key, session, project, title, provider, segments, vetted = false }) {
  const live = key && liveKeys().includes(key);
  // A saved chat has to be one the rail can see: in a folder this window has
  // open, on disk. Anything else would open as an empty chat with an error.
  const row = !live && session ? grouped().flatMap((g) => g.rows.concat(g.done || [])).find((r) => r.id === session) : null;
  if (!live && !row && !(vetted && session)) return { error: 'That chat is not open in this window any more.' };
  // A chat that changed agent opens whole, as the rail opens it, on the agent
  // it was last on. The rail's row knows its sessions even when the card,
  // from another window, does not.
  const segs = row?.segments?.length > 1 ? row.segments : segments?.length > 1 ? segments : null;
  await window.connChat?.open({
    ...(live ? { key } : { id: session }),
    project: project || undefined,
    title: title || 'Chat',
    ...((row?.provider || provider) && { provider: row?.provider || provider }),
    ...(segs && { segments: segs }),
  });
  return { ok: true };
}

// ------------------------------------------------------------ wiring

if (typeof window !== 'undefined' && window.conn?.board) {
  subscribeRail(publishSoon);
  // A gate opening or closing moves a card without the rail moving.
  subscribeRuns(() => { publishSoon(); changed(); });
  // Another window's Board picked a chat this window holds.
  window.conn.board.onOpen(async ({ key, session, project, title, segments } = {}) => {
    const res = await openHere({ key, session, project, title, segments, vetted: true });
    if (res?.error) toast('Could not open that chat', res.error);
    else closeBoard();
  });
  // Once now, so a window that never changes still tells the others it is empty.
  publishSoon();
}
