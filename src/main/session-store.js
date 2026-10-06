'use strict';
/* One JSON object in ~/.conn, keyed by session id.

   A chat's name and the board it draws on are both facts about a session that
   have to live beside its transcript, because the transcript is the agent's
   and never holds them. They share how that is kept: read once, each entry
   checked as it is read, the whole object written on every change.

   The id is whatever the session is called. Claude uses a uuid; other agents
   use their own, so this accepts either rather than only one shape.

   `value` turns what was stored into what the caller wants, or null to drop
   the entry, so a hand-edited file cannot hand a bad value to anything. A set
   that `value` drops throws `refusal`. */
const fs = require('fs');
const path = require('path');

const projects = require('./projects');

const ID = /^[A-Za-z0-9_-]{8,128}$/;

function sessionStore(name, { value, refusal = `not a value ${name} can hold` }) {
  const FILE = path.join(projects.DIR, name);
  let cache = null;

  function read() {
    if (cache) return cache;
    let raw = {};
    try { raw = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
    cache = {};
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [id, v] of Object.entries(raw)) {
        const kept = ID.test(id) ? value(v) : null;
        if (kept !== null) cache[id] = kept;
      }
    }
    return cache;
  }

  function write() {
    try {
      fs.mkdirSync(projects.DIR, { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(cache, null, 2));
    } catch {}
  }

  const get = (id) => read()[id] || null;

  function set(id, v) {
    if (!ID.test(String(id || ''))) throw new Error(`not a session id: ${id}`);
    const kept = value(v);
    if (kept === null) throw new Error(refusal);
    read();
    cache[id] = kept;
    write();
    return kept;
  }

  function forget(id) {
    read();
    if (!Object.hasOwn(cache, id)) return false;
    delete cache[id];
    write();
    return true;
  }

  return { get, set, forget, FILE };
}

module.exports = { sessionStore };
