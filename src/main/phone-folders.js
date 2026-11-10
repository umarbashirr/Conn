'use strict';

const LIVE = new Set(['working', 'waiting']);

function phoneChat(session) {
  return {
    id: session.id,
    title: typeof session.title === 'string' && session.title.trim() !== '' ? session.title : 'Chat',
    at: typeof session.at === 'number' ? session.at : 0,
    provider: session.provider,
  };
}

function phoneRow(session, live, pins) {
  const state = LIVE.has(live[session.id]) ? live[session.id] : 'idle';
  return {
    ...phoneChat(session),
    state,
    pinAt: Number(pins[session.id]) || 0,
  };
}

// Same split as the desktop sidebar. A pin, or a chat that is working or
// waiting, stays in the open list. Everything else marked completed goes in
// that folder's done list. Pins sort ahead of the newest chat.
function phoneFolders(entries, { completed = {}, pinned = {}, live = {} } = {}) {
  const doneIds = completed && typeof completed === 'object' ? completed : {};
  const pins = pinned && typeof pinned === 'object' ? pinned : {};
  const running = live && typeof live === 'object' ? live : {};
  const folders = entries.map((entry) => {
    const chats = [];
    const done = [];
    for (const session of entry.sessions || []) {
      const row = phoneRow(session, running, pins);
      const held = row.state !== 'idle' || row.pinAt > 0;
      (Object.hasOwn(doneIds, session.id) && !held ? done : chats).push(row);
    }
    chats.sort((a, b) => b.pinAt - a.pinAt || b.at - a.at);
    const at = [...chats, ...done].reduce((max, row) => (row.at > max ? row.at : max), 0);
    return { dir: entry.dir, name: entry.name, chats, done, at };
  });
  folders.sort((a, b) => b.at - a.at);
  return folders.map(({ dir, name, chats, done }) => ({ dir, name, chats, done }));
}

module.exports = { phoneChat, phoneFolders };
