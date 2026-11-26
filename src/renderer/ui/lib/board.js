/* What the Board draws: every chat in every window, and the Claude Code
   sessions running outside Conn, sorted into the lane that says what each one
   wants from you.

   Pure functions over plain rows, so the lane a chat lands in is decided in one
   place and a check under plain node can hold it. The rows come from the rail
   store (this window), from other windows over their bridges, and from
   `claude agents --json`. */

export const LANES = Object.freeze([
  { id: 'needs', label: 'Needs you', empty: 'Nothing is waiting on you.' },
  { id: 'working', label: 'Working', empty: 'No agent is running.' },
  { id: 'done', label: 'Done', empty: 'Finished turns you have not read land here.' },
  { id: 'recent', label: 'Recent', empty: 'Chats from the last day land here.' },
]);

// How far back an idle chat still counts as recent.
export const RECENT_MS = 24 * 60 * 60 * 1000;
// Past this, a lane shows the newest and says how many more there are.
export const RECENT_SHOWN = 12;

const WORKTREE = /[\\/]\.claude[\\/]worktrees[\\/]([^\\/]+)[\\/]?$/;

export const folderName = (dir) => String(dir || '').split(/[/\\]/).filter(Boolean).pop() || String(dir || '');

/* A folder Conn or claude cut as a worktree is named by the worktree, with the
   repository it came from beside it, because "board" on its own does not say
   which project it is a branch of. */
export function placeOf(dir) {
  const m = String(dir || '').match(WORKTREE);
  if (!m) return { name: folderName(dir), worktree: null };
  const repo = String(dir).slice(0, m.index);
  return { name: folderName(repo), worktree: m[1] };
}

/**
 * The lane one card belongs in, or null when it belongs on no lane at all.
 *
 * @param {object} card
 * @param {number} now
 */
export function laneOf(card, now = Date.now()) {
  if (!card) return null;
  const state = card.activity?.state;
  if (card.waiting || state === 'waiting') return 'needs';
  // A pipeline stopped at a gate is waiting on you in this chat, turn over or not.
  if (card.gate && !card.busy) return 'needs';
  if (state === 'finished' && card.failed) return 'needs';
  if (card.busy || card.agents || card.shells || state === 'working') return 'working';
  if (state === 'finished') return 'done';
  if (card.at && now - card.at <= RECENT_MS) return 'recent';
  return null;
}

/* The line under a card's title: what it is doing, waiting on, or did. A live
   chat's activity says it best. A row that is only on disk has nothing to say
   beyond when it moved, and the card shows that already. */
export function lineOf(card) {
  const a = card.activity;
  if (card.gate && !card.busy && a?.state !== 'waiting') return 'Ready for you: read it, then Continue';
  if (a && a.state !== 'idle' && a.line) return a.line;
  if (card.waiting) return 'Waiting for your answer';
  if (card.agents) return `${card.agents} ${card.agents === 1 ? 'agent' : 'agents'} running`;
  if (card.shells) return `${card.shells} running in the background`;
  if (card.busy) return 'Working';
  if (card.state) return card.state;
  return '';
}

/**
 * Cards for this window, out of the rail's grouped rows. Each row already
 * carries its live half when the chat is open here. A chat you marked
 * completed is in the folder's `done` fold and stays off the Board: you put it
 * away, and the rail never folds one that is still working.
 *
 * A pinned chat stays in the rail's open list when it is marked completed, so
 * `isDone` is asked too: a completed chat is off the Board unless it is still
 * doing something or waiting on you.
 *
 * @param {{ dir: string, rows: object[] }[]} groups
 * @param {{ isDone?: (row: object) => boolean }} [opts]
 */
export function cardsFromRail(groups, { isDone = () => false } = {}) {
  const out = [];
  for (const g of groups || []) {
    for (const row of g.rows || []) {
      const live = row.busy || row.waiting || row.agents || row.shells;
      if (isDone(row) && !live) continue;
      out.push({
        id: row.id,
        key: row.key || null,
        session: row.key && row.id === row.key ? null : row.id,
        title: row.title || 'Untitled chat',
        project: row.project || g.dir,
        provider: row.provider || null,
        at: row.at || 0,
        busy: !!row.busy,
        waiting: !!row.waiting,
        agents: row.agents || 0,
        shells: row.shells || 0,
        failed: !!row.failed,
        gate: !!row.gate,
        activity: row.activity || null,
        pipeline: row.pipeline || null,
        // A chat that changed agent: every session it ran on, first one first.
        // Opening the card opens all of it, and none of them is an outside card.
        segments: row.segments?.length > 1 ? row.segments.map(({ provider, session }) => ({ provider, session })) : null,
      });
    }
  }
  return out;
}

const STATE = {
  // Background sessions say `state`, interactive ones say `status`.
  blocked: 'needs',
  waiting: 'needs',
  needs_input: 'needs',
  'needs-input': 'needs',
  failed: 'needs',
  working: 'working',
  busy: 'working',
  running: 'working',
  completed: 'done',
  idle: 'recent',
  stopped: 'recent',
};

/* One card per Claude Code session the CLI knows about, from the array
   `claude agents --json` prints. Anything that is not that shape is dropped
   rather than guessed at: the command is a research preview and may change. */
export function externalCards(list, now = Date.now()) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const s of list) {
    if (!s || typeof s !== 'object' || typeof s.sessionId !== 'string' || !s.sessionId) continue;
    const said = String(s.state || s.status || '').toLowerCase();
    const lane = STATE[said] || 'recent';
    out.push({
      id: s.sessionId,
      session: s.sessionId,
      key: null,
      external: true,
      kind: s.kind === 'background' ? 'background' : 'interactive',
      short: typeof s.id === 'string' ? s.id : null,
      title: typeof s.name === 'string' && s.name.trim() ? s.name.trim() : 'Claude Code session',
      project: typeof s.cwd === 'string' ? s.cwd : '',
      provider: 'claude',
      at: Number(s.startedAt) || 0,
      lane,
      state: said ? `${said[0].toUpperCase()}${said.slice(1)} in ${s.kind === 'background' ? 'the background' : 'a terminal'}` : '',
      failed: said === 'failed',
    });
  }
  return out;
}

/**
 * Everything on the Board, merged: this window first, then each other window,
 * then outside sessions. A session that is open in a window is that window's
 * card, so it is never drawn twice. Within one window every row is its own
 * chat, so the window's cards are never merged with each other: two chats can
 * briefly share a session id while one is forked from the other.
 *
 * @param {{ local: object[], peers?: { pid: number, cards: object[] }[], external?: object[], now?: number }} input
 */
export function board({ local = [], peers = [], external = [], now = Date.now() }) {
  const lanes = Object.fromEntries(LANES.map((l) => [l.id, []]));
  const held = new Set();
  // Every session a card's chat ran on is that card's, so a switched chat's
  // later Claude session is never drawn again as an outside one.
  const hold = (cards) => {
    for (const c of cards) {
      if (c.session) held.add(c.session);
      for (const x of c.segments || []) if (x?.session) held.add(x.session);
    }
  };
  const place = (card, lane) => { if (lane) lanes[lane].push(card); };

  for (const c of local) place({ ...c, where: 'here' }, laneOf(c, now));
  hold(local);
  for (const p of peers) {
    const cards = (p.cards || []).filter((c) => !(c.session && held.has(c.session)) && !(c.segments || []).some((x) => held.has(x?.session)));
    for (const c of cards) place({ ...c, title: c.title || 'Untitled chat', where: 'peer', pid: p.pid }, laneOf(c, now));
    hold(cards);
  }
  for (const c of external) {
    if (held.has(c.session)) continue;
    // An outside session that finished or went quiet more than a day ago is
    // history, not work. One that does not say when it started counts as old.
    const old = now - (c.at || 0) > RECENT_MS;
    const lane = old && (c.lane === 'recent' || c.lane === 'done') ? null : c.lane;
    place({ ...c, where: 'outside' }, lane);
  }

  // The newest movement first in every lane, so the top card is the freshest.
  for (const id of Object.keys(lanes)) lanes[id].sort((a, b) => (b.at || 0) - (a.at || 0));
  return lanes;
}

// How many cards need you, for the rail's badge.
export const needsCount = (lanes) => lanes?.needs?.length || 0;

/* Whether a chat's last turn ended in an error. The turn's end is the note
   useAgent pushes when the result arrives; a later message starts a new turn,
   so only the newest ended note counts. */
export function lastTurnFailed(items) {
  for (let i = (items || []).length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === 'user') return false;
    if (it.kind === 'note' && it.ended) return !!it.error;
  }
  return false;
}
