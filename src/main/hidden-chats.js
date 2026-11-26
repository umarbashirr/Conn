'use strict';
/* Hiding what a delete left on disk, and bringing it back, as whole chats.

   A deleted chat that changed agent can leave several parts behind, one per
   agent that would not delete its session. They are hidden together, under
   the chat they came from, with the run of sessions they make up, so Show
   again gives back one chat rather than one row per part. `hidden` is
   hidden-sessions.js and `records` chat-segments.js; both are passed in so a
   check can hand over stores of its own. */
const { persistable } = require('../shared/chat-segments');

// After a delete: `left` is what stayed, as { session, provider }.
function hideParts({ hidden, head, segments = [], left, meta = {} }) {
  const kept = new Set(left.map((l) => l.session));
  const run = persistable(segments.filter((s) => kept.has(s.session)));
  for (const l of left) {
    hidden.set(l.session, {
      ...meta,
      provider: l.provider,
      at: meta.atOf?.(l.session) ?? null,
      hiddenAt: meta.hiddenAt || Date.now(),
      chat: head,
      ...(run && { segments: run }),
    });
  }
  return run;
}

// Show again: every hidden part of the chat comes back, joined again when
// there are two or more.
function showAgain({ hidden, records, session }) {
  const parts = hidden.group(session);
  if (!parts.length) return { ok: false };
  for (const p of parts) hidden.forget(p.session);
  const run = parts.find((p) => p.segments)?.segments || null;
  if (run) records.set(run[0].session, run);
  return { ok: true, sessions: parts.map((p) => p.session), joined: !!run };
}

// After Try deleting again: whatever went is forgotten, and what is still
// hidden keeps the run of the parts that are left.
function afterRetry({ hidden, session, removed }) {
  const gone = new Set(removed);
  const parts = hidden.group(session);
  for (const p of parts) if (gone.has(p.session)) hidden.forget(p.session);
  const rest = parts.filter((p) => !gone.has(p.session));
  const run = persistable((parts.find((p) => p.segments)?.segments || []).filter((s) => !gone.has(s.session)));
  for (const p of rest) {
    const { session: id, sessions, providers, ...v } = p;
    delete v.segments;
    hidden.set(id, { ...v, ...(run && { segments: run }) });
  }
  return { left: rest.map((p) => p.session) };
}

module.exports = { hideParts, showAgain, afterRetry };
