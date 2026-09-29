'use strict';
// The board's writes to frame files. The agent owns what a frame contains; the
// person owns where it sits and how big it is. So a drag rewrites x, y, width
// and height in whatever is on disk right now and nothing else, and a file the
// agent has left half written is refused rather than overwritten.
const fsp = require('fs').promises;
const path = require('path');
const { shell } = require('electron');
const { within } = require('./files');
const { CANVAS_DIR } = require('../shared/canvas');

const GEOMETRY = ['x', 'y', 'width', 'height'];

function frameAt(root, file) {
  if (typeof file !== 'string' || path.basename(file) !== file || !file.endsWith('.json')) return null;
  return within(root, path.join(CANVAS_DIR, file));
}

async function readFrame(abs) {
  let doc;
  try {
    doc = JSON.parse(await fsp.readFile(abs, 'utf8'));
  } catch (e) {
    throw new Error(`${path.basename(abs)} is not valid JSON right now, so it was left alone`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${path.basename(abs)} is not a frame`);
  return doc;
}

const text = (doc) => `${JSON.stringify(doc, null, 2)}\n`;
const scratch = (abs) => path.join(path.dirname(abs), `.${path.basename(abs)}.${process.pid}.${Date.now()}.tmp`);

// Readers see the old file or the new one, never half of either.
async function replace(abs, doc) {
  const tmp = scratch(abs);
  await fsp.writeFile(tmp, text(doc));
  await fsp.rename(tmp, abs);
}

// Linking fails when the name is taken, so two copies never share a file.
async function create(abs, doc) {
  const tmp = scratch(abs);
  await fsp.writeFile(tmp, text(doc));
  try {
    await fsp.link(tmp, abs);
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}

async function patch(root, file, geometry) {
  const abs = frameAt(root, file);
  if (!abs) return { error: 'that frame is outside the canvas folder' };
  const next = {};
  for (const key of GEOMETRY) {
    const v = geometry?.[key];
    if (v === undefined) continue;
    if (!Number.isFinite(v)) return { error: `${key} must be a number` };
    next[key] = Math.round(v);
  }
  try {
    const doc = await readFrame(abs);
    if (GEOMETRY.every((k) => next[k] === undefined || doc[k] === next[k])) return { ok: true };
    await replace(abs, { ...doc, ...next });
    return { ok: true };
  } catch (e) {
    return { error: e.message };
  }
}

async function duplicate(root, file, at) {
  const abs = frameAt(root, file);
  if (!abs) return { error: 'that frame is outside the canvas folder' };
  if (!Number.isFinite(at?.x) || !Number.isFinite(at?.y)) return { error: 'a copy needs a place on the board' };
  try {
    const doc = await readFrame(abs);
    const copy = { ...doc, name: `${doc.name || path.basename(file, '.json')} copy`, x: Math.round(at.x), y: Math.round(at.y) };
    const stem = path.basename(file, '.json').replace(/-copy(-\d+)?$/, '');
    for (let i = 1; i < 1000; i++) {
      const name = `${stem}-copy${i === 1 ? '' : `-${i}`}.json`;
      if (await create(path.join(path.dirname(abs), name), copy)) return { file: name };
    }
    return { error: 'too many copies of that frame already' };
  } catch (e) {
    return { error: e.message };
  }
}

// To the system trash rather than gone, so a slipped Delete key is recoverable.
async function trash(root, list) {
  const targets = (Array.isArray(list) ? list : []).map((f) => frameAt(root, f));
  if (!targets.length || targets.some((t) => !t)) return { error: 'that frame is outside the canvas folder' };
  try {
    for (const t of targets) await shell.trashItem(t);
    return { ok: true };
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = { patch, duplicate, trash };
