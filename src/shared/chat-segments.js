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

// What may be kept on disk: two or more segments with a session each. One
// segment is an ordinary chat and needs no record.
function cleanSegments(v) {
  if (!Array.isArray(v) || v.length < 2) return null;
  const out = [];
  for (const s of v) {
    if (!s || !PROVIDER.test(String(s.provider || '')) || !SESSION.test(String(s.session || ''))) return null;
    out.push({ provider: s.provider, session: s.session });
  }
  return out;
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

// The provider running at item index `i`.
function providerAt(segments, i) {
  let p = segments[0]?.provider || null;
  for (const s of segments) if (s.from <= i) p = s.provider;
  return p;
}

/* Where `provider` stopped seeing this chat, and the session to resume it on:
   the end of its last segment before the current one. Null for an agent that
   has never been in the chat, which gets the whole of it. */
function priorOf(segments, provider) {
  for (let j = segments.length - 2; j >= 0; j--) {
    if (segments[j].provider === provider) {
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
    if (n === 0 && k > 0 && !parts[0].length) n = 1;
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
   leaves one row and not three. A chat no agent has answered yet has nothing
   to hand over and only changes provider. */
function switchChat(c, { provider, model, id, label = (p) => p }) {
  if (!headOf(c)) return { ...c, provider };
  const segs = c.segments?.length ? c.segments.slice() : [{ provider: c.provider, session: c.session, from: 0 }];
  let items = c.items;
  const last = segs.length - 1;
  segs[last] = { ...segs[last], session: c.session || segs[last].session, context: c.usage?.context || 0 };
  if (last > 0 && !typedIn(items, segs[last].from)) {
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

module.exports = { cleanSegments, followers, collapseRows, providerAt, priorOf, stitch, headOf, switchChat };
