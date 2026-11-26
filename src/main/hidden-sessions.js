'use strict';
/* Sessions the rail never lists: the parts of a deleted chat that their agent
   could not delete from outside itself. The chat is gone, so there is no head
   row left to fold them into, and showing them would bring back a stretch of
   a chat the person deleted. Each keeps what Settings needs to list it: the
   chat's title, which agent, the folder and when it was last written. An
   entry from before those were kept is just `true`. */
const { sessionStore } = require('./session-store');

const text = (v, n) => (typeof v === 'string' && v ? v.slice(0, n) : null);
const time = (v) => (Number.isFinite(v) && v > 0 ? v : null);

function value(v) {
  if (v === true) return true;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  return {
    provider: text(v.provider, 32),
    project: text(v.project, 4096),
    title: text(v.title, 200),
    at: time(v.at),
    hiddenAt: time(v.hiddenAt),
  };
}

const store = sessionStore('hidden-sessions.json', { value, refusal: 'not a hidden chat' });

// Every hidden session for Settings, newest hidden first.
const list = () => Object.entries(store.all())
  .map(([session, v]) => ({ session, ...(v === true ? {} : v) }))
  .sort((a, b) => (b.hiddenAt || 0) - (a.hiddenAt || 0));

module.exports = { ...store, list };
