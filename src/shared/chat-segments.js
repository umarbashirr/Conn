'use strict';
/* One chat across several agents.

   A chat switched to another agent keeps its place in the rail and its
   transcript on screen, but underneath it is a run of sessions, one per stretch
   on one agent: `segments`, oldest first, each { provider, session, from }.
   `from` is the index into the chat's items where that stretch began (its
   handoff row, for every segment after the first), so it is only meaningful
   in a chat that is open; on disk a segment is just which agent and which
   session.

   The first segment's session is the chat's name for life. Titles, pins, the
   completed mark and the board are all keyed on it, and the rail shows that
   row and hides the rest. An agent switched back to resumes its own session,
   so one session can hold several segments; each one after its first begins
   at the message that carried the handoff. */

const SESSION = /^[A-Za-z0-9_-]{8,128}$/;
const PROVIDER = /^[a-z][a-z0-9-]{1,31}$/;

// What may be kept on disk: two or more segments with a session each, and how
// full each one's window was when the chat left it, so an agent returned to
// after a restart is still handed no more than it has room for. One segment is
// an ordinary chat and needs no record.
function cleanSegments(v) {
  if (!Array.isArray(v) || v.length < 2) return null;
  const out = [];
  for (const s of v) {
    if (!s || !PROVIDER.test(String(s.provider || '')) || !SESSION.test(String(s.session || ''))) return null;
    const context = Number.isFinite(s.context) && s.context > 0 ? Math.round(s.context) : 0;
    out.push({ provider: s.provider, session: s.session, ...(context && { context }) });
  }
  return out;
}

/* The part of a live chat's segments worth writing down: only those that got a
   session, since a send that never reached its agent left nothing on disk to
   point at, with neighbours on the same session run together. Null when that
   leaves an ordinary one-session chat. */
function persistable(segments) {
  const out = [];
  for (const s of segments || []) {
    if (!s.session) continue;
    const row = { provider: s.provider, session: s.session, ...(s.context > 0 && { context: s.context }) };
    if (out.at(-1)?.session === s.session) out[out.length - 1] = row;
    else out.push(row);
  }
  return out.length > 1 ? out : null;
}

// session id -> the head session of the chat it belongs to, for every session
// that is not itself a head.
function followers(records) {
  const out = new Map();
  for (const [head, segs] of Object.entries(records || {})) {
    for (const s of segs || []) if (s.session !== head) out.set(s.session, head);
  }
  return out;
}

/* Rail rows with each switched chat folded into its head row. The head takes
   the newest time of any of its sessions, so a chat busy on its second agent
   sorts where it should. A follower whose head is gone from the list stays: an
   orphan is still a chat someone had, and hiding it would lose it. */
function collapseRows(rows, records) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const hidden = new Set();
  const heads = new Map();
  for (const [head, segs] of Object.entries(records || {})) {
    const row = byId.get(head);
    if (!row) continue;
    let at = row.at || 0;
    for (const s of segs) {
      if (s.session === head) continue;
      const other = byId.get(s.session);
      if (!other) continue;
      hidden.add(s.session);
      at = Math.max(at, other.at || 0);
    }
    heads.set(head, { ...row, at, segments: segs });
  }
  return rows
    .filter((r) => !hidden.has(r.id))
    .map((r) => heads.get(r.id) || r)
    .sort((a, b) => (b.at || 0) - (a.at || 0));
}

/* Search hits with each switched chat answering once, under its first session,
   so opening a hit opens the whole chat. Hits come newest first and the first
   one for a chat is kept. A part left behind by a delete is not a chat. */
function foldHits(hits, { records = {}, hidden = {}, titleOf = () => null } = {}) {
  const heads = followers(records);
  const out = new Map();
  for (const h of hits) {
    if (hidden[h.id]) continue;
    const head = heads.get(h.id);
    const id = head || h.id;
    if (out.has(id)) continue;
    const segments = records[id];
    out.set(id, head
      ? { ...h, id, provider: segments[0].provider, title: titleOf(id) || h.title, segments }
      : { ...h, ...(segments && { segments }) });
  }
  return [...out.values()];
}

// The provider running at item index `i`.
function providerAt(segments, i) {
  let p = segments[0]?.provider || null;
  for (const s of segments) if (s.from <= i) p = s.provider;
  return p;
}

/* Where `provider` stopped seeing this chat, and the session to resume it on:
   the end of its last segment before the current one. Null for an agent that
   has never been in the chat, which gets the whole of it. A segment whose
   first send never reached its agent does not count as having seen it. */
function priorOf(segments, provider) {
  for (let j = segments.length - 2; j >= 0; j--) {
    if (segments[j].provider === provider && segments[j].session) {
      return { session: segments[j].session, since: segments[j + 1].from, context: segments[j].context || 0 };
    }
  }
  return null;
}

/* A reopened chat's items, put back in the order they happened. `read` holds
   one replayed transcript per distinct session, keyed by session id. Replay
   draws a handoff row ahead of every message that carried one, so each
   session splits at those rows and its pieces are dealt out to its segments in
   turn. Returns the items and each segment's `from`, which is the index of the
   handoff row it starts with. */
function stitch(segments, read) {
  const pieces = new Map();
  for (const [session, items] of Object.entries(read)) {
    const parts = [[]];
    for (const it of items) {
      if (it.kind === 'handoff') parts.push([]);
      parts[parts.length - 1].push(it);
    }
    pieces.set(session, parts);
  }
  const used = new Map();
  const items = [];
  const out = [];
  segments.forEach((s, k) => {
    const parts = pieces.get(s.session) || [[]];
    let n = used.get(s.session) ?? 0;
    // A session that began on a handoff has nothing ahead of its first one.
    // That includes the first segment of a fork, whose first message carried
    // what it was forked with.
    if (n === 0 && !parts[0].length && parts.length > 1) n = 1;
    used.set(s.session, n + 1);
    out.push({ ...s, from: items.length });
    items.push(...(parts[n] || []));
  });
  return { items, segments: out };
}

// The session a chat is known by on disk: its first one.
const headOf = (c) => c?.segments?.[0]?.session || c?.session || null;

const typedIn = (items, from) => items.slice(from).some((it) => it.kind === 'user' && !it.parent);

/* The chat moved onto `provider` in place. The items stay; a handoff row marks
   the switch, a segment opens on the target's earlier session if it has one,
   and `handoff` says what the next message has to carry. A switch nothing was
   said on is taken back rather than stacked, so trying three models in a row
   leaves one row and not three. A stretch whose first send never reached its
   agent is dropped the same way when the chat moves on, its messages kept and
   its row gone, so that agent counts as new to the chat next time. A chat no
   agent has answered yet has nothing to hand over and only changes provider. */
function switchChat(c, { provider, model, id, label = (p) => p }) {
  if (!headOf(c)) return { ...c, provider };
  const segs = c.segments?.length ? c.segments.slice() : [{ provider: c.provider, session: c.session, from: 0 }];
  let items = c.items;
  const last = segs.length - 1;
  segs[last] = { ...segs[last], session: c.session || segs[last].session, context: c.usage?.context || 0 };
  if (last > 0 && (!typedIn(items, segs[last].from) || !segs[last].session)) {
    const gone = segs.pop();
    if (items[gone.from]?.kind === 'handoff') items = [...items.slice(0, gone.from), ...items.slice(gone.from + 1)];
  }
  const cur = segs[segs.length - 1];
  if (cur.provider === provider) {
    return { ...c, provider, session: cur.session, items, segments: segs.length > 1 ? segs : [], handoff: null };
  }
  const prior = priorOf([...segs, { provider, from: items.length }], provider);
  const session = prior?.session || null;
  segs.push({ provider, session, from: items.length });
  return {
    ...c,
    provider,
    session,
    items: [...items, { id, kind: 'handoff', from: label(cur.provider), to: label(provider), model, pending: true }],
    segments: segs,
    handoff: { since: prior ? prior.since : 0, used: prior?.context || 0, from: cur.provider, marker: id },
  };
}

// The chat once its newest session has an id. In a switched chat that id
// belongs to the newest segment.
function withSession(c, sessionId) {
  if (!sessionId) return c;
  const segs = c.segments?.length > 1
    ? c.segments.map((x, i) => (i === c.segments.length - 1 ? { ...x, session: sessionId } : x))
    : c.segments || [];
  return { ...c, segments: segs, session: sessionId };
}

module.exports = { withSession, cleanSegments, persistable, followers, foldHits, collapseRows, providerAt, priorOf, stitch, headOf, switchChat };
