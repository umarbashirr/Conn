'use strict';
/* Names a person gave a chat.

   A transcript's title is the first thing typed in it, and claude never writes
   another. Renaming has to live beside that, the way a completed mark does,
   or the next history read puts the first message back.

   The id is whatever the session is called. Claude uses a uuid; other agents
   use their own, so this accepts either rather than only one shape. */
const fs = require('fs');
const path = require('path');

const projects = require('./projects');

const FILE = path.join(projects.DIR, 'chat-titles.json');
const ID = /^[A-Za-z0-9_-]{8,128}$/;

let cache = null;

function read() {
  if (cache) return cache;
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
  cache = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [id, title] of Object.entries(raw)) {
      if (ID.test(id) && typeof title === 'string' && title.trim()) cache[id] = title.trim().slice(0, 80);
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

function set(id, title) {
  if (!ID.test(String(id || ''))) throw new Error(`not a session id: ${id}`);
  const next = String(title || '').trim().slice(0, 80);
  if (!next) throw new Error('Give the chat a name.');
  read();
  cache[id] = next;
  write();
  return next;
}

function forget(id) {
  read();
  if (!Object.hasOwn(cache, id)) return false;
  delete cache[id];
  write();
  return true;
}

module.exports = { get, set, forget, FILE };
