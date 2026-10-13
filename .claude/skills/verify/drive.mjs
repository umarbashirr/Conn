#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const FIXTURE = path.join(HERE, 'fixtures', 'shop');
const SHOTS = process.env.CONN_VERIFY_SHOTS || path.join(os.tmpdir(), 'verify-evidence');
const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms, every = 150) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(every);
  }
  return last;
}

const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };

const link = (file) => { try { return fs.readlinkSync(file); } catch { return ''; } };

const statOf = (pid) => {
  const t = read(`/proc/${pid}/stat`);
  const [state, ppid, pgrp] = t.slice(t.lastIndexOf(')') + 2).split(' ');
  return { state, ppid: Number(ppid), pgrp: Number(pgrp) };
};

const ancestors = () => {
  const seen = new Set([process.pid]);
  for (let p = process.ppid; p > 1 && !seen.has(p); p = statOf(p).ppid) seen.add(p);
  return seen;
};

/* Electron and its helpers carry the session's --user-data-dir, and have no
   environment to read, because Chromium overwrites it when it sets the process
   title. */
const marks = (s) => [
  (p) => read(`/proc/${p}/cmdline`).includes(`--user-data-dir=${s.userData}`),
  (p) => read(`/proc/${p}/cmdline`).includes(`${s.home}/`),
  (p) => `\0${read(`/proc/${p}/environ`)}`.includes(`\0HOME=${s.home}\0`),
  (p) => { const cwd = link(`/proc/${p}/cwd`); return cwd === s.dir || cwd.startsWith(`${s.dir}/`); },
];

export const heldBy = (s) => {
  const mine = ancestors();
  const named = marks(s);
  return fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p) && !mine.has(Number(p)) && named.some((mark) => mark(p)));
};

async function cdp(url) {
  const ws = new WebSocket(url);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = () => fail(new Error(`cannot reach ${url}`)); });
  let seq = 0;
  const waiting = new Map();
  const handlers = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && waiting.has(msg.id)) {
      const { ok, fail } = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) fail(new Error(msg.error.message)); else ok(msg.result);
    } else if (msg.method) handlers.get(msg.method)?.(msg.params);
  };
  const send = (method, params = {}) => new Promise((ok, fail) => {
    const id = ++seq;
    waiting.set(id, { ok, fail });
    ws.send(J({ id, method, params }));
  });
  const run = async (expression, awaitPromise = false) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
      .catch((e) => { throw new Error(`${e.message}, evaluating ...${expression.replace(/\s+/g, ' ').slice(-120)}`); });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    return res.result.value;
  };
  return { send, run, on: (method, fn) => handlers.set(method, fn), close: () => ws.close() };
}

async function connect(port, pick) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const hit = list.find(pick);
  if (!hit) throw new Error(`nothing to debug on port ${port}`);
  return cdp(hit.webSocketDebuggerUrl);
}

async function using(open, fn) {
  const c = await open;
  try { return await fn(c); } finally { c.close(); }
}

const page = (s, fn) => using(connect(s.cdp, (t) => t.type === 'page' && /index\.html/.test(t.url)), fn);
const main = (s, fn) => using(connect(s.inspect, (t) => t.type === 'node'), fn);

const mainPrefix = (s) => `const req = process.getBuiltinModule('module').createRequire(${J(path.join(s.root, 'src/main/index.js'))}); const electron = req('electron');`;

export const evaluate = (s, expression, { main: inMain = false, awaitPromise = false } = {}) => (inMain
  ? main(s, (c) => c.run(`(() => { ${mainPrefix(s)} return (${expression}); })()`, awaitPromise))
  : page(s, (c) => c.run(expression, awaitPromise)));

function assertMadeByBoot(s) {
  const dir = s?.dir;
  const madeByBoot = typeof dir === 'string' && path.resolve(dir) === dir
    && path.dirname(dir) === path.resolve(os.tmpdir()) && path.basename(dir).startsWith('conn-verify-')
    && s.home === path.join(dir, 'home') && s.userData === path.join(dir, 'userdata') && s.project === path.join(dir, 'shop')
    && Number.isInteger(s.pid) && s.pid > 1;
  if (!madeByBoot) throw new Error(`refusing to touch ${dir}: a session is a conn-verify-* folder directly under ${os.tmpdir()}`);
}

export const load = (dir) => {
  const file = path.join(dir, 'session.json');
  if (!fs.existsSync(file)) throw new Error(`no session at ${dir}; was it stopped?`);
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assertMadeByBoot(s);
  return s;
};

export function sessions() {
  const tmp = path.resolve(os.tmpdir());
  return fs.readdirSync(tmp).filter((name) => name.startsWith('conn-verify-')).flatMap((name) => {
    try {
      const s = JSON.parse(read(path.join(tmp, name, 'session.json')));
      assertMadeByBoot(s);
      return s.driver === HERE ? [{ ...s, running: heldBy(s).length > 0 }] : [];
    } catch { return []; }
  });
}

const standIn = `(() => {
  const { ipcMain, BrowserWindow, View } = electron;
  const { AgentSession } = req('./agent');
  globalThis.__decided = [];
  globalThis.__bounds = [];
  AgentSession.prototype.start = async function start() {
    globalThis.__agent = this;
    this.sessionId = '7a7a7a7a-0000-4000-8000-000000000001';
    setTimeout(() => this.emit('ready', { sessionId: this.sessionId }), 0);
  };
  AgentSession.prototype.send = function send() {};
  AgentSession.prototype.models = async function models() { return []; };
  AgentSession.prototype.decide = function decide(id, decision, input) { globalThis.__decided.push({ id, decision, input }); };
  ipcMain.on('browser:bounds', (_e, b) => { globalThis.__bounds.push(b); if (globalThis.__bounds.length > 50) globalThis.__bounds.shift(); });
  const setVisible = View.prototype.setVisible;
  View.prototype.setVisible = function setVisibleAndRemember(v) { this.__shown = v; return setVisible.call(this, v); };
  globalThis.__preview = async (format) => {
    const win = BrowserWindow.getAllWindows()[0];
    const { width, height } = win.getContentBounds();
    const layers = [];
    for (const view of win.contentView.children) {
      const b = view.getBounds();
      const inWindow = b.width > 0 && b.height > 0 && b.x < width && b.y < height && b.x + b.width > 0 && b.y + b.height > 0;
      const wc = view.webContents;
      if (!inWindow || view.__shown === false || !wc || wc.isDestroyed()) continue;
      let image = await wc.capturePage();
      if (image.isEmpty()) image = await wc.capturePage();
      layers.push({ ...b, image: image.isEmpty() ? null : (format === 'jpeg' ? image.toJPEG(85) : image.toPNG()).toString('base64') });
    }
    return { width, height, layers };
  };
  return true;
})()`;

const save = (s) => fs.writeFileSync(path.join(s.dir, 'session.json'), J(s));

export async function boot({ root = ROOT, xvfb = false } = {}) {
  if (!fs.existsSync(path.join(root, 'build', 'renderer', 'index.html'))) throw new Error('no renderer build: run `npx vite build` first');
  const began = Date.now();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-verify-'));
  const s = { dir, root, driver: HERE, startedAt: new Date().toISOString(), home: path.join(dir, 'home'), project: path.join(dir, 'shop'), userData: path.join(dir, 'userdata') };
  fs.mkdirSync(path.join(s.home, '.conn'), { recursive: true });
  fs.cpSync(FIXTURE, s.project, { recursive: true });
  const git = (...args) => execFileSync('git', ['-c', 'user.name=verify', '-c', 'user.email=verify@conn.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd: s.project, env: { ...process.env, HOME: s.home }, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'the shop');
  fs.writeFileSync(path.join(s.home, '.conn', 'open-projects.json'), J([s.project]));
  // An empty HOME sends zsh into its first-run menu, which would eat what a terminal is typed.
  fs.writeFileSync(path.join(s.home, '.zshrc'), '');

  const electron = createRequire(path.join(root, 'package.json'))('electron');
  const args = [
    '--inspect=0', root, '--remote-debugging-port=0', `--user-data-dir=${s.userData}`, '--no-sandbox',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling',
  ];
  const [cmd, argv] = xvfb ? ['xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24', electron, ...args]] : [electron, args];
  const env = { ...process.env, HOME: s.home, CONN_CWD: s.project };
  delete env.ELECTRON_RUN_AS_NODE;
  const logFile = path.join(dir, 'app.log');
  const log = fs.openSync(logFile, 'w');
  const child = spawn(cmd, argv, { detached: true, stdio: ['ignore', log, log], env });
  child.unref();
  s.pid = child.pid;
  save(s);
  let exited = null;
  child.once('exit', (code) => { exited = code ?? 'a signal'; });
  const alive = () => {
    if (exited !== null) throw new Error(`Electron exited with ${exited} before it was ready:\n${read(logFile).slice(-1500)}`);
  };

  try {
    s.inspect = Number(await until(() => { alive(); return /Debugger listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(read(logFile))?.[1]; }, 30000));
    s.cdp = Number(await until(() => { alive(); return read(path.join(s.userData, 'DevToolsActivePort')).split('\n')[0]; }, 30000));
    if (!s.inspect || !s.cdp) throw new Error(`Electron never printed its ports:\n${read(logFile).slice(-1500)}`);
    save(s);
    const ready = await until(() => { alive(); return page(s, (c) => c.run('!!window.connChat')).catch(() => false); }, 45000);
    if (!ready) throw new Error('the chat never mounted');
    await evaluate(s, standIn, { main: true });
    await evaluate(s, 'electron.BrowserWindow.getAllWindows()[0].setContentSize(1440, 900)', { main: true });
    await sleep(1000);
  } catch (e) {
    await stop(s).catch(() => {});
    throw e;
  }
  s.bootMs = Date.now() - began;
  return s;
}

export async function stop(s) {
  assertMadeByBoot(s);
  const tryKill = (pid, sig) => { try { process.kill(pid, sig); } catch {} };
  const leaderIsOurs = () => read(`/proc/${s.pid}/cmdline`).includes(`--user-data-dir=${s.userData}`);
  const ownsGroup = () => leaderIsOurs() && heldBy(s).some((p) => statOf(p).pgrp === s.pid);
  const signal = (sig) => {
    if (ownsGroup()) tryKill(-s.pid, sig);
    for (const pid of heldBy(s)) tryKill(Number(pid), sig);
  };
  for (const [sig, wait] of [['SIGTERM', 4000], ['SIGKILL', 3000]]) {
    if (!heldBy(s).length) break;
    signal(sig);
    await until(() => !heldBy(s).length, wait);
  }
  const left = heldBy(s);
  if (left.length) throw new Error(`still running on ${s.dir} after SIGKILL: ${left.join(' ')}`);
  fs.rmSync(s.dir, { recursive: true, force: true, maxRetries: 5 });
}

export async function doctor(s) {
  const rows = [];
  const row = async (name, fn) => {
    try { const d = await fn(); rows.push({ name, ok: d !== false, detail: typeof d === 'string' ? d : '' }); }
    catch (e) { rows.push({ name, ok: false, detail: e.message }); }
  };
  const root = s?.root || ROOT;
  await row('renderer-built', () => fs.existsSync(path.join(root, 'build', 'renderer', 'index.html')) || 'run `npx vite build`');
  await row('electron-installed', () => createRequire(path.join(root, 'package.json'))('electron'));
  await row('display', () => Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY) || 'no DISPLAY; boot with --xvfb');
  await row('ffmpeg-for-record', () => { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); });
  await row('sharp-for-the-preview', () => { sharpOf({ root }); });
  if (s) {
    await row('instance-is-running', () => (heldBy(s).length ? `${heldBy(s).length} processes hold ${s.home}` : `nothing runs on ${s.home}; boot again`));
    await row('inspector-answers', async () => (await main(s, (c) => c.run('process.pid'))) > 0);
    await row('window-mounted', async () => (await evaluate(s, '!!window.connChat')) || 'no window.connChat');
    await row('agent-stand-in', async () => (await evaluate(s, 'Array.isArray(globalThis.__decided)', { main: true })) || 'boot did not finish');
    await row('chat-started', async () => ((await evaluate(s, '!!globalThis.__agent', { main: true })) ? 'a chat is live' : 'no chat yet; say, perm and invoke start one'));
  }
  return rows;
}

const INIT = { type: 'system', subtype: 'init', session_id: '7a7a7a7a-0000-4000-8000-000000000001', model: 'claude-haiku-4-5' };
const RESULT = { type: 'result', subtype: 'success', duration_ms: 1200 };
const assistant = (content) => ({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content } });
const delta = (event) => ({ type: 'stream_event', event });
const emit = (c, event, payload) => c.run(`globalThis.__agent.emit(${J(event)}, ${J(payload)})`);

const untilDrawn = (s) => evaluate(s, 'new Promise((r) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(r)), 100))', { awaitPromise: true });

async function ensureChat(s, prompt = 'Hello') {
  if (await evaluate(s, '!!globalThis.__agent', { main: true })) return;
  await evaluate(s, `document.querySelector('#agent-root [contenteditable="true"]').focus()`);
  await type(s, prompt);
  await key(s, 'Enter');
  if (!await until(() => evaluate(s, '!!globalThis.__agent', { main: true }), 8000)) throw new Error('the composer did not start a chat');
  await main(s, (c) => emit(c, 'message', INIT));
}

async function streamThenWholeBlock(c, text, { every, size }) {
  await emit(c, 'message', delta({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
  for (const chunk of text.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g')) || []) {
    await sleep(every);
    await emit(c, 'message', delta({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } }));
  }
  await emit(c, 'message', assistant([{ type: 'text', text }]));
  await emit(c, 'message', delta({ type: 'content_block_stop', index: 0 }));
}

export async function say(s, text, { stream = 0, size = 40, prompt, open = false } = {}) {
  await ensureChat(s, prompt);
  await main(s, async (c) => {
    if (stream) await streamThenWholeBlock(c, text, { every: stream, size });
    else await emit(c, 'message', assistant([{ type: 'text', text }]));
    if (!open) await emit(c, 'message', RESULT);
  });
  await untilDrawn(s);
}

const SAMPLE_INPUT = (s) => ({
  Edit: { file_path: path.join(s.project, 'index.html'), old_string: 'Apply', new_string: 'Apply coupon' },
  Write: { file_path: path.join(s.project, 'notes.txt'), content: 'hello\n' },
  Bash: { command: 'npm test' },
});

export async function perm(s, { id = `p${Date.now().toString(36)}`, tool = 'Edit', input, forId, agent = null, announce = true } = {}) {
  await ensureChat(s);
  input ??= SAMPLE_INPUT(s)[tool] ?? {};
  await main(s, async (c) => {
    if (announce && !forId) {
      forId = `call-${id}`;
      await emit(c, 'message', assistant([{ type: 'tool_use', id: forId, name: tool, input }]));
    }
    await emit(c, 'permission', { id, tool, input, forId, agent });
  });
  await untilDrawn(s);
  return id;
}

export async function decided(s, id) {
  const all = () => evaluate(s, 'globalThis.__decided', { main: true });
  if (id === undefined) return all();
  const hit = await until(async () => (await all()).find((d) => d.id === id), 3000);
  return hit?.decision ?? null;
}

export async function invoke(s, tool, args = {}, actor = { id: 'main', label: 'the main thread' }) {
  await ensureChat(s);
  return main(s, (c) => c.run(`globalThis.__agent.invoke(${J(tool)}, ${J(args)}, ${J(actor)})`, true));
}

const KEYS = {
  enter: ['Enter', 'Enter', 13], escape: ['Escape', 'Escape', 27], esc: ['Escape', 'Escape', 27], tab: ['Tab', 'Tab', 9],
  backspace: ['Backspace', 'Backspace', 8], delete: ['Delete', 'Delete', 46], space: [' ', 'Space', 32],
  up: ['ArrowUp', 'ArrowUp', 38], down: ['ArrowDown', 'ArrowDown', 40], left: ['ArrowLeft', 'ArrowLeft', 37], right: ['ArrowRight', 'ArrowRight', 39],
  home: ['Home', 'Home', 36], end: ['End', 'End', 35], pageup: ['PageUp', 'PageUp', 33], pagedown: ['PageDown', 'PageDown', 34],
  '`': ['`', 'Backquote', 192], ',': [',', 'Comma', 188], '.': ['.', 'Period', 190], '/': ['/', 'Slash', 191],
  '-': ['-', 'Minus', 189], '=': ['=', 'Equal', 187], plus: ['+', 'Equal', 187],
};
const MODS = { alt: 1, ctrl: 2, control: 2, cmdorctrl: 2, meta: 4, cmd: 4, shift: 8 };

function chord(spec) {
  const names = spec.split('+');
  const last = names.pop().toLowerCase();
  let modifiers = 0;
  for (const n of names) {
    if (!(n.toLowerCase() in MODS)) throw new Error(`unknown modifier ${n} in ${spec}`);
    modifiers |= MODS[n.toLowerCase()];
  }
  const fn = /^f([1-9]|1[0-2])$/.exec(last);
  const def = KEYS[last]
    || (/^[a-z]$/.test(last) && [modifiers & 8 ? last.toUpperCase() : last, `Key${last.toUpperCase()}`, last.toUpperCase().charCodeAt(0)])
    || (/^[0-9]$/.test(last) && [last, `Digit${last}`, last.charCodeAt(0)])
    || (fn && [`F${fn[1]}`, `F${fn[1]}`, 111 + Number(fn[1])]);
  if (!def) throw new Error(`unknown key ${last} in ${spec}`);
  const [key, code, windowsVirtualKeyCode] = def;
  const printable = key.length === 1 && !(modifiers & 7);
  return { key, code, windowsVirtualKeyCode, modifiers, ...(printable && { text: key }) };
}

export async function key(s, spec) {
  const e = chord(spec);
  await page(s, async (c) => {
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', ...e });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', ...e, text: undefined });
  });
  await untilDrawn(s);
}

export async function type(s, text, { enter = false } = {}) {
  await page(s, (c) => c.send('Input.insertText', { text }));
  if (enter) await key(s, 'Enter');
  else await untilDrawn(s);
}

function locateInPage(spec) {
  if (spec.at) return { x: spec.at[0], y: spec.at[1] };
  const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const names = (el) => [el.getAttribute('aria-label'), el.title, el.textContent].map((t) => (t || '').replace(/\s+/g, ' ').trim());
  const pool = spec.css
    ? [...document.querySelectorAll(spec.css)]
    : [...document.querySelectorAll('button, a, summary, input[type=button], label, [role=button], [role=tab], [role=menuitem], [role=option], [role=switch], [role=checkbox]')];
  const want = spec.text?.toLowerCase();
  const el = pool.filter(shown).find((e) => spec.css || names(e).includes(spec.text))
    || pool.filter(shown).find((e) => want && names(e).some((n) => n.toLowerCase().includes(want)));
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  const x = Math.round(r.left + r.width / 2);
  const y = Math.round(r.top + r.height / 2);
  const top = document.elementFromPoint(x, y);
  return { x, y, label: names(el).find(Boolean) || el.tagName, covered: top && !el.contains(top) && !top.contains(el) ? top.tagName.toLowerCase() : null };
}

const targetOf = (t) => {
  if (t.startsWith('css=')) return { css: t.slice(4) };
  const at = /^xy=(\d+),(\d+)$/.exec(t);
  return at ? { at: [Number(at[1]), Number(at[2])] } : { text: t };
};

export const click = (s, target, { wait = 3000 } = {}) => page(s, async (c) => {
  const hit = await until(() => c.run(`(${locateInPage})(${J(targetOf(target))})`), wait);
  if (!hit) throw new Error(`nothing to click for ${target}`);
  const events = [['mouseMoved', { button: 'none', buttons: 0 }], ['mousePressed', { button: 'left', buttons: 1, clickCount: 1 }], ['mouseReleased', { button: 'left', buttons: 0, clickCount: 1 }]];
  for (const [type, rest] of events) await c.send('Input.dispatchMouseEvent', { type, x: hit.x, y: hit.y, ...rest });
  await sleep(250);
  return hit;
});

const sharpOf = (s) => {
  try { return createRequire(path.join(s.root, 'package.json'))('sharp'); }
  catch { throw new Error(`the preview is composited with sharp from ${s.root}/node_modules; run npm ci, or pass --no-preview`); }
};

/* Starts the capture with a plain evaluation and polls for it. Asking the
   inspector to await a promise in the main process failed with "Promise was
   collected" in the first seconds after boot, and a shot can be the first thing
   a script does. Each call has its own slot, since a recording and a shot can
   run together. */
async function previewVia(run, format) {
  const id = J(Math.random().toString(36).slice(2));
  await run(`(globalThis.__seen ??= {}, globalThis.__seen[${id}] = null, globalThis.__preview(${J(format)}).then((r) => { globalThis.__seen[${id}] = { r }; }, (e) => { globalThis.__seen[${id}] = { e: String(e) }; }), true)`);
  const done = await until(() => run(`globalThis.__seen[${id}]`), 15000, 15);
  await run(`delete globalThis.__seen[${id}]`);
  if (!done) throw new Error('the preview capture never finished');
  if (done.e) throw new Error(done.e);
  return done.r;
}

const previewLayers = (s, format) => previewVia((expression) => evaluate(s, expression, { main: true }), format);

/* The preview is a native view above the window, so a CDP capture of the window
   has an empty slot where it sits. This lays each view the user can see over
   that capture at its real bounds. */
async function withPreview(sharp, windowImage, { width, layers }) {
  const ratio = (await sharp(windowImage).metadata()).width / width;
  const over = [];
  for (const l of layers) {
    const input = await sharp(Buffer.from(l.image, 'base64')).resize(Math.round(l.width * ratio), Math.round(l.height * ratio), { fit: 'fill' }).toBuffer();
    over.push({ input, left: Math.round(l.x * ratio), top: Math.round(l.y * ratio) });
  }
  return sharp(windowImage).composite(over);
}

export async function shot(s, out = path.join(SHOTS, `${path.basename(s.dir)}-${Date.now()}.png`), { css, preview = true } = {}) {
  const seen = preview ? await previewLayers(s, 'png') : { layers: [] };
  const unread = seen.layers.find((l) => !l.image);
  if (unread) throw new Error(`the preview is showing at ${unread.x},${unread.y} but the app could not capture it; try again, or pass --no-preview`);
  const composite = seen.layers.length > 0;
  const png = await page(s, async (c) => {
    const rect = css ? await c.run(`(() => { const r = document.querySelector(${J(css)})?.getBoundingClientRect(); return r && { x: r.x, y: r.y, width: r.width, height: r.height }; })()`) : null;
    if (css && !rect) throw new Error(`nothing matches ${css}`);
    const { data } = await c.send('Page.captureScreenshot', { format: 'png', ...(rect && !composite && { clip: { ...rect, scale: 1 } }) });
    const windowImage = Buffer.from(data, 'base64');
    if (!composite) return windowImage;
    const sharp = sharpOf(s);
    const whole = await (await withPreview(sharp, windowImage, seen)).png().toBuffer();
    if (!rect) return whole;
    const { width: pixels, height: rows } = await sharp(whole).metadata();
    const per = pixels / await c.run('innerWidth');
    const left = Math.max(0, Math.round(rect.x * per));
    const top = Math.max(0, Math.round(rect.y * per));
    return sharp(whole).extract({ left, top, width: Math.min(pixels - left, Math.round(rect.width * per)), height: Math.min(rows - top, Math.round(rect.height * per)) }).png().toBuffer();
  });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, png);
  return out;
}

export async function bounds(s, { wait = 1500 } = {}) {
  const close = (a, b) => !!a && !!b && ['x', 'y', 'width', 'height'].every((k) => Math.abs(a[k] - b[k]) <= 1);
  const look = async () => {
    const ipc = await evaluate(s, 'globalThis.__bounds.at(-1) ?? null', { main: true });
    const there = await evaluate(s, `(async () => {
      const r = document.querySelector('#paneslot')?.getBoundingClientRect();
      return { paneslot: r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null, nativeView: await window.conn.browser.action('bounds') };
    })()`, { awaitPromise: true });
    return { ipc, ...there, match: close(ipc, there.paneslot), nativeViewMatch: close(there.nativeView, there.paneslot) };
  };
  let now = await look();
  const end = Date.now() + wait;
  while (!now.match && Date.now() < end) { await sleep(150); now = await look(); }
  return now;
}

/* Window frames arrive only when the window changes, and the preview changes
   without the window, so a second loop lays the newest preview over the newest
   window frame as fast as it can while the clock writes whatever is ready. */
export async function record(s, { seconds = 10, out = path.join(SHOTS, `${path.basename(s.dir)}.mp4`), fps = 10, preview = true } = {}) {
  const sharp = preview ? sharpOf(s) : null;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const ffmpeg = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
  const closed = new Promise((r) => ffmpeg.once('close', r));
  let failure = null;
  await page(s, (c) => main(s, async (m) => {
    let latest = null;
    let drawn = null;
    let running = true;
    c.on('Page.screencastFrame', (p) => { latest = Buffer.from(p.data, 'base64'); c.send('Page.screencastFrameAck', { sessionId: p.sessionId }); });
    await c.send('Page.startScreencast', { format: 'jpeg', quality: 80, everyNthFrame: 1 });
    const compose = (async () => {
      while (running && sharp) {
        const base = latest;
        if (!base) { await sleep(20); continue; }
        try {
          const seen = await previewVia((expression) => m.run(expression), 'jpeg');
          if (seen.layers.some((l) => !l.image)) continue;
          drawn = seen.layers.length ? await (await withPreview(sharp, base, seen)).jpeg({ quality: 85 }).toBuffer() : base;
        } catch (e) { failure ??= e; running = false; }
      }
    })();
    const start = Date.now();
    for (let n = 0; n < seconds * fps; n++) {
      await sleep(Math.max(0, start + (n * 1000) / fps - Date.now()));
      const frame = drawn ?? latest ?? Buffer.from((await c.send('Page.captureScreenshot', { format: 'jpeg', quality: 80 })).data, 'base64');
      ffmpeg.stdin.write(frame);
    }
    running = false;
    await compose;
    await c.send('Page.stopScreencast');
  }));
  ffmpeg.stdin.end();
  if (await closed) throw new Error('ffmpeg failed to write the video');
  if (failure) throw failure;
  return out;
}

const BOOLEAN = new Set(['smoke', 'xvfb', 'open', 'bare', 'main', 'enter', 'no-preview']);

function parse(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const [name, value] = a.slice(2).split(/=(.*)/s);
    if (value !== undefined) flags[name] = value;
    else if (BOOLEAN.has(name) || argv[i + 1] === undefined || argv[i + 1].startsWith('--')) flags[name] = true;
    else flags[name] = argv[++i];
  }
  return { pos, flags };
}

const stdin = async () => { let t = ''; for await (const c of process.stdin) t += c; return t; };

const COMMANDS = {
  async boot({ flags }) {
    const s = await boot({ xvfb: !!flags.xvfb, ...(flags.root && { root: path.resolve(flags.root) }) });
    console.log(`ready inspect=${s.inspect} cdp=${s.cdp} boot=${s.bootMs}ms\nsession ${s.dir}\nproject ${s.project}`);
  },
  async doctor({ s }) {
    const rows = await doctor(s);
    for (const r of rows) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? `: ${r.detail}` : ''}`);
    if (rows.some((r) => !r.ok)) process.exitCode = 1;
  },
  async say({ s, pos, flags }) {
    const text = pos[1] === '-' ? await stdin() : pos[1] ?? flags.text;
    if (!text) throw new Error('say needs the reply text, or - to read it from stdin');
    await say(s, text, { stream: Number(flags.stream) || 0, size: Number(flags.size) || 40, prompt: flags.prompt, open: !!flags.open });
  },
  async perm({ s, pos, flags }) {
    const id = await perm(s, {
      id: flags.id, tool: pos[1] ?? flags.tool, forId: flags.for, announce: !flags.bare,
      input: flags.input && JSON.parse(flags.input), agent: flags.agent ? JSON.parse(flags.agent) : null,
    });
    console.log(id);
  },
  async decided({ s, pos }) {
    if (pos[1] === undefined) return console.log(J(await decided(s), null, 2));
    const d = await decided(s, pos[1]);
    if (d === null) { console.error(`nothing was decided for ${pos[1]}`); process.exitCode = 1; } else console.log(d);
  },
  async invoke({ s, pos, flags }) {
    console.log(J(await invoke(s, pos[1], pos[2] ? JSON.parse(pos[2]) : {}, flags.actor ? JSON.parse(flags.actor) : undefined), null, 2));
  },
  async click({ s, pos }) {
    const hit = await click(s, pos[1]);
    console.log(`clicked ${hit.label ? `"${hit.label}" ` : ''}at ${hit.x},${hit.y}`);
    if (hit.covered) console.error(`warning: a <${hit.covered}> is on top of that point`);
  },
  async key({ s, pos }) { await key(s, pos[1]); },
  async type({ s, pos, flags }) { await type(s, pos[1] === '-' ? await stdin() : pos[1], { enter: !!flags.enter }); },
  async shot({ s, flags }) { console.log(await shot(s, flags.out, { css: flags.css, preview: !flags['no-preview'] })); },
  async bounds({ s, flags }) {
    const b = await bounds(s, { wait: Number(flags.wait) || 1500 });
    console.log(J(b, null, 2));
    if (!b.match) process.exitCode = 1;
  },
  async record({ s, flags }) {
    console.log(await record(s, { seconds: Number(flags.seconds) || 10, fps: Number(flags.fps) || 10, out: flags.out, preview: !flags['no-preview'] }));
  },
  async js({ s, pos, flags }) {
    const v = await evaluate(s, pos[1], { main: !!flags.main, awaitPromise: true });
    console.log(typeof v === 'string' ? v : J(v, null, 2));
  },
  async stop({ s }) { await stop(s); console.log('stopped'); },
  async sessions() {
    const found = sessions();
    for (const s of found) console.log(`session ${s.dir} started ${s.startedAt} inspect=${s.inspect} cdp=${s.cdp} ${s.running ? 'running' : 'nothing running'}`);
    if (!found.length) console.log('no sessions from this checkout');
  },
};

async function smoke({ flags }) {
  const s = await boot({ xvfb: !!flags.xvfb });
  try {
    console.log(`ready inspect=${s.inspect} cdp=${s.cdp} boot=${s.bootMs}ms`);
    console.log(`png ${await shot(s, flags.out || path.join(SHOTS, `smoke-${path.basename(s.dir)}.png`))}`);
  } finally {
    await stop(s);
  }
}

async function cli(argv) {
  const a = parse(argv);
  const name = a.pos[0];
  if (a.flags.smoke || !name) return smoke(a);
  if (!COMMANDS[name]) throw new Error(`unknown command ${name}; try: ${Object.keys(COMMANDS).join(' ')}`);
  const dir = a.flags.session || process.env.CONN_VERIFY_SESSION;
  if (!['boot', 'sessions'].includes(name)) {
    if (dir) a.s = load(path.resolve(dir));
    else if (name !== 'doctor') throw new Error('name the instance with --session <dir>, the path boot printed');
  }
  return COMMANDS[name](a);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2)).then(() => process.exit(process.exitCode ?? 0), (e) => { console.error(`error: ${e.message}`); process.exit(1); });
}
