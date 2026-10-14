'use strict';
// A recording of one preview pane, as a state machine:
//
//   idle -> recording -> stopping -> idle
//
// `recording` also covers the second or so it takes to open the encoder and get
// the first frame, so a second start is refused from the first call on. The
// recording itself is one object that lives from start to the file on disk.
//
// The pane's debugger sends a screencast frame only when the page changes. A
// clock here sends the newest one to the encoder every 1/fps seconds, so the
// video is as long as the wall time and a still page does not shorten it.
const fs = require('fs');
const { nativeImage } = require('electron');
const { EncoderWindow } = require('./encoder-window');
const { safeFilePath } = require('./screenshot-path');
const { STILLS, stillPath, pruneRecordings } = require('./recording-files');

const FPS = 10;
const DEFAULT_SECONDS = 60;
const MAX_SECONDS = 120;
// A pane that draws nothing (a page that never paints) has nothing to record.
const FIRST_FRAME_MS = 5000;
// Chromium sends a screencast frame when the page changes, and a first one on
// start only if it has already seen the page draw, which a pane that was just
// loaded, or just let go of by DevTools, may not have. A view that was last
// drawn at some other size (a screenshot of a hidden pane shrinks it to one
// pixel) hands over that stale picture instead. Either way nothing more comes
// while the page sits still. So until a frame of the right size arrives, every
// NUDGE_MS the view is nudged and the screencast started again, and after
// SETTLE_MS of a wrong one what there is gets recorded.
const NUDGE_MS = 800;
const SETTLE_MS = 1500;
// Distinct frames kept for the middle still. Halved when full, so memory stays
// bounded however long the recording and the middle is found to within a few
// seconds.
const PICKS = 48;

const SCREENCAST = { format: 'jpeg', quality: 80, everyNthFrame: 1 };

const NEXT = { idle: ['recording'], recording: ['stopping', 'idle'], stopping: ['idle'] };

const clampSeconds = (n) => {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.min(MAX_SECONDS, v) : DEFAULT_SECONDS;
};

// Recorders with a recording in flight, so quitting can end them all.
const open = new Set();

class Recorder {
  /**
   * `io` is what the pane lends: send(method, params) to its debugger,
   * attached() for whether it has one, size() for the view's size in pixels,
   * nudge() to make a hidden view draw again, and changed() for when
   * `recording` flips.
   */
  constructor(io) {
    this.io = io;
    this.phase = 'idle';
    this.rec = null;
    // What ended on its own (the limit, DevTools opening) and has not been
    // asked for yet. The next `stop` hands it over.
    this.finished = null;
  }

  get recording() { return this.phase === 'recording'; }

  #to(phase) {
    if (!NEXT[this.phase].includes(phase)) throw new Error(`recorder cannot go from ${this.phase} to ${phase}`);
    this.phase = phase;
  }

  #cdp(method, params) {
    return Promise.resolve().then(() => this.io.send(method, params));
  }

  async start({ dir, name, keep, maxSeconds }) {
    if (this.phase !== 'idle') throw new Error('already recording this pane. Call record stop first.');
    if (!this.io.attached()) {
      throw new Error('DevTools is open on the preview pane, so it cannot be recorded. Close them with the devtools tool and try again.');
    }
    const rec = {
      dir, name, keep,
      fps: FPS,
      maxSeconds: clampSeconds(maxSeconds),
      startedAt: 0,
      latest: null,       // newest screencast JPEG
      fresh: false,       // latest has not gone to the encoder yet
      frames: 0,          // screencast frames seen, which is how often the page changed
      ticks: 0,
      picks: [],          // { tick, buf } for each frame sent, for the stills
      encoder: null,
      format: '',
      width: 0,
      height: 0,
      clock: null,
      limit: null,
      onFirst: null,
      firstTimer: null,
      settleTimer: null,
      nudger: null,
      claimed: false,     // a `stop` call is waiting for this, so it is not left in `finished`
      endedBy: 'stop',
      ready: null,
      done: null,
      dropped: false,
    };
    this.#to('recording');
    this.rec = rec;
    this.finished = null;
    open.add(this);
    this.io.changed();
    rec.ready = this.#begin(rec);
    try {
      await rec.ready;
    } catch (e) {
      this.#release(rec);
      throw e;
    }
    return { ok: true, recording: true, maxSeconds: rec.maxSeconds };
  }

  async #begin(rec) {
    fs.mkdirSync(rec.dir, { recursive: true });
    const first = new Promise((resolve, reject) => {
      rec.onFirst = resolve;
      rec.firstTimer = setTimeout(() => reject(new Error('the preview drew no frame in 5 s, so there is nothing to record')), FIRST_FRAME_MS);
    });
    first.catch(() => {});
    rec.nudger = setInterval(() => this.#nudge(rec), NUDGE_MS);
    const opening = EncoderWindow.open().then((encoder) => {
      if (rec.dropped) encoder.close();
      else rec.encoder = encoder;
    });
    await Promise.all([
      opening,
      this.#cdp('Page.startScreencast', SCREENCAST),
    ]);
    const frame = await first;
    const info = await rec.encoder.init(frame);
    rec.format = info.mime.startsWith('video/mp4') ? 'mp4' : 'webm';
    rec.width = info.width;
    rec.height = info.height;
    rec.picks.push({ tick: 0, buf: frame });
    rec.fresh = rec.latest !== frame;
    rec.startedAt = Date.now();
    rec.clock = setInterval(() => this.#tick(rec), 1000 / rec.fps);
    rec.limit = setTimeout(() => this.#end(rec, 'limit'), rec.maxSeconds * 1000);
  }

  // A screencast frame from the pane's debugger. Every one has to be
  // acknowledged or Chromium stops sending.
  onFrame({ data, sessionId }) {
    this.#cdp('Page.screencastFrameAck', { sessionId }).catch(() => {});
    const rec = this.rec;
    if (!rec || this.phase !== 'recording') return;
    rec.latest = Buffer.from(data, 'base64');
    rec.fresh = true;
    rec.frames += 1;
    if (rec.onFirst) this.#settle(rec);
  }

  // The first frame sizes the video, so it has to be the page as it is now.
  #settle(rec) {
    if (this.#fits(rec.latest)) return this.#accept(rec);
    rec.settleTimer ??= setTimeout(() => this.#accept(rec), SETTLE_MS);
  }

  #fits(jpeg) {
    const want = this.io.size();
    const got = nativeImage.createFromBuffer(jpeg).getSize();
    return got.width >= want.width * 0.9 && got.height >= want.height * 0.9;
  }

  #accept(rec) {
    if (!rec.onFirst) return;
    clearTimeout(rec.firstTimer);
    clearTimeout(rec.settleTimer);
    clearInterval(rec.nudger);
    rec.onFirst(rec.latest);
    rec.onFirst = null;
  }

  #nudge(rec) {
    this.io.nudge();
    this.#cdp('Page.stopScreencast')
      .then(() => { if (this.rec === rec && this.phase === 'recording') return this.#cdp('Page.startScreencast', SCREENCAST); })
      .catch(() => {});
  }

  #tick(rec) {
    if (this.rec !== rec || this.phase !== 'recording') return;
    rec.ticks += 1;
    if (rec.fresh) {
      rec.fresh = false;
      rec.encoder.frame(rec.latest);
      rec.picks.push({ tick: rec.ticks, buf: rec.latest });
      if (rec.picks.length > PICKS) rec.picks = rec.picks.filter((_, i) => i % 2 === 0);
    }
    rec.encoder.tick();
  }

  async stop() {
    if (this.phase === 'idle') {
      const kept = this.finished;
      this.finished = null;
      if (kept) return kept;
      throw new Error('not recording. Call record start first.');
    }
    this.rec.claimed = true;
    return this.#finish(this.rec);
  }

  // Ends the recording for a reason of its own (the limit, the debugger going
  // away, the pane closing) and keeps what was recorded for the next `stop`.
  end(reason) {
    if (this.phase === 'recording') this.#end(this.rec, reason);
  }

  #end(rec, reason) {
    rec.endedBy = reason;
    this.#finish(rec).catch((e) => console.error(`[conn] recording ended by ${reason} but could not be saved: ${e.message}`));
  }

  #finish(rec) {
    if (this.rec === rec && this.phase === 'recording') {
      this.#to('stopping');
      rec.done = this.#seal(rec);
    }
    return rec.done;
  }

  async #seal(rec) {
    try {
      try { await rec.ready; } catch { throw new Error('not recording. Call record start first.'); }
      clearInterval(rec.clock);
      clearTimeout(rec.limit);
      this.#cdp('Page.stopScreencast').catch(() => {});
      if (rec.fresh) rec.encoder.frame(rec.latest);
      const seconds = (Date.now() - rec.startedAt) / 1000;
      const { bytes } = await rec.encoder.finish();

      const video = safeFilePath(rec.dir, rec.name, { ext: rec.format, prefix: 'recording', strip: ['mp4', 'webm'] });
      fs.writeFileSync(video, Buffer.from(bytes), { mode: 0o600 });
      const keyframes = this.#writeStills(rec, video);
      if (rec.keep) pruneRecordings(rec.dir, rec.keep);

      const result = {
        path: video,
        seconds: Math.round(seconds * 10) / 10,
        width: rec.width,
        height: rec.height,
        format: rec.format,
        frames: rec.frames,
        keyframes,
        ...(rec.endedBy === 'stop' ? {} : { endedBy: rec.endedBy }),
      };
      if (!rec.claimed) this.finished = result;
      return result;
    } finally {
      this.#release(rec);
    }
  }

  #writeStills(rec, video) {
    const at = rec.ticks / 2;
    const middle = [...rec.picks].reverse().find((p) => p.tick <= at) || rec.picks[0];
    const frames = [rec.picks[0].buf, middle.buf, rec.latest];
    return STILLS.map((which, i) => {
      const file = stillPath(video, which);
      fs.writeFileSync(file, frames[i], { mode: 0o600 });
      return file;
    });
  }

  // The recording is over, one way or another. Safe to call twice.
  #release(rec) {
    if (this.rec !== rec) return;
    rec.dropped = true;
    clearInterval(rec.clock);
    clearTimeout(rec.limit);
    clearTimeout(rec.firstTimer);
    clearTimeout(rec.settleTimer);
    clearInterval(rec.nudger);
    // A start that failed has left the screencast running.
    this.#cdp('Page.stopScreencast').catch(() => {});
    rec.encoder?.close();
    this.rec = null;
    this.#to('idle');
    open.delete(this);
    this.io.changed();
  }

  // The app is quitting: nothing is saved and nothing is left running.
  abort() {
    const rec = this.rec;
    if (!rec) return;
    rec.done?.catch(() => {});
    this.#release(rec);
  }
}

function abortAll() {
  for (const r of [...open]) r.abort();
  EncoderWindow.closeAll();
}

module.exports = { Recorder, abortAll, MAX_SECONDS };
