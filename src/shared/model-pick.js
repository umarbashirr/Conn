'use strict';
/* Picking a model, which on another CLI moves a chat to it. */

// Each chat's picks run one at a time, in the order they were made. Two quick
// picks otherwise race: the second can land before the first, and the chat
// ends up on the first while the picker shows the second.
function createSerial() {
  const tails = new Map();
  return (key, fn) => {
    const run = (tails.get(key) || Promise.resolve()).catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    tails.set(key, tail);
    tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
    return run;
  };
}

// Whether a model name picked for `runs` may be handed to the session the chat
// has now. Only a live session on that same CLI can take it.
function mayApplyModel(session, runs, fallback) {
  if (!session || session.closed) return false;
  return (session.provider || fallback) === runs;
}

module.exports = { createSerial, mayApplyModel };
