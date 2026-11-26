'use strict';
/* How a handoff reaches its agent, and what the chat makes of the answer.

   Every agent can be handed one as text in front of the next message. Codex
   can also take it as past items of its thread (thread/inject_items), so it
   reads the history as history and the turn carries only what was typed.
   Which of the two a handoff went by is its status: `pending` until a send
   carries it, then `injected` or `inline`, or `new-thread` when it went as
   text on a thread started for it. Once it is anything but pending it never
   goes again, whatever happens to the turn it went with.

   The one case that needs care is an inject nobody answered: codex timed
   out, or died with the request in flight. The items may be on the thread or
   may not, and neither another inject nor the text on that thread is safe,
   since either could be the second copy. A new thread has nothing on it, so
   the handoff goes there, as text, and the chat moves its stretch onto it. */

/* What a failed thread/inject_items proves about the thread it was sent to.
   `refused`: codex answered no, or the request never left, so nothing was
   appended and the text can go in the same send. `unsupported` on top of that
   when the method itself is one this codex does not have, which holds for
   every later handoff on the session too. `unsure`: anything else, which is
   no answer or an answer that does not say the request was turned away. */
const REQUEST_ERRORS = new Set([-32600, -32601, -32602]);
function injectOutcome(e) {
  if (e?.unsent) return { how: 'refused', unsupported: false };
  if (!e?.answered) return { how: 'unsure', unsupported: false };
  const said = String(e.message || '');
  const unsupported = e.code === -32601 || /unknown variant|method not found|unknown method/i.test(said);
  const refused = unsupported || REQUEST_ERRORS.has(e.code) || /invalid|missing field|not found|unknown|unsupported/i.test(said);
  return refused ? { how: 'refused', unsupported } : { how: 'unsure', unsupported: false };
}

/* The handoff row once its send has been answered. `carry` is the handoff the
   send was built with and `whole` the whole chat, built alongside it for the
   new thread an unanswered inject moves to; `res` is main's answer. */
function rowDelivered(row, { carry, whole, res }) {
  const used = res?.whole && whole ? whole : carry;
  return {
    ...row,
    pending: false,
    carried: used.carried,
    total: used.total,
    scope: used.scope,
    ...(res?.delivery && { method: res.delivery }),
  };
}

/* What a chat still owes after a send that failed. Nothing, when the handoff
   went anyway: the agent has it, and carrying it again is the duplicate this
   exists to stop. The whole chat, on a session yet to be started, when it may
   have gone where nobody can tell (`lost`). Otherwise the same handoff, since
   nothing reached the agent. */
function owedAfter(owed, res) {
  if (!owed || res?.delivery) return null;
  if (res?.lost) return { ...owed, since: 0, used: 0, fresh: true };
  return owed;
}

module.exports = { injectOutcome, rowDelivered, owedAfter };
