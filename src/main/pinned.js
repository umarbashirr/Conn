'use strict';
/* Chats the person has pinned to the top of a folder, and folders pinned to
   the top of the rail.

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

/* Folders, keyed by absolute path. Kept apart from chats so neither file's
   check has to guess which kind a key is. A pin outlives closing the folder:
   the folder is still on disk, and opening it again should find it where it
   was left. */
const PROJECTS_FILE = path.join(projects.DIR, 'pinned-projects.json');
let projectCache = null;

function readProjects() {
  if (projectCache) return projectCache;
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8')); } catch {}
  projectCache = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [dir, at] of Object.entries(raw)) {
      if (path.isAbsolute(dir)) projectCache[dir] = Number(at) || 0;
    }
  }
  return projectCache;
}

const allProjects = () => ({ ...readProjects() });
const isProjectPinned = (dir) => Object.hasOwn(readProjects(), path.resolve(String(dir || '')));

function setProjectPinned(dir, pinned) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error(`not a folder path: ${dir}`);
  const key = path.resolve(dir);
  readProjects();
  if (pinned) projectCache[key] = Date.now();
  else delete projectCache[key];
  try {
    fs.mkdirSync(projects.DIR, { recursive: true });
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projectCache, null, 2));
  } catch {}
  return !!pinned;
}

module.exports = { all, setPinned, forget, FILE, allProjects, isProjectPinned, setProjectPinned, PROJECTS_FILE };
