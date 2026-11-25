/* When a chat's turn is over, for whoever is waiting on it: a pipeline waits
   for one stage to end before it sends the next. useAgent says so once per
   turn, after the result, an error, a send that never reached the agent, or a
   session that closed mid-turn. */
const listeners = new Set();

export function onTurnEnd(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// { chat, failed, error }
export function turnEnded(event) {
  for (const fn of listeners) {
    try { fn(event); } catch (e) { console.error(e); }
  }
}

/* Chats that left the window: deleted, or gone with a folder that closed. A
   pipeline whose stage was running in one cannot wait for its turn to end. */
const goneListeners = new Set();

export function onChatsGone(fn) {
  goneListeners.add(fn);
  return () => goneListeners.delete(fn);
}

export function chatsGone(keys) {
  if (!keys?.length) return;
  for (const fn of goneListeners) {
    try { fn(keys); } catch (e) { console.error(e); }
  }
}
