'use strict';
// Conn's own speech model: an English Whisper. The weights are downloaded once
// into the app's user data and reused. A custom dictation command, when set,
// replaces this. See dictation.js.
//
// The model runs in speech-worker.js, a Node process of its own: the larger
// models crash Electron's main process when they load. This side keeps the
// same three calls main always had, plus the download progress.
const path = require('path');
const { fork } = require('child_process');
const { app } = require('electron');

// Every size is the 8-bit build, which is what is downloaded. Tiny was the only
// one for a long time and is the least accurate by a distance; Base is the
// default now, and Small is the one to pick for accuracy.
const MODELS = {
  tiny: { repo: 'Xenova/whisper-tiny.en', mb: 40 },
  base: { repo: 'Xenova/whisper-base.en', mb: 76 },
  small: { repo: 'Xenova/whisper-small.en', mb: 248 },
};
const DEFAULT = 'base';
const modelOf = (id) => (MODELS[id] ? id : DEFAULT);
const cacheDir = () => path.join(app.getPath('userData'), 'speech');

let worker = null;
let nextId = 0;
const waiting = new Map();
const warmed = new Map();
const files = new Map(); // repo -> Map(file -> { loaded, total })

let progress = { model: null, received: 0, total: 0, done: true };
let onProgress = () => {};
function watch(fn) { onProgress = fn || (() => {}); }
const status = () => progress;

function report(model, done) {
  let received = 0;
  let total = 0;
  for (const f of (files.get(MODELS[model].repo) || new Map()).values()) { received += f.loaded; total += f.total; }
  progress = { model, received, total, done };
  onProgress(progress);
}

function spawnWorker() {
  // fork runs this Electron binary as Node (ELECTRON_RUN_AS_NODE), and the
  // advanced serialiser carries the Int16Array samples across as they are.
  const child = fork(path.join(__dirname, 'speech-worker.js'), [], { serialization: 'advanced', stdio: 'ignore' });
  child.on('message', (msg) => {
    if (msg?.type === 'progress') {
      const model = Object.keys(MODELS).find((k) => MODELS[k].repo === msg.repo);
      if (!files.has(msg.repo)) files.set(msg.repo, new Map());
      files.get(msg.repo).set(msg.file, { loaded: msg.loaded, total: msg.total });
      if (model) report(model, false);
      return;
    }
    const pending = waiting.get(msg?.id);
    if (!pending) return;
    waiting.delete(msg.id);
    if (msg.ok) pending.resolve(msg);
    else pending.reject(new Error(msg.reason || 'the speech model failed'));
  });
  // A crash fails what was asked of it, and the next take starts a fresh one.
  child.on('exit', (code, signal) => {
    if (worker === child) worker = null;
    warmed.clear();
    for (const [id, pending] of waiting) {
      waiting.delete(id);
      pending.reject(new Error(`the speech model stopped (${signal || `code ${code}`})`));
    }
  });
  return child;
}

function ask(message) {
  worker ||= spawnWorker();
  const id = (nextId += 1);
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    worker.send({ id, cacheDir: cacheDir(), ...message });
  });
}

function warm(id) {
  const model = modelOf(id);
  if (!warmed.has(model)) {
    const pending = ask({ type: 'warm', repo: MODELS[model].repo }).then(() => report(model, true));
    warmed.set(model, pending);
    // A failed download is not remembered, so the next take tries again.
    pending.catch(() => warmed.delete(model));
  }
  return warmed.get(model);
}

// samples is 16 kHz mono Int16, the same shape the microphone records.
async function transcribe(samples, id) {
  const model = modelOf(id);
  await warm(model);
  const { text } = await ask({ type: 'transcribe', repo: MODELS[model].repo, samples });
  return text || '';
}

function stop() {
  worker?.kill();
  worker = null;
}

module.exports = { warm, transcribe, watch, status, stop, MODELS, DEFAULT };
