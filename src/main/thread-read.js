'use strict';
/* Answering conn_thread_read: the chat the calling agent belongs to, read off
   disk by the same replay the window draws it with, so an id a handoff named
   is the id it finds here, after a reload, a reopen or a restart.

   Only the calling chat is read. Its sessions are resolved here from the chat
   key the agent's server was started with, never from anything the agent
   says, so an id from another chat is simply not in this one. Rows a fork drew
   back from what it was handed are marked carried, never shown as this chat's
   own turns, and a handoff's own text is never an item: replay unwraps it.

   `sessionsOf(chat)` answers { dir, segments } for a chat key, or throws when
   there is no such chat. `readSession(dir, session, provider)` reads one
   session whole. `stampOf(dir, session, provider)` is what says a session
   has changed; a thread is read again only then. */
const { readThread } = require('../shared/replay');
const { providerAt } = require('../shared/chat-segments');
const { entriesOf } = require('../shared/handoff');
const { pick, answer } = require('../shared/thread-tool');
const { createStitchCache } = require('./stitch-cache');

function createThreadReader({ sessionsOf, readSession, stampOf }) {
  const threads = createStitchCache({
    read: (dir, segs) => readThread(segs, (session, provider) => readSession(dir, session, provider)),
    stampOf,
  });

  return async function threadRead(chat, args = {}) {
    if (typeof chat !== 'string' || !chat) {
      throw new Error('conn_thread_read reads the chat it was started for, and this server was not started for a chat.');
    }
    const { dir, segments } = await sessionsOf(chat);
    if (!segments?.length) throw new Error('This chat has nothing on disk to read yet.');
    const thread = await threads(dir, segments);
    const all = entriesOf(thread.items, segments.length > 1 ? { providerAt: (i) => providerAt(thread.segments, i) } : {});
    const res = pick(all, args);
    return answer({ ...res, total: all.length });
  };
}

module.exports = { createThreadReader };
