/* The design canvas: an unlimited board of frames the agent draws.

   Each frame is a JSON file in the chat's own board folder under .conn/canvas/
   (see canvas-schema.js), written with the same file tools the agent edits
   code with, so every agent Conn runs can draw here. This store reads that
   folder while the tab is on screen and re-reads only the files whose mtime
   moved, so the viewport and selection survive every edit.

   A board is the folder a chat runs in plus its board id. App points this
   store at the chat on screen, and showing another chat swaps the board whole.

   The agent writes what a frame contains and the person decides where it sits.
   A drag lives in `pending` until main has written it and the file on disk
   agrees, so a frame never snaps back while the write is in flight.

   Same shape as the other stores here: a mutable object, a version counter for
   useSyncExternalStore, and changed() to bump it. */
'use strict';
import { toast } from './toast.jsx';
import { nextSlot, parseFrame } from './canvas-schema.js';
import { toHtml, toReact, toSvg } from './canvas-export.js';

const POLL_MS = 500;
const GEOMETRY = ['x', 'y', 'width', 'height'];

/* dir, canvas: the folder the chat runs in and its board id. legacy: how many
   frames from before chats had boards sit loose in .conn/canvas/. records: one
   per file, keeping the last frame that parsed so a broken edit leaves the
   frame on the board with its error beside it. board: what the board draws,
   records with a frame and pending geometry applied, rebuilt on every change.
   viewport: null until the board first fits the frames it found. selection:
   files. */
export const canvasState = {
  dir: '',
  canvas: '',
  legacy: 0,
  records: [],
  board: [],
  viewport: null,
  selection: [],
};

const pending = new Map();
let selectAfterRead = [];
// Where each board was left, so coming back to a chat finds the canvas panned
// and zoomed the way it was.
const viewports = new Map();
const boardKey = (dir, canvas) => `${dir}\0${canvas}`;

const listeners = new Set();
const selectionListeners = new Set();
let version = 0;

export const getCanvasVersion = () => version;

export function subscribeCanvas(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// The frames selected on the board, for the composer to attach to the prompt.
export function onSelection(fn) {
  selectionListeners.add(fn);
  return () => selectionListeners.delete(fn);
}

export const selectedFrames = () => canvasState.board.filter((f) => canvasState.selection.includes(f.file));

function rebuild() {
  canvasState.board = canvasState.records
    .filter((r) => r.frame)
    .map((r) => ({ file: r.file, name: r.frame.name, frame: r.frame, error: r.error, ...pick(r.frame), ...pending.get(r.file) }));
}

function changed() {
  rebuild();
  version += 1;
  for (const fn of listeners) fn();
}

const pick = (g) => Object.fromEntries(GEOMETRY.map((k) => [k, g[k]]));
const same = (a, b) => GEOMETRY.every((k) => a[k] === b[k]);

function setSelection(files) {
  const s = canvasState;
  const next = s.records.filter((r) => r.frame && files.includes(r.file)).map((r) => r.file);
  if (next.length === s.selection.length && next.every((f, i) => f === s.selection[i])) return false;
  s.selection = next;
  const frames = selectedFrames();
  for (const fn of selectionListeners) fn(frames);
  return true;
}

async function readRecord(dir, canvas, entry, old) {
  const res = await window.conn.canvas.frame(dir, canvas, entry.file);
  const parsed = res.error ? { error: `${entry.file}: ${res.error}` } : parseFrame(res.text, entry.file);
  return { file: entry.file, mtime: entry.mtime, frame: parsed.frame ?? old?.frame ?? null, error: parsed.error ?? null };
}

let reading = false;

async function read() {
  if (reading) return;
  reading = true;
  try {
    const s = canvasState;
    const { dir, canvas } = s;
    if (!dir || !canvas) return;
    const here = () => s.dir === dir && s.canvas === canvas;
    const listing = await window.conn.canvas.frames(dir, canvas);
    if (!here() || listing.error) return;

    let dirty = false;
    if (s.legacy !== listing.legacy) {
      s.legacy = listing.legacy;
      dirty = true;
    }
    const old = new Map(s.records.map((r) => [r.file, r]));
    const records = await Promise.all(listing.frames.map((e) => {
      const r = old.get(e.file);
      return r && r.mtime === e.mtime ? r : readRecord(dir, canvas, e, r);
    }));
    if (!here()) return;

    if (records.length !== s.records.length || records.some((r, i) => r !== s.records[i])) dirty = true;
    s.records = records;
    for (const [file, g] of pending) {
      const r = records.find((x) => x.file === file);
      if (!r?.frame || same(r.frame, g)) {
        pending.delete(file);
        dirty = true;
      }
    }
    const wanted = selectAfterRead.length ? selectAfterRead : s.selection;
    if (selectAfterRead.every((f) => records.some((r) => r.file === f))) selectAfterRead = [];
    if (setSelection(wanted)) dirty = true;
    if (dirty) changed();
  } finally {
    reading = false;
  }
}

// Another chat's board goes on screen. The one that was there is dropped whole,
// so a frame of one chat can never be dragged, deleted or briefed into another.
export function setBoard(project, id) {
  const s = canvasState;
  const dir = project || '';
  const canvas = id || '';
  if (dir === s.dir && canvas === s.canvas) return;
  Object.assign(s, {
    dir,
    canvas,
    legacy: 0,
    records: [],
    viewport: viewports.get(boardKey(dir, canvas)) ?? null,
  });
  pending.clear();
  selectAfterRead = [];
  setSelection([]);
  changed();
  read();
}

let timer = null;

export function activate() {
  read();
  clearInterval(timer);
  timer = setInterval(read, POLL_MS);
}

export function deactivate() {
  clearInterval(timer);
  timer = null;
}

// ------------------------------------------------------------------ board

export function setViewport(v) {
  canvasState.viewport = v;
  viewports.set(boardKey(canvasState.dir, canvasState.canvas), v);
  changed();
}

export function select(files) {
  if (setSelection(files)) changed();
}

// While a gesture is under way: drawn, not written.
export function preview(changes) {
  for (const c of changes) pending.set(c.file, roundAll(c));
  changed();
}

const roundAll = (g) => Object.fromEntries(GEOMETRY.map((k) => [k, Math.round(g[k])]));

export async function persist(files) {
  const { dir, canvas } = canvasState;
  await Promise.all(files.map(async (file) => {
    const g = pending.get(file);
    if (!g) return;
    const res = await window.conn.canvas.patch(dir, canvas, file, g);
    if (!res?.error) return;
    pending.delete(file);
    changed();
    toast('Could not move the frame', res.error, [{ label: 'OK', primary: true }]);
  }));
  read();
}

export async function duplicateSelection() {
  const frames = selectedFrames();
  if (!frames.length) return;
  const taken = [...canvasState.board];
  const made = [];
  for (const f of frames) {
    const at = nextSlot(taken);
    const res = await window.conn.canvas.duplicate(canvasState.dir, canvasState.canvas, f.file, at);
    if (res?.error) {
      toast('Could not duplicate the frame', res.error, [{ label: 'OK', primary: true }]);
      break;
    }
    taken.push({ ...f, ...at });
    made.push(res.file);
  }
  selectAfterRead = made;
  read();
}

export async function deleteSelection() {
  const files = [...canvasState.selection];
  if (!files.length) return;
  const res = await window.conn.canvas.trash(canvasState.dir, canvasState.canvas, files);
  if (res?.error) toast('Could not delete the frame', res.error, [{ label: 'OK', primary: true }]);
  else toast('Moved to the trash', files.length === 1 ? files[0] : `${files.length} frames`);
  read();
}

// Frames from before every chat had a board are moved into this one, and the
// board is read again so they appear.
export async function adoptLegacy() {
  const res = await window.conn.canvas.adopt(canvasState.dir, canvasState.canvas);
  if (res?.error) toast('Could not move the designs', res.error, [{ label: 'OK', primary: true }]);
  read();
}

// ------------------------------------------------------------------ export

// The selection, or the whole board when nothing is selected.
const exported = () => {
  const list = selectedFrames().length ? selectedFrames() : canvasState.board;
  return list.map((f) => ({ ...f.frame, ...pick(f), file: f.file }));
};

const stem = (frames) => (frames.length === 1 ? frames[0].file.replace(/\.json$/, '') : 'canvas');
const drawn = (file) => document.querySelector(`#canvas-view [data-frame="${CSS.escape(file)}"]`)?.firstElementChild;
const svg = (frames) => toSvg(frames.map((frame) => ({ frame, el: drawn(frame.file) })));

/* Every way frames leave the canvas, in the order the menu offers them. `ext`
   saves through a dialog; without one it goes on the clipboard. */
export const EXPORTS = [
  { id: 'jsx', group: 'code', label: 'Save React + Tailwind…', ext: 'jsx', make: toReact },
  { id: 'copy-jsx', group: 'code', label: 'Copy React + Tailwind', make: toReact },
  { id: 'html', group: 'code', label: 'Save HTML…', ext: 'html', make: (frames) => toHtml(frames, stem(frames)) },
  { id: 'svg', group: 'figma', label: 'Save SVG for Figma…', ext: 'svg', make: svg },
  { id: 'copy-svg', group: 'figma', label: 'Copy for Figma', make: svg },
];

export async function exportFrames(id) {
  const how = EXPORTS.find((e) => e.id === id);
  const frames = exported();
  if (!how || !frames.length) return;
  let text;
  try {
    text = how.make(frames);
  } catch (e) {
    toast('Could not export the design', e.message, [{ label: 'OK', primary: true }]);
    return;
  }
  const what = frames.length === 1 ? frames[0].name : `${frames.length} frames`;
  if (!how.ext) {
    await navigator.clipboard.writeText(text);
    toast('Copied', how.group === 'figma' ? `${what}. Paste into a Figma file with Ctrl+V for editable layers.` : what);
    return;
  }
  const res = await window.conn.canvas.save(`${stem(frames)}.${how.ext}`, text, canvasState.dir);
  if (res?.error) toast('Could not save the design', res.error, [{ label: 'OK', primary: true }]);
  else if (res?.path) toast('Saved', res.path);
}
