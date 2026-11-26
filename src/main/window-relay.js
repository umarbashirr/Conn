'use strict';
/* Handing a message to the window and hearing back that it took it. The phone
   is told "ok" only once the window says the message is in the chat, sent or
   queued; a window that does not answer in time (reloading, closed, the chat
   gone) is an error the phone shows rather than a message lost without a
   word. `send(payload)` delivers to the window and returns false when there
   is no window to deliver to. */
function createRelay({ send, timeoutMs = 8000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const waiting = new Map();
  let next = 0;

  function forward(payload) {
    const id = `t${Date.now().toString(36)}${(next += 1)}`;
    return new Promise((resolve) => {
      const timer = setTimer(() => settle(id, { error: 'Conn did not take the message. Open Conn on the computer and try again.' }), timeoutMs);
      waiting.set(id, { resolve, timer });
      if (send({ ...payload, id }) === false) settle(id, { error: 'Conn has no window open to take the message.' });
    });
  }

  function settle(id, result) {
    const w = waiting.get(id);
    if (!w) return false;
    waiting.delete(id);
    clearTimer(w.timer);
    w.resolve(result?.ok ? { ok: true } : { error: result?.error || 'Conn did not take the message.' });
    return true;
  }

  // The window went away under every message it had not answered for.
  function failAll(error) {
    for (const id of [...waiting.keys()]) settle(id, { error });
  }

  return { forward, settle, failAll, pending: () => waiting.size };
}

module.exports = { createRelay };
