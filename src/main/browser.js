'use strict';
const { WebContentsView, nativeImage, app, net } = require('electron');
const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { normalizeUrl, isAllowedUrl, engineOf } = require('./url');
const { screenshotFilePath } = require('./screenshot-path');
const { ensurePrivateDir } = require('./private-dir');
const { Recorder } = require('./recorder');
const { modelFit, cut } = require('../shared/browser-tools');

// Electron's default user agent names the app and Electron, and Google's
// sign-in refuses any browser that says so ("This browser or app may not be
// secure"). Strip those tokens and the pane reads as the Chromium it is.
function chromeUserAgent(ua) {
  return String(ua).replace(/\s(conn|Electron)\/\S+/gi, '');
}

// Set app-wide so sign-in popups, which the pane does not create, get it too.
app.userAgentFallback = chromeUserAgent(app.userAgentFallback);

const PANE_PREFS = { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true };

function partitionFor(project) {
  const key = crypto.createHash('sha256').update(String(project || '')).digest('hex').slice(0, 16);
  return `persist:conn-${key}`;
}

const PAGE_SCRIPT = fs.readFileSync(path.join(__dirname, 'page-script.js'), 'utf8');
const RING = 300;
// In-flight requests only. A page that polls (an HMR socket, a dashboard) would
// otherwise leave one entry here per request for as long as the window is open.
const MAX_INFLIGHT = 500;
// Every screenshot the agent takes lands on disk and nothing ever collected
// them. Keep a working set; the agent only ever looks at the recent ones.
const MAX_SHOTS = 60;
// How long an action's result waits on the requests it started.
const SETTLE_MS = 1000;
// A page's handlers have run by the time an action returns, but what they set
// off can start a frame later: a framework's effect runs after its render.
// Measured in the pane, a request a fill starts itself reaches main within
// 1 ms of the fill returning, and one started on the next frame within 19 ms.
// 80 ms, the beat press and hover already take after their input, is about
// four frames.
const BEAT_MS = 80;
// A stream stays open for as long as the page wants it, so an action's
// result does not wait for one to finish: an EventSource or WebSocket from
// the start, a fetch once its answer says text/event-stream.
const STREAM_TYPES = new Set(['EventSource', 'WebSocket']);
// Electron's own notices land in the page's console from its bundled scripts.
// They are about the app, never the page, so they are not the page's errors.
const ELECTRON_SOURCE = /^(?:electron\/|node:electron\/|sandbox_bundle|renderer_init)/;
const MAX_RECORDINGS = 20;

const ERR_ABORTED = -3;
const isMainFrameNavFail = (isMainFrame, code) => isMainFrame && code !== ERR_ABORTED;

const KEY_ALIASES = {
  enter: 'Return', esc: 'Escape', escape: 'Escape', tab: 'Tab', backspace: 'Backspace',
  delete: 'Delete', up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  pageup: 'PageUp', pagedown: 'PageDown', home: 'Home', end: 'End', space: 'Space',
};

class BrowserPane extends EventEmitter {
  constructor(win, homeUrl, { project, searchEngine } = {}) {
    super();
    this.win = win;
    this.searchEngine = searchEngine || (() => undefined);
    this.popups = new Set();
    this.project = project || '';
    this.partition = partitionFor(this.project);
    this.console = [];
    this.network = [];
    this.seq = 0;                   // numbers every console and network row
    this.reported = null;           // the last row an action's result told
    this.reportedAt = 0;            // and when
    this.pending = new Set();
    this.reqs = new Map();          // requestId -> the bits needed to log a failure
    this.lastActivity = Date.now();
    this.debuggerAttached = false;
    this.visible = false;           // born parked; the window says when it is in the box
    this.box = { x: 4000, y: 40, width: 900, height: 760 }; // where the window wants the view
    this.borrowed = false;          // #awake has the view; the window's moves wait for it
    this.favicon = '';
    this.shotDir = ensurePrivateDir('conn-shots');
    this.#pruneShots();
    this.recorder = new Recorder({
      send: (method, params) => this.wc.debugger.sendCommand(method, params),
      attached: () => this.debuggerAttached,
      size: () => this.view.getBounds(),
      // A hidden view draws again when it is shown, even for the length of one
      // call, which is too short to reach the screen. One in the box already
      // draws, and hiding it to nudge it stops the frames.
      nudge: () => { if (!this.visible) { this.view.setVisible(true); this.view.setVisible(false); } },
      ended: (result) => this.emit('recorded', result),
      changed: () => { if (!this.wc.isDestroyed()) this.emit('state', this.state()); },
    });

    this.view = new WebContentsView({
      webPreferences: { ...PANE_PREFS, partition: this.partition },
    });
    this.wc = this.view.webContents;
    this.wc.setBackgroundThrottling(false); // it runs parked offscreen when the pane is closed
    win.contentView.addChildView(this.view);
    // Parked offscreen at a real size: the renderer refines this once it has
    // measured, but the page always has a viewport to lay out in.
    this.view.setBounds(this.box);

    this.#wireEvents();
    this.#attachDebugger();
    if (homeUrl) this.navigate(homeUrl).catch(() => {});
  }

  #wireEvents() {
    const wc = this.wc;
    const push = () => this.emit('state', this.state());

    wc.on('did-start-loading', push);
    wc.on('did-stop-loading', push);
    wc.on('page-title-updated', push);
    wc.on('did-navigate', () => { this.favicon = ''; push(); });
    wc.on('did-navigate-in-page', push);
    wc.on('did-finish-load', () => { this.#inject(); push(); });
    wc.on('dom-ready', () => this.#inject());
    wc.on('page-favicon-updated', (_e, favicons) => {
      this.favicon = (favicons && favicons[0]) || '';
      push();
    });
    // DevTools takes the debugger when it opens; take it back when it closes,
    // whoever closed it, or the pane is left without one.
    wc.on('devtools-closed', () => { if (!this.debuggerAttached) this.#attachDebugger(); });
    wc.debugger.on('message', (_e, method, params) => this.#onCdp(method, params));
    wc.debugger.on('detach', () => {
      this.debuggerAttached = false;
      this.recorder.end('detached');
    });
    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (isMainFrameNavFail(isMainFrame, code)) {
        this.#log(this.network, { kind: 'navigation-failed', url, code, desc });
        // failedUrl matters: after a failed load getURL() can still report the
        // previous page, and the error card needs the address that broke.
        this.emit('state', { ...this.state(), error: `${desc} (${code})`, failedUrl: url });
      }
    });
    wc.on('console-message', (_e, level, message, line, sourceId) => {
      const levels = ['debug', 'info', 'warning', 'error'];
      this.emit('console', this.#log(this.console, { level: levels[level] || String(level), message, source: `${sourceId}:${line}` }));
    });
    this.#guardOpens(wc);
    wc.on('will-navigate', (e, url) => {
      if (!isAllowedUrl(url)) e.preventDefault();
    });
  }

  /* How the pane and every window it opens handle window.open. A scripted
     popup (window.open with features) is a sign-in flow: Google, GitHub and
     the rest report back through window.opener, so it has to be a real window
     that keeps its opener. That holds for a popup's own popups too, so a 2FA
     helper opened from the sign-in window does not replace it. Plain
     target=_blank links open in the pane rather than in a detached window. */
  #guardOpens(wc) {
    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (!isAllowedUrl(url)) return { action: 'deny' };
      if (disposition === 'new-window') {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            // Read now, not when the pane was made: a popped-out pane lives in
            // another window, and its popups belong in front of that one.
            parent: this.win,
            autoHideMenuBar: true,
            webPreferences: { ...PANE_PREFS, partition: this.partition },
          },
        };
      }
      this.navigate(url).catch(() => {});
      return { action: 'deny' };
    });
    wc.on('did-create-window', (child) => {
      // A sign-in window belongs to its pane and goes when the pane does.
      this.popups.add(child);
      child.once('closed', () => this.popups.delete(child));
      child.webContents.on('will-navigate', (e, url) => { if (!isAllowedUrl(url)) e.preventDefault(); });
      this.#guardOpens(child.webContents);
    });
  }

  async #attachDebugger() {
    try {
      this.wc.debugger.attach('1.3');
      this.debuggerAttached = true;
      await this.wc.debugger.sendCommand('Network.enable');
    } catch (err) {
      this.debuggerAttached = false;
    }
  }

  #onCdp(method, p) {
    if (method === 'Page.screencastFrame') return this.recorder.onFrame(p);
    this.lastActivity = Date.now();
    if (method === 'Network.requestWillBeSent') {
      this.pending.add(p.requestId);
      // Chromium does not promise a terminal event for every request: a page
      // torn down mid-flight simply stops reporting. Drop the oldest rather
      // than trust that each entry gets claimed.
      if (this.reqs.size >= MAX_INFLIGHT) {
        const oldest = this.reqs.keys().next().value;
        this.reqs.delete(oldest);
        this.pending.delete(oldest);
      }
      this.reqs.set(p.requestId, { url: p.request.url, method: p.request.method, t: Date.now(), ...(STREAM_TYPES.has(p.type) ? { stream: true } : {}) });
    } else if (method === 'Network.responseReceived') {
      const r = this.reqs.get(p.requestId);
      if (r) {
        r.status = p.response.status;
        r.type = p.type;
        if (p.response.mimeType === 'text/event-stream') r.stream = true;
        if (p.response.status >= 400) {
          this.#log(this.network, { kind: 'http', ...r });
        }
      }
    } else if (method === 'Network.loadingFailed') {
      const r = this.reqs.get(p.requestId) || {};
      this.reqs.delete(p.requestId);
      this.pending.delete(p.requestId);
      if (!p.canceled) {
        this.#log(this.network, { kind: 'failed', url: r.url, method: r.method, error: p.errorText });
      }
    } else if (method === 'Network.loadingFinished') {
      this.reqs.delete(p.requestId);
      this.pending.delete(p.requestId);
    }
  }

  // `t` is when the row was logged, even for a request row, which is built
  // from the request's own entry and its start time.
  #log(list, row) {
    const entry = { ...row, t: Date.now(), n: ++this.seq };
    list.push(entry);
    if (list.length > RING) list.shift();
    return entry;
  }

  async #inject() {
    try { await this.wc.executeJavaScript(PAGE_SCRIPT, true); } catch { /* page may be gone */ }
  }

  // executeJavaScript reports every throw as "Script failed to execute", which
  // tells the agent nothing. Catch inside the page and carry the message out.
  async #js(expr) {
    await this.#inject();
    const wrapped = `(async () => { try { return { v: await (${expr}) }; } catch (e) { return { e: String(e && e.message || e) }; } })()`;
    const r = await this.wc.executeJavaScript(wrapped, true);
    if (r && r.e) throw new Error(r.e);
    return r ? r.v : r;
  }

  setBounds(b) {
    this.bounds = b;
    this.box = {
      x: Math.round(b.x), y: Math.round(b.y),
      width: Math.max(0, Math.round(b.width)), height: Math.max(0, Math.round(b.height)),
    };
    if (this.borrowed) return;
    this.view.setBounds(this.box);
    if (this.viewport) this.#emulate().catch(() => {});
  }

  setVisible(v) {
    this.visible = v;
    if (!this.borrowed) this.view.setVisible(v);
  }

  // The project this pane belonged to has closed. A WebContentsView left in the
  // window keeps a renderer process alive and holds the debugger open, and
  // neither of those has anything left to show, so both go.
  dispose() {
    this.recorder.end('closed');
    try { if (this.debuggerAttached) this.wc.debugger.detach(); } catch {}
    this.debuggerAttached = false;
    try { this.win.contentView.removeChildView(this.view); } catch {}
    try { this.wc.close(); } catch {}
    for (const w of this.popups) { try { if (!w.isDestroyed()) w.destroy(); } catch {} }
    this.popups.clear();
    this.removeAllListeners();
  }

  // A still of the page, for the shell to paint in the pane's place while the
  // real view is hidden. Nothing lands on disk: this is thrown away seconds
  // later, and screenshot() is the one that keeps a file.
  async still() {
    try {
      // Cropped to the view: under an emulated viewport the capture comes back
      // at the emulated size, with the scaled page in its corner.
      const { width, height } = this.view.getBounds();
      const img = await this.wc.capturePage({ x: 0, y: 0, width, height });
      return img.isEmpty() ? null : img.toDataURL();
    } catch {
      return null;
    }
  }

  state() {
    return {
      url: this.wc.getURL(),
      title: this.wc.getTitle(),
      loading: this.wc.isLoading(),
      canGoBack: this.wc.navigationHistory.canGoBack(),
      canGoForward: this.wc.navigationHistory.canGoForward(),
      favicon: this.favicon || '',
      // The agent can set this too, and the shell has to draw the frame for it.
      viewport: this.viewport ? `${this.viewport.width}x${this.viewport.height}` : '',
      recording: this.recorder.recording,
    };
  }

  // --- agent-facing tools -------------------------------------------------

  async navigate(url, { timeout = 30000 } = {}) {
    let target;
    try {
      target = normalizeUrl(url, { engine: this.searchEngine() });
    } catch (e) {
      const err = e.message || String(e);
      this.emit('state', { ...this.state(), error: err, failedUrl: String(url) });
      return { ...this.state(), requested: String(url), error: err };
    }
    const done = new Promise((res) => {
      const finish = () => { clearTimeout(t); cleanup(); res(); };
      const fail = (_e, code, desc, _url, isMainFrame) => {
        if (!isMainFrameNavFail(isMainFrame, code)) return;
        clearTimeout(t);
        cleanup();
        res({ error: `${desc} (${code})` });
      };
      const cleanup = () => {
        this.wc.off('did-finish-load', finish);
        this.wc.off('did-fail-load', fail);
      };
      const t = setTimeout(() => { cleanup(); res({ warning: 'load timed out, returning current state' }); }, timeout);
      this.wc.once('did-finish-load', finish);
      this.wc.on('did-fail-load', fail);
    });
    this.console.length = 0;
    this.network.length = 0;
    // These describe the page being left. waitFor({networkIdle}) reads
    // pending.size, so a stale entry here hangs the next wait to its timeout.
    this.reqs.clear();
    this.pending.clear();
    let loadError = null;
    let superseded = false;
    await this.wc.loadURL(target).catch((e) => {
      // Another navigation started before this one finished, so this load was
      // dropped for it. That is not a page failing to load, and reporting it as
      // one put the error card over the page that did load.
      if (e.errno === ERR_ABORTED || e.code === 'ERR_ABORTED') superseded = true;
      else loadError = e.message;
    });
    if (superseded) return { ...this.state(), requested: target, warning: 'superseded by another navigation' };
    const r = await done;
    await this.#inject();
    const out = { ...this.state(), requested: target, ...(loadError ? { error: loadError } : {}), ...(r || {}) };
    if (out.error) {
      this.emit('state', { ...this.state(), error: out.error, failedUrl: target });
    }
    return out;
  }

  async back() {
    if (!this.wc.navigationHistory.canGoBack()) return { ...this.state(), note: 'no earlier entry in history' };
    this.wc.navigationHistory.goBack();
    await settle(this.wc);
    return this.state();
  }
  async forward() {
    if (!this.wc.navigationHistory.canGoForward()) return { ...this.state(), note: 'no later entry in history' };
    this.wc.navigationHistory.goForward();
    await settle(this.wc);
    return this.state();
  }
  async reload() { this.wc.reload(); await settle(this.wc); return this.state(); }
  async hardReload() { this.wc.reloadIgnoringCache(); await settle(this.wc); return this.state(); }
  async clearData(kind) {
    const ses = this.wc.session;
    if (kind === 'cache') await ses.clearCache();
    else if (kind === 'cookies') await ses.clearStorageData({ storages: ['cookies'] });
    else if (kind === 'history') {
      try { this.wc.navigationHistory.clear(); } catch { /* older electron */ }
    }
    return { ok: true };
  }
  async stop() { this.wc.stop(); return this.state(); }

  async snapshot(opts = {}) {
    await this.#settled();
    return this.#js(`window.__conn.snapshot(${JSON.stringify(opts)})`);
  }

  // The defaults are what the conn CLI prints. An agent's tools ask for less
  // (READ in shared/browser-tools.js), and a cut says how much there was.
  async text(max) {
    const cap = Number(max) || 20000;
    const t = await this.#js('window.__conn.text()');
    return t.length > cap ? `${cut(t, cap)}\n… truncated at ${cap} of ${t.length} characters; pass max for more` : t;
  }

  async html(max) {
    const cap = Number(max) || 200000;
    // Without Conn's own pointer, whose reset style alone runs to 5,000
    // characters and is not the page's. The copy is made in a document of its
    // own, which loads nothing: a copy made in the page fetches its images again.
    const h = await this.#js(`(() => { const d = document.implementation.createHTMLDocument('').importNode(document.documentElement, true);
      d.querySelectorAll('#__conn-cursor, [data-conn-ripple]').forEach((n) => n.remove());
      return d.outerHTML; })()`);
    return h.length > cap ? `${cut(h, cap)}\n<!-- truncated at ${cap} of ${h.length} characters; pass max for more -->` : h;
  }

  // Until the page has drawn a frame, Chromium has nothing to hit-test a press
  // against and drops it, though the move before it gets through. A page that
  // has just loaded often has not drawn yet. One the window is about to put in
  // the box draws once it is there, so that wait comes first: waking a tab
  // while the window moves it into the box shifts it under the press. A tab
  // that is still parked after it, such as a subagent's behind the person's,
  // only draws while #awake shows it.
  async click(target, opts = {}) {
    if (await this.#drawn()) return this.#press(target, opts);
    if (this.visible) throw new Error('the page has not drawn a frame in 2 s, so the click was not sent');
    return this.#awake(async () => {
      if (!await this.#drawn()) throw new Error('the page has not drawn a frame in 2 s, so the click was not sent');
      return this.#press(target, opts);
    });
  }

  /* The window brings a view into the box over several frames: shown off
     the window's edge, then at no size, then grown to the column, and the
     page inside still reports its old size until it lays out again. A view
     with no size or off the window has no surface to copy ("Current display
     surface not available for capture"), and a page laid out at no size has
     a 1x1 viewport in which every element looks hidden. Calls a model round
     trip apart never met that; a batch's next step does. So a read waits for
     the window to finish: the view parked, or in the box at a real size and
     drawn there once. A parked view draws nothing until #awake shows it. */
  async #settled() {
    const until = Date.now() + 2000;
    while (this.#moving() && Date.now() < until) await sleep(16);
    if (this.visible) await this.#drawn();
  }

  #moving() {
    const b = this.box;
    if (!b.width || !b.height) return true;
    if (!this.visible) return false;
    const [w, h] = this.win.getContentSize();
    return b.x >= w || b.y >= h || b.x + b.width <= 0 || b.y + b.height <= 0;
  }

  #drawn() {
    return this.#js(`Promise.race([
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))),
      new Promise((r) => setTimeout(() => r(false), 2000)),
    ])`);
  }

  async #press(target, { button = 'left', clickCount = 1, modifiers = [] }) {
    const p = await this.#js(`window.__conn.point(${JSON.stringify(target)}, "click")`);
    const base = { x: Math.round(p.x), y: Math.round(p.y), button, modifiers };
    this.wc.sendInputEvent({ type: 'mouseMove', ...base });
    this.wc.sendInputEvent({ type: 'mouseDown', ...base, clickCount });
    this.wc.sendInputEvent({ type: 'mouseUp', ...base, clickCount });
    await sleep(120);
    return { ok: true, clicked: target, at: base };
  }

  async hover(target) {
    return this.#awake(async () => {
      const p = await this.#js(`window.__conn.point(${JSON.stringify(target)}, "move")`);
      this.wc.sendInputEvent({ type: 'mouseMove', x: Math.round(p.x), y: Math.round(p.y) });
      await sleep(80);
      return { ok: true };
    });
  }

  async fill(target, value) { return this.#js(`window.__conn.fill(${JSON.stringify(target)}, ${JSON.stringify(value)})`); }
  async select(target, value) { return this.#js(`window.__conn.select(${JSON.stringify(target)}, ${JSON.stringify(value)})`); }

  async type(text, { target, delay = 12 } = {}) {
    return this.#awake(async () => {
      if (target) await this.#js(`window.__conn.focus(${JSON.stringify(target)})`);
      for (const ch of String(text)) {
        this.#sendKey(ch);
        if (delay) await sleep(delay);
      }
      return { ok: true, typed: text.length };
    });
  }

  async press(key, { modifiers = [] } = {}) {
    const parts = String(key).split('+');
    const raw = parts.pop();
    const mods = [...modifiers, ...parts.map((m) => m.toLowerCase().replace('cmd', 'meta').replace('ctrl', 'control'))];
    const keyCode = KEY_ALIASES[raw.toLowerCase()] || raw;
    return this.#awake(async () => {
      this.#sendKey(keyCode, mods);
      await sleep(80);
      return { ok: true, key: `${mods.join('+')}${mods.length ? '+' : ''}${keyCode}` };
    });
  }

  #sendKey(keyCode, modifiers = []) {
    this.wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    // Chromium only runs the default action (implicit form submit, text entry)
    // when a char event follows the keydown.
    if (keyCode.length === 1) this.wc.sendInputEvent({ type: 'char', keyCode, modifiers });
    else if (keyCode === 'Return') this.wc.sendInputEvent({ type: 'char', keyCode: '\r', modifiers });
    else if (keyCode === 'Tab') this.wc.sendInputEvent({ type: 'char', keyCode: '\t', modifiers });
    this.wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  }

  async scroll(dy = 400, dx = 0) { return this.#js(`window.__conn.scroll(${Number(dy)}, ${Number(dx)})`); }
  async scrollTo(target) { return this.#js(`window.__conn.scrollTo(${JSON.stringify(target)})`); }
  async highlight(target) { return this.#js(`window.__conn.highlight(${JSON.stringify(target)})`); }

  async pick() {
    this.wc.focus(); // the human is about to move the mouse over the pane
    return this.#js('window.__conn.pick()');
  }

  async cancelPick() {
    return this.#js('window.__conn.cancelPick && window.__conn.cancelPick()');
  }

  async evaluate(code) {
    const value = await this.wc.executeJavaScript(wrapEvaluate(code), true);
    return value === undefined ? null : value;
  }

  async waitFor({ selector, ms, networkIdle, timeout = 10000 } = {}) {
    if (ms) { await sleep(ms); return { ok: true, waited: ms }; }
    if (selector) { await this.#js(`window.__conn.waitFor(${JSON.stringify(selector)}, ${timeout})`); return { ok: true, selector }; }
    if (networkIdle !== false) {
      const started = Date.now();
      let quietSince = Date.now();
      while (Date.now() - started < timeout) {
        if (this.pending.size === 0 && !this.wc.isLoading()) {
          if (Date.now() - quietSince > 500) return { ok: true, idle: true };
        } else quietSince = Date.now();
        await sleep(100);
      }
      return { ok: true, idle: false, note: 'timed out waiting for network idle' };
    }
    return { ok: true };
  }

  /* A parked view draws no frames, so there is nothing to copy a screenshot
     from and nothing to hit-test a mouse or key event against, and a tab
     parked behind another is exactly what an agent working off screen drives.
     For the length of one capture or input the view is shown one pixel large
     in the window's corner, laid out at its own size, so the renderer draws it
     and nobody sees it. Shown under the pane in the box
     instead, it drew one frame and then stopped as occluded; off the window it
     never drew at all.

     The window can move the tab into the box mid-capture. A size it gave the
     view while the override held was lost when the override went, and the
     page stayed laid out at one pixel. So while the view is borrowed the
     window's moves are only noted, and land once the override is gone. */
  async #awake(fn) {
    if (this.visible || !this.debuggerAttached) return fn(false);
    // A screencast keeps the view drawing at its own size. Shrinking it to one
    // pixel for the capture would put that size in the video.
    if (this.recorder.recording) return fn(true);
    const { width, height } = this.viewport || this.box;
    this.borrowed = true;
    this.view.setBounds({ x: 0, y: 0, width: 1, height: 1 });
    this.view.setVisible(true);
    try {
      await this.wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 0, mobile: false });
      return await fn(true);
    } finally {
      if (this.viewport) await this.#emulate().catch(() => {});
      else await this.wc.debugger.sendCommand('Emulation.clearDeviceMetricsOverride').catch(() => {});
      this.borrowed = false;
      this.view.setBounds(this.box);
      this.view.setVisible(this.visible);
    }
  }

  // The visible page, or `clip` of it. A woken view is read through the
  // debugger, which asks the renderer for a frame rather than copying one the
  // compositor may not have yet.
  async #grab(clip, woken) {
    if (!woken) return this.wc.capturePage(clip);
    const res = await this.wc.debugger.sendCommand('Page.captureScreenshot', {
      format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
    });
    return nativeImage.createFromBuffer(Buffer.from(res.data, 'base64'));
  }

  // `clip` is a box in the viewport, { x, y, w, h }, for an area picked by hand.
  // The PNG is the whole capture, for people and the screenshot library;
  // `model` is the small JPEG beside it that the agent is actually sent.
  async screenshot({ fullPage = false, target, clip, name, detail } = {}) {
    // The pointer the last action left on the page is for the human watching
    // the pane, not for whoever reads this file.
    await this.#js('window.__conn.cursorHide()').catch(() => {});
    await this.#settled();
    const image = await this.#awake(async (woken) => {
      if (clip) {
        return this.#grab({
          x: Math.max(0, Math.round(clip.x)), y: Math.max(0, Math.round(clip.y)),
          width: Math.max(1, Math.round(clip.w)), height: Math.max(1, Math.round(clip.h)),
        }, woken);
      }
      if (target) {
        const p = await this.#js(`window.__conn.point(${JSON.stringify(target)})`);
        const r = p.rect;
        return this.#grab({
          x: Math.max(0, Math.round(r.x)), y: Math.max(0, Math.round(r.y)),
          width: Math.round(r.w), height: Math.round(r.h),
        }, woken);
      }
      if (fullPage && this.debuggerAttached) {
        const metrics = await this.wc.debugger.sendCommand('Page.getLayoutMetrics');
        const cs = metrics.cssContentSize || metrics.contentSize;
        const res = await this.wc.debugger.sendCommand('Page.captureScreenshot', {
          format: 'png', captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: cs.width, height: Math.min(cs.height, 20000), scale: 1 },
        });
        return nativeImage.createFromBuffer(Buffer.from(res.data, 'base64'));
      }
      return this.#grab(undefined, woken);
    });
    const file = screenshotFilePath(this.shotDir, name);
    const png = image.toPNG();
    fs.writeFileSync(file, png, { mode: 0o600 });
    const model = modelCopy(png, file, { high: detail === 'high', fullPage: fullPage && !clip && !target });
    this.#pruneShots();
    const size = image.getSize();
    return { path: file, width: size.width, height: size.height, model };
  }

  async record({ action, name, maxSeconds } = {}, { library = false } = {}) {
    if (action === 'start') {
      if (library && !name) name = `conn-recording-${new Date().toLocaleString('sv').replace(/[: ]/g, '-')}`;
      const where = library
        ? { dir: path.join(app.getPath('videos'), 'Conn'), keep: null }
        : { dir: ensurePrivateDir('conn-recordings'), keep: MAX_RECORDINGS };
      return this.recorder.start({ ...where, name, maxSeconds, announce: library });
    }
    if (action === 'stop') return this.recorder.stop();
    throw new Error('record needs action "start" or "stop"');
  }

  // Oldest first, by mtime. Cheap enough to run after each capture: the cap is
  // small and readdir on a flat temp folder is not worth scheduling around.
  // A shot's model copy goes with it.
  #pruneShots() {
    try {
      const files = fs.readdirSync(this.shotDir)
        .filter((f) => f.endsWith('.png'))
        .map((f) => {
          const full = path.join(this.shotDir, f);
          try { return { full, at: fs.statSync(full).mtimeMs }; } catch { return null; }
        })
        .filter(Boolean);
      if (files.length <= MAX_SHOTS) return;
      files.sort((a, b) => a.at - b.at);
      for (const { full } of files.slice(0, files.length - MAX_SHOTS)) {
        try { fs.unlinkSync(full); } catch {}
        try { fs.unlinkSync(modelPath(full)); } catch {}
      }
    } catch {}
  }

  /* The view is the device frame the shell drew, in window pixels: shrunk to
     fit the pane and grown by the shell's zoom. The page lays out at the size
     asked for either way, so it is scaled to the frame, or a desktop size
     comes out cropped and a phone size leaves a gutter. */
  async #emulate() {
    const { width, height } = this.viewport;
    const frame = this.bounds?.width;
    const scale = frame > 0 ? frame / width : 1;
    await this.wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 0, mobile: false, scale,
    });
  }

  async setViewport(width, height) {
    if (!this.debuggerAttached) return { error: 'debugger not attached' };
    this.viewport = { width: Math.round(width), height: Math.round(height) };
    await this.#emulate();
    this.emit('state', this.state());
    return { ok: true, width, height };
  }

  async clearViewport() {
    this.viewport = null;
    this.emit('state', this.state());
    if (!this.debuggerAttached) return { ok: true };
    await this.wc.debugger.sendCommand('Emulation.clearDeviceMetricsOverride');
    return { ok: true };
  }

  consoleLog({ level, limit = 50 } = {}) {
    let list = this.console;
    if (level) list = list.filter((c) => c.level === level);
    return list.slice(-limit);
  }

  networkLog({ limit = 50 } = {}) { return this.network.slice(-limit); }

  /* An action's report: the console errors and warnings and the failed
     requests the page logged in its window, as rows, for the action's own
     result. The window opens where the last report closed, so each row is
     told once, and one that came between two actions is told by the second,
     its time saying it came before that action began (`since`). The first
     report on a pane starts at its action. After the beat, requests the
     action set off get up to SETTLE_MS to finish, so a click whose fetch
     fails says so; with none in flight it returns then. */
  async caused(since) {
    await sleep(BEAT_MS);
    const until = Date.now() + SETTLE_MS;
    const busy = () => [...this.reqs.values()].some((r) => r.t >= since && !r.stream);
    if (busy()) {
      while (busy() && Date.now() < until) await sleep(50);
      await sleep(50); // a page's own catch logs a beat after the failure
    }
    const told = this.reported;
    const fresh = (r) => (told === null ? r.t >= since : r.n > told);
    const rows = [
      ...this.console.filter((c) => fresh(c) && (c.level === 'error' || c.level === 'warning') && !ELECTRON_SOURCE.test(String(c.source || '')))
        .map((c) => ({ kind: 'console', level: c.level, text: c.message, source: c.source, t: c.t, n: c.n })),
      ...this.network.filter(fresh).map((r) => (r.kind === 'navigation-failed'
        ? { kind: 'request', page: true, status: `${r.desc} (${r.code})`, text: r.url, t: r.t, n: r.n }
        : { kind: 'request', status: r.status || r.error, method: r.method, text: r.url, t: r.t, n: r.n })),
    ].sort((a, b) => a.n - b.n);
    const from = told === null ? since : this.reportedAt;
    this.reported = this.seq;
    this.reportedAt = Date.now();
    return { from, since, until: this.reportedAt, rows };
  }

  // Docked under the page, or in a window of its own.
  toggleDevTools(detached = false) {
    if (this.wc.isDevToolsOpened()) this.wc.closeDevTools();
    else this.#openDevTools(detached);
    return { open: this.wc.isDevToolsOpened() };
  }

  // DevTools cannot change dock while open, so it is closed and opened again.
  // Opening it from inside devtools-closed does nothing, so the reopen waits a
  // tick. The devtools-closed handler takes the debugger back first, and
  // opening gives it up again.
  redockDevTools(detached) {
    if (!this.wc.isDevToolsOpened()) return;
    this.wc.once('devtools-closed', () => setTimeout(() => {
      if (!this.wc.isDestroyed()) this.#openDevTools(detached);
    }, 0));
    this.wc.closeDevTools();
  }

  #openDevTools(detached) {
    if (this.debuggerAttached) { try { this.wc.debugger.detach(); } catch {} this.debuggerAttached = false; }
    this.wc.openDevTools({ mode: detached ? 'detach' : 'bottom' });
  }

  // Which window the view is painted in. A page moved into a window of its own
  // keeps its tab, its history and its debugger; only the parent changes.
  moveTo(win) {
    if (win === this.win) return;
    try { this.win.contentView.removeChildView(this.view); } catch {}
    this.win = win;
    win.contentView.addChildView(this.view);
    // Open sign-in windows follow the pane, or they sit behind the window it
    // moved to.
    for (const w of this.popups) { try { if (!w.isDestroyed()) w.setParentWindow(win); } catch {} }
  }
}

// Whether code is a single expression can't be guessed from its shape (an
// arrow function has a `=>` but is still one expression; `const x = 1` has
// neither `return` nor `=>` but is a statement). Ask a real parser instead:
// `new Function` throws a SyntaxError for the expression form without running
// anything, so the wrong guess never reaches the page. Code that already uses
// `return` keeps working: wrapping it as an expression is itself a syntax
// error, which is exactly what sends it down the statement path.
//
// The closing wrapper always goes on its own line: code ending in a `//`
// comment (`document.title // x`) would otherwise swallow whatever came next
// on the same line, `) })()` included, into the comment.
function wrapEvaluate(code) {
  const asExpression = `(async () => { return (${code}\n) })()`;
  try {
    new Function(`return ${asExpression}`); // eslint-disable-line no-new-func
    return asExpression;
  } catch {
    return `(async () => { ${code}\n})()`;
  }
}

// The copy of a screenshot the agent is sent, encoded once here so the stdio
// MCP server, which has no nativeImage, only has to read a file. Decoded from
// the PNG rather than resized off the capture, so the sizes are the file's own
// pixels whatever the display's scale factor.
const SHOT_QUALITY = 78;
const modelPath = (png) => png.replace(/\.png$/, '.sent.jpg');

function modelCopy(png, file, opts) {
  const flat = nativeImage.createFromBuffer(png);
  const { width, height } = flat.getSize();
  const fit = modelFit(width, height, opts);
  let img = fit.cropped ? flat.crop({ x: 0, y: 0, width, height: fit.cropHeight }) : flat;
  if (fit.width !== width) img = img.resize({ width: fit.width, height: fit.height, quality: 'good' });
  const out = modelPath(file);
  fs.writeFileSync(out, img.toJPEG(SHOT_QUALITY), { mode: 0o600 });
  return { path: out, width: fit.width, height: fit.height, mime: 'image/jpeg', ...(fit.cropped ? { cropped: true } : {}) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = (wc) => new Promise((res) => {
  const t = setTimeout(res, 8000);
  wc.once('did-stop-loading', () => { clearTimeout(t); res(); });
});

// What the address bar shows under a half-typed phrase. Fetched here rather
// than in the window, whose content policy keeps it off the network, and on
// the default session so a search engine never sees the pane's cookies. Any
// failure is an empty list: suggestions are a nicety, never an error.
const SUGGEST_MAX = 6;
const SUGGEST_TIMEOUT_MS = 1500;

async function searchSuggestions(query, engine) {
  const q = String(query || '').trim();
  if (!q || q.length > 200) return [];
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), SUGGEST_TIMEOUT_MS);
  try {
    const { suggest, parse } = engineOf(engine);
    const res = await net.fetch(suggest(q), { signal: ctrl.signal, credentials: 'omit' });
    if (!res.ok || res.status === 204) return [];
    const list = parse(JSON.parse(await res.text()));
    return list.filter((v) => typeof v === 'string' && v).slice(0, SUGGEST_MAX);
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

module.exports = { searchSuggestions, BrowserPane, normalizeUrl, isAllowedUrl, partitionFor, wrapEvaluate, chromeUserAgent };
