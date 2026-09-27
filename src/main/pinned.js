'use strict';
/* Chats the person has pinned to the top of a folder.

   The rail is newest-first, so a chat you keep coming back to sinks as newer
   ones land above it. A pin holds it at the top. Nothing moves on disk. This
   file is only a set of session ids and when each was pinned, the same way a
   completed mark is kept. */
const fs = require('fs');
const path = require('path');

const projects = require('./projects');

const FILE = path.join(projects.DIR, 'pinned-chats.json');
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let cache = null;

function read() {
  if (cache) return cache;
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
  cache = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [id, at] of Object.entries(raw)) {
      if (SESSION_ID.test(id)) cache[id] = Number(at) || 0;
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

const all = () => ({ ...read() });

function setPinned(id, pinned) {
  if (!SESSION_ID.test(String(id || ''))) throw new Error(`not a session id: ${id}`);
  read();
  if (pinned) cache[id] = Date.now();
  else delete cache[id];
  write();
  return !!pinned;
}

function forget(id) {
  read();
  if (!Object.hasOwn(cache, id)) return false;
  delete cache[id];
  write();
  return true;
}

module.exports = { all, setPinned, forget, FILE };
