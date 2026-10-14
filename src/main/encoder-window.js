'use strict';
// The hidden window a recording is encoded in. It is its own window, and not
// the shell, because a window in the background throttles its timers and the
// frames would bunch up. One lives from the start of a recording to its end.
const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const PAGE = path.join(__dirname, '..', 'encoder', 'encoder.html');
const PRELOAD = path.join(__dirname, '..', 'encoder', 'preload.js');

// Best first. MP4 plays everywhere; the WebM fallbacks are for a build whose
// MediaRecorder has no H.264.
const MIMES = ['video/mp4;codecs=avc1.42E01F', 'video/webm;codecs=vp9', 'video/webm'];

const READY_MS = 8000;
const DONE_MS = 30000;

const live = new Map(); // webContents id -> EncoderWindow
let wired = false;

function wire() {
  if (wired) return;
  wired = true;
  const to = (e) => live.get(e.sender.id);
  ipcMain.handle('encoder:ready', (e, info) => to(e)?.settle('ready', info));
  ipcMain.handle('encoder:done', (e, result) => to(e)?.settle('done', result));
  ipcMain.handle('encoder:fail', (e, message) => to(e)?.break(new Error(message)));
}

class EncoderWindow {
  constructor() {
    wire();
    this.waiting = new Map(); // 'ready' | 'done' -> { resolve, reject, timer }
    this.win = new BrowserWindow({
      show: false,
      width: 320,
      height: 240,
      skipTaskbar: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        partition: 'conn-encoder',
        preload: PRELOAD,
      },
    });
    this.wc = this.win.webContents;
    this.id = this.wc.id;
    live.set(this.id, this);
    this.wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.wc.on('will-navigate', (e) => e.preventDefault());
    this.win.on('closed', () => {
      live.delete(this.id);
      this.break(new Error('the encoder window closed'));
    });
  }

  static async open() {
    const w = new EncoderWindow();
    try {
      await w.win.loadFile(PAGE);
    } catch (e) {
      w.close();
      throw e;
    }
    return w;
  }

  #expect(kind, ms, what) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.break(new Error(`the encoder did not ${what} in ${ms / 1000} s`)), ms);
      this.waiting.set(kind, { resolve, reject, timer });
    });
  }

  settle(kind, value) {
    const w = this.waiting.get(kind);
    if (!w) return;
    clearTimeout(w.timer);
    this.waiting.delete(kind);
    w.resolve(value);
  }

  break(err) {
    for (const [kind, w] of [...this.waiting]) {
      clearTimeout(w.timer);
      this.waiting.delete(kind);
      w.reject(err);
    }
  }

  send(kind, payload) {
    if (!this.win.isDestroyed()) this.wc.send(`encoder:${kind}`, payload);
  }

  /** Size the canvas from the first frame and start the recorder. Resolves with { mime, width, height }. */
  init(frame) {
    const ready = this.#expect('ready', READY_MS, 'start');
    this.send('init', { mimes: MIMES, frame });
    return ready;
  }

  frame(bytes) { this.send('frame', bytes); }
  tick() { this.send('tick'); }

  /** Close the file off. Resolves with { bytes, mime }. */
  finish() {
    const done = this.#expect('done', DONE_MS, 'finish');
    this.send('stop');
    return done;
  }

  close() {
    live.delete(this.id);
    this.break(new Error('the encoder was closed'));
    if (!this.win.isDestroyed()) this.win.destroy();
  }

  static closeAll() {
    for (const w of [...live.values()]) w.close();
  }
}

module.exports = { EncoderWindow };
