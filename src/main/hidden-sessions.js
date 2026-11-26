'use strict';
/* Sessions the rail never lists: the parts of a deleted chat that their agent
   could not delete from outside itself. The chat is gone, so there is no head
   row left to fold them into, and showing them would bring back a stretch of
   a chat the person deleted. Each keeps what Settings needs to list it: the
   chat's title, which agent, the folder and when it was last written. An
   entry from before those were kept is just `true`. */
const { sessionStore } = require('./session-store');
const { cleanSegments } = require('../shared/chat-segments');

const text = (v, n) => (typeof v === 'string' && v ? v.slice(0, n) : null);
const time = (v) => (Number.isFinite(v) && v > 0 ? v : null);

const ID = /^[A-Za-z0-9_-]{8,128}$/;

/* `chat` is the deleted chat's first session, shared by every part of it that
   stayed, and `segments` the run of those parts, so Show again brings them
   back as the one chat they were. */
function value(v) {
  if (v === true) return true;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const segments = cleanSegments(v.segments);
  return {
    provider: text(v.provider, 32),
    project: text(v.project, 4096),
    title: text(v.title, 200),
    at: time(v.at),
    hiddenAt: time(v.hiddenAt),
    ...(typeof v.chat === 'string' && ID.test(v.chat) && { chat: v.chat }),
    ...(segments && { segments }),
  };
}

const store = sessionStore('hidden-sessions.json', { value, refusal: 'not a hidden chat' });

const entries = () => Object.entries(store.all()).map(([session, v]) => ({ session, ...(v === true ? {} : v) }));
const groupKey = (e) => e.chat || e.session;

// The hidden parts of the chat `session` belongs to, in the chat's order.
function group(session) {
  const all = entries();
  const one = all.find((e) => e.session === session);
  if (!one) return [];
  const order = (one.segments || []).map((s) => s.session);
  return all.filter((e) => groupKey(e) === groupKey(one))
    .sort((a, b) => (order.indexOf(a.session) - order.indexOf(b.session)) || ((a.hiddenAt || 0) - (b.hiddenAt || 0)));
}

/* What Settings lists: one row per deleted chat, however many of its parts
   stayed, newest hidden first. A row is named by its first hidden part. */
function list() {
  const seen = new Map();
  for (const e of entries()) {
    const key = groupKey(e);
    if (seen.has(key)) continue;
    const parts = group(e.session);
    seen.set(key, {
      ...parts[0],
      sessions: parts.map((p) => p.session),
      providers: [...new Set(parts.map((p) => p.provider).filter(Boolean))],
      at: Math.max(0, ...parts.map((p) => p.at || 0)) || null,
    });
  }
  return [...seen.values()].sort((a, b) => (b.hiddenAt || 0) - (a.hiddenAt || 0));
}

module.exports = { ...store, list, group };
