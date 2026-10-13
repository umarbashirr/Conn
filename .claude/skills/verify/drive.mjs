#!/usr/bin/env node
/* Boots Conn on a throwaway HOME and drives it the way a person does: real
   mouse and key events over CDP, and fake agent events pushed into the main
   process over the Node inspector. Import it for the functions or run it for
   the CLI. SKILL.md has the recipe. */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const FIXTURE = path.join(HERE, 'fixtures', 'shop');
// Evidence lives apart from the session dirs, which stop deletes.
const SHOTS = process.env.CONN_VERIFY_SHOTS || path.join(os.tmpdir(), 'conn-shots');
const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Polls until fn returns something truthy and hands it back, or returns the
   last falsy answer once ms is up. fn may throw to give up early. */
async function until(fn, ms) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(150);
  }
  return last;
}

const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };

/* The processes this session started, and nobody else's. Electron and its
   helpers carry the session's --user-data-dir, and have no environment to
   read, because Chromium overwrites it when it sets the process title. Every
   other process, such as the provider agents the app detaches into groups of
   their own, has only the HOME it inherited, which is a directory this session
   made. A group signal would miss the second kind. */
export const heldBy = (s) => fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p)
  && (read(`/proc/${p}/cmdline`).includes(`--user-data-dir=${s.userData}`) || `\0${read(`/proc/${p}/environ`)}`.includes(`\0HOME=${s.home}\0`)));

// ------------------------------------------------------------------ CDP

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
  const run = async (expression, wait = false) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: wait, returnByValue: true })
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

/* Main-process code gets `req`, which requires from src/main/index.js, and
   `electron`. Pass wait for an expression that returns a promise. Asking the
   inspector to await a value that is not one failed with "Promise was
   collected" on about half of the boots that ran in parallel. */
const mainPrefix = (s) => `const req = process.getBuiltinModule('module').createRequire(${J(path.join(s.root, 'src/main/index.js'))}); const electron = req('electron');`;

export const evaluate = (s, expression, { main: inMain = false, wait = false } = {}) => (inMain
  ? main(s, (c) => c.run(`(() => { ${mainPrefix(s)} return (${expression}); })()`, wait))
  : page(s, (c) => c.run(expression, wait)));

export const load = (dir) => {
  const file = path.join(dir, 'session.json');
  if (!fs.existsSync(file)) throw new Error(`no session at ${dir}; was it stopped?`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
};

// ----------------------------------------------------------------- boot

/* Stands in for the agent. The app still runs its own ensureAgent, so a chat
   starts the way it does for a person; only the CLI behind it is gone. say and
   perm emit on the newest session, and the answers to a permission land in
   __decided instead of reaching a model. */
const standIn = `(() => {
  const { ipcMain } = electron;
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
  return true;
})()`;

const save = (s) => fs.writeFileSync(path.join(s.dir, 'session.json'), J(s));

export async function boot({ root = ROOT, xvfb = false } = {}) {
  if (!fs.existsSync(path.join(root, 'build', 'renderer', 'index.html'))) throw new Error('no renderer build: run `npx vite build` first');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-verify-'));
  const s = { dir, root, home: path.join(dir, 'home'), project: path.join(dir, 'shop'), userData: path.join(dir, 'userdata') };
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
    // Lanes share a screen, so a window behind another must still paint and tick.
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling',
  ];
  const [cmd, argv] = xvfb ? ['xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24', electron, ...args]] : [electron, args];
  const env = { ...process.env, HOME: s.home, CONN_CWD: s.project };
  delete env.ELECTRON_RUN_AS_NODE;
  const errFile = path.join(dir, 'app.err');
  const child = spawn(cmd, argv, { detached: true, stdio: ['ignore', fs.openSync(path.join(dir, 'app.log'), 'w'), fs.openSync(errFile, 'w')], env });
  child.unref();
  s.pid = child.pid;
  save(s);
  let exited = null;
  child.once('exit', (code) => { exited = code ?? 'a signal'; });
  const alive = () => {
    if (exited !== null) throw new Error(`Electron exited with ${exited} before it was ready:\n${read(errFile).slice(-1500)}`);
  };

  try {
    s.inspect = Number(await until(() => { alive(); return /Debugger listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(read(errFile))?.[1]; }, 30000));
    s.cdp = Number(await until(() => { alive(); return read(path.join(s.userData, 'DevToolsActivePort')).split('\n')[0]; }, 30000));
    if (!s.inspect || !s.cdp) throw new Error(`Electron never printed its ports:\n${read(errFile).slice(-1500)}`);
    save(s);
    const ready = await until(() => { alive(); return page(s, (c) => c.run('!!window.connChat')).catch(() => false); }, 45000);
    if (!ready) throw new Error('the chat never mounted');
    await evaluate(s, standIn, { main: true });
    await evaluate(s, 'electron.BrowserWindow.getAllWindows()[0].setContentSize(1440, 900)', { main: true });
    await sleep(1000);
    await evaluate(s, `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Later')?.click()`);
  } catch (e) {
    await stop(s).catch(() => {});
    throw e;
  }
  return s;
}

/* Ends what this session started and nothing else. The app launches provider
   agents and a Codex plugin fetch that outlive it, so the processes found are
   the ones whose HOME is this session's, asked to exit and then forced. */
export async function stop(s) {
  for (const [signal, wait] of [['SIGTERM', 5000], ['SIGKILL', 3000]]) {
    const pids = heldBy(s);
    if (!pids.length) break;
    for (const pid of pids) {
      try { process.kill(Number(pid), signal); } catch { /* gone between the scan and the signal */ }
    }
    await until(() => !heldBy(s).length, wait);
  }
  const left = heldBy(s);
  if (left.length) throw new Error(`still running on ${s.home} after SIGKILL: ${left.join(' ')}`);
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
  if (s) {
    await row('instance-is-running', () => (heldBy(s).length ? `${heldBy(s).length} processes hold ${s.home}` : `nothing runs on ${s.home}; boot again`));
    await row('inspector-answers', async () => (await main(s, (c) => c.run('process.pid'))) > 0);
    await row('window-mounted', async () => (await evaluate(s, '!!window.connChat')) || 'no window.connChat');
    await row('agent-stand-in', async () => (await evaluate(s, 'Array.isArray(globalThis.__decided)', { main: true })) || 'boot did not finish');
    await row('chat-started', async () => ((await evaluate(s, '!!globalThis.__agent', { main: true })) ? 'a chat is live' : 'no chat yet; say, perm and invoke start one'));
  }
  return rows;
}

// ---------------------------------------------------------------- agent

const INIT = { type: 'system', subtype: 'init', session_id: '7a7a7a7a-0000-4000-8000-000000000001', model: 'claude-haiku-4-5' };
const RESULT = { type: 'result', subtype: 'success', duration_ms: 1200 };
const assistant = (content) => ({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content } });
const delta = (event) => ({ type: 'stream_event', event });
const emit = (c, event, payload) => c.run(`globalThis.__agent.emit(${J(event)}, ${J(payload)})`);

// Main's send has crossed to the renderer, and React has drawn two frames from it, when this returns.
const settle = (s) => evaluate(s, 'new Promise((r) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(r)), 100))', { wait: true });

// A chat only exists once a message is sent, so the first say, perm or invoke sends one through the composer.
async function turn(s, prompt = 'Hello') {
  if (await evaluate(s, '!!globalThis.__agent', { main: true })) return;
  await evaluate(s, `document.querySelector('#agent-root [contenteditable="true"]').focus()`);
  await type(s, prompt);
  await key(s, 'Enter');
  if (!await until(() => evaluate(s, '!!globalThis.__agent', { main: true }), 8000)) throw new Error('the composer did not start a chat');
  await main(s, (c) => emit(c, 'message', INIT));
}

export async function say(s, text, { stream = 0, size = 40, prompt, open = false } = {}) {
  await turn(s, prompt);
  await main(s, async (c) => {
    if (stream) {
      await emit(c, 'message', delta({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
      for (const chunk of text.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g')) || []) {
        await sleep(stream);
        await emit(c, 'message', delta({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } }));
      }
    }
    // The SDK sends the whole block while its stream is still open, and the
    // panel skips text it already drew from deltas only in that window.
    await emit(c, 'message', assistant([{ type: 'text', text }]));
    if (stream) await emit(c, 'message', delta({ type: 'content_block_stop', index: 0 }));
    if (!open) await emit(c, 'message', RESULT);
  });
  await settle(s);
}

const SAMPLE_INPUT = (s) => ({
  Edit: { file_path: path.join(s.project, 'index.html'), old_string: 'Apply', new_string: 'Apply coupon' },
  Write: { file_path: path.join(s.project, 'notes.txt'), content: 'hello\n' },
  Bash: { command: 'npm test' },
});

/* Announces the call the card is for, so the card pairs with a row the way it
   does for a real agent, then asks. bare skips the announcement. */
export async function perm(s, { id = `p${Date.now().toString(36)}`, tool = 'Edit', input, forId, agent = null, bare = false } = {}) {
  await turn(s);
  input ??= SAMPLE_INPUT(s)[tool] ?? {};
  await main(s, async (c) => {
    if (!bare && !forId) {
      forId = `call-${id}`;
      await emit(c, 'message', assistant([{ type: 'tool_use', id: forId, name: tool, input }]));
    }
    await emit(c, 'permission', { id, tool, input, forId, agent });
  });
  await settle(s);
  return id;
}

export async function decided(s, id) {
  const all = () => evaluate(s, 'globalThis.__decided', { main: true });
  if (id === undefined) return all();
  const hit = await until(async () => (await all()).find((d) => d.id === id), 3000);
  return hit?.decision ?? null;
}

export async function invoke(s, tool, args = {}, actor = { id: 'main', label: 'the main thread' }) {
  await turn(s);
  return main(s, (c) => c.run(`globalThis.__agent.invoke(${J(tool)}, ${J(args)}, ${J(actor)})`, true));
}

// ---------------------------------------------------------------- input

const KEYS = {
  enter: ['Enter', 'Enter', 13], escape: ['Escape', 'Escape', 27], esc: ['Escape', 'Escape', 27], tab: ['Tab', 'Tab', 9],
  backspace: ['Backspace', 'Backspace', 8], delete: ['Delete', 'Delete', 46], space: [' ', 'Space', 32],
  up: ['ArrowUp', 'ArrowUp', 38], down: ['ArrowDown', 'ArrowDown', 40], left: ['ArrowLeft', 'ArrowLeft', 37], right: ['ArrowRight', 'ArrowRight', 39],
  home: ['Home', 'Home', 36], end: ['End', 'End', 35], pageup: ['PageUp', 'PageUp', 33], pagedown: ['PageDown', 'PageDown', 34],
  '`': ['`', 'Backquote', 192], ',': [',', 'Comma', 188], '.': ['.', 'Period', 190], '/': ['/', 'Slash', 191],
  '-': ['-', 'Minus', 189], '=': ['=', 'Equal', 187], plus: ['+', 'Equal', 187],
};
const MODS = { alt: 1, ctrl: 2, control: 2, cmdorctrl: 2, meta: 4, cmd: 4, shift: 8 };

// "Ctrl+Shift+B" to the fields Input.dispatchKeyEvent takes. CmdOrCtrl is Ctrl, since Conn on Linux is the target.
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

export const key = (s, spec) => page(s, async (c) => {
  const e = chord(spec);
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', ...e });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', ...e, text: undefined });
});

export async function type(s, text, { enter = false } = {}) {
  await page(s, (c) => c.send('Input.insertText', { text }));
  if (enter) await key(s, 'Enter');
}

// Runs in the page. A bare name matches a button, link, tab or menu item by its text, aria-label or title.
function locate(spec) {
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

// A click right after say or perm lands before the panel has drawn its target, so it waits for it.
export const click = (s, target, { wait = 3000 } = {}) => page(s, async (c) => {
  const hit = await until(() => c.run(`(${locate})(${J(targetOf(target))})`), wait);
  if (!hit) throw new Error(`nothing to click for ${target}`);
  const events = [['mouseMoved', { button: 'none', buttons: 0 }], ['mousePressed', { button: 'left', buttons: 1, clickCount: 1 }], ['mouseReleased', { button: 'left', buttons: 0, clickCount: 1 }]];
  for (const [type, rest] of events) await c.send('Input.dispatchMouseEvent', { type, x: hit.x, y: hit.y, ...rest });
  await sleep(250);
  return hit;
});

// ------------------------------------------------------------- evidence

/* The preview is a native view over the window. Page.captureScreenshot leaves
   it out, so a picture of the window shows its slot and not the page in it. */
export const shot = (s, out = path.join(SHOTS, `${path.basename(s.dir)}-${Date.now()}.png`), { css } = {}) => page(s, async (c) => {
  let clip;
  if (css) {
    clip = await c.run(`(() => { const r = document.querySelector(${J(css)})?.getBoundingClientRect(); return r && { x: r.x, y: r.y, width: r.width, height: r.height, scale: 1 }; })()`);
    if (!clip) throw new Error(`nothing matches ${css}`);
  }
  const { data } = await c.send('Page.captureScreenshot', { format: 'png', ...(clip && { clip }) });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(data, 'base64'));
  return out;
});

/* ipc is the last box the renderer sent main, view is where the native preview
   sits, and paneslot is the element they are both meant to cover. */
export async function bounds(s, { wait = 1500 } = {}) {
  const close = (a, b) => !!a && !!b && ['x', 'y', 'width', 'height'].every((k) => Math.abs(a[k] - b[k]) <= 1);
  const look = async () => {
    const ipc = await evaluate(s, 'globalThis.__bounds.at(-1) ?? null', { main: true });
    const there = await evaluate(s, `(async () => {
      const r = document.querySelector('#paneslot')?.getBoundingClientRect();
      return { paneslot: r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null, view: await window.conn.browser.action('bounds') };
    })()`, { wait: true });
    return { ipc, ...there, match: close(ipc, there.paneslot), viewMatch: close(there.view, there.paneslot) };
  };
  let now = await look();
  const end = Date.now() + wait;
  while (!now.match && Date.now() < end) { await sleep(150); now = await look(); }
  return now;
}

/* Frames arrive only when the page changes, so the newest one is written to
   ffmpeg on a fixed clock. That makes the video as long as the recording. */
export async function record(s, { seconds = 10, out = path.join(SHOTS, `${path.basename(s.dir)}.mp4`), fps = 10 } = {}) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const ffmpeg = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
  const closed = new Promise((r) => ffmpeg.once('close', r));
  await page(s, async (c) => {
    let latest = null;
    c.on('Page.screencastFrame', (p) => { latest = Buffer.from(p.data, 'base64'); c.send('Page.screencastFrameAck', { sessionId: p.sessionId }); });
    await c.send('Page.startScreencast', { format: 'jpeg', quality: 80, everyNthFrame: 1 });
    const start = Date.now();
    for (let n = 0; n < seconds * fps; n++) {
      await sleep(Math.max(0, start + (n * 1000) / fps - Date.now()));
      latest ??= Buffer.from((await c.send('Page.captureScreenshot', { format: 'jpeg', quality: 80 })).data, 'base64');
      ffmpeg.stdin.write(latest);
    }
    await c.send('Page.stopScreencast');
  });
  ffmpeg.stdin.end();
  if (await closed) throw new Error('ffmpeg failed to write the video');
  return out;
}

// ------------------------------------------------------------------ CLI

const BOOLEAN = new Set(['smoke', 'xvfb', 'open', 'bare', 'main', 'enter']);

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
    console.log(`ready inspect=${s.inspect} cdp=${s.cdp}\nsession ${s.dir}\nproject ${s.project}`);
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
      id: flags.id, tool: pos[1] ?? flags.tool, forId: flags.for, bare: !!flags.bare,
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
  async shot({ s, flags }) { console.log(await shot(s, flags.out, { css: flags.css })); },
  async bounds({ s, flags }) {
    const b = await bounds(s, { wait: Number(flags.wait) || 1500 });
    console.log(J(b, null, 2));
    if (!b.match) process.exitCode = 1;
  },
  async record({ s, flags }) {
    console.log(await record(s, { seconds: Number(flags.seconds) || 10, fps: Number(flags.fps) || 10, out: flags.out }));
  },
  // Not named eval, which some agent sandboxes refuse to run as a command word.
  async js({ s, pos, flags }) {
    const v = await evaluate(s, pos[1], { main: !!flags.main, wait: true });
    console.log(typeof v === 'string' ? v : J(v, null, 2));
  },
  async stop({ s }) { await stop(s); console.log('stopped'); },
};

async function smoke({ flags }) {
  const s = await boot({ xvfb: !!flags.xvfb });
  try {
    console.log(`ready inspect=${s.inspect} cdp=${s.cdp}`);
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
  if (name !== 'boot') {
    if (dir) a.s = load(path.resolve(dir));
    else if (name !== 'doctor') throw new Error('name the instance with --session <dir>, the path boot printed');
  }
  return COMMANDS[name](a);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2)).then(() => process.exit(process.exitCode ?? 0), (e) => { console.error(`error: ${e.message}`); process.exit(1); });
}
