'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
};

const COUNTER = `<!doctype html><title>counter</title>
<body style="margin:0;background:#f4f6fb">
<button id="add" style="position:absolute;left:160px;top:120px;width:180px;height:72px">Add one</button>
<script>
  window.__clicks = 0;
  window.__downs = [];
  document.getElementById('add').addEventListener('click', () => { window.__clicks += 1; });
  document.addEventListener('mousedown', (e) => {
    const on = e.target.tagName.toLowerCase() + (e.target.closest('#__conn-cursor') ? ' in #__conn-cursor' : '');
    window.__downs.push(e.clientX + ',' + e.clientY + ' on ' + on);
  }, true);
</script>`;

async function target(port, pick) {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json();
      const hit = list.find(pick);
      if (hit) return hit.webSocketDebuggerUrl;
    } catch {}
    await sleep(500);
  }
  throw new Error(`nothing on ${port}`);
}

// Both ports are left to the OS, so runs that overlap never drive each other's
// app. Chromium writes its port into the profile and Node prints its URL.
async function endpoints(app, userData) {
  let err = '';
  app.stderr.on('data', (d) => { err += d; });
  const file = path.join(userData, 'DevToolsActivePort');
  for (let i = 0; i < 120; i++) {
    const inspector = err.match(/Debugger listening on (ws:\/\/\S+)/)?.[1];
    const cdp = fs.existsSync(file) && Number(fs.readFileSync(file, 'utf8').split('\n')[0]);
    if (inspector && cdp) return { inspector, cdp };
    if (app.exitCode !== null || app.signalCode !== null) {
      throw new Error(`app exited (${app.exitCode ?? app.signalCode}) before its debug ports:\n${err.slice(-500)}`);
    }
    await sleep(250);
  }
  throw new Error(`no debug endpoints: ${err.slice(-300)}`);
}

function connect(url) {
  const ws = new WebSocket(url);
  let seq = 0;
  const waiting = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++seq;
    waiting.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const run = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails));
    return res.result?.result?.value;
  };
  const evaluate = (fn, ...args) => run(`(${fn})(...${JSON.stringify(args)})`);
  return new Promise((resolve) => { ws.onopen = () => resolve({ ws, send, run, evaluate }); });
}

async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(150);
  }
  return last;
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'build', 'renderer', 'index.html'))) throw new Error('no renderer build: run `npx vite build` first');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-cursor-click-'));
  const home = path.join(base, 'home');
  const proj = path.join(base, 'shop');
  for (const d of [path.join(home, '.conn'), proj]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(home, '.conn', 'open-projects.json'), JSON.stringify([proj]));
  fs.writeFileSync(path.join(home, '.conn', 'settings.json'), JSON.stringify({ agent: { provider: 'claude', mode: 'bypass' } }));

  const site = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(COUNTER);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${site.address().port}/`;

  const electron = require(path.join(ROOT, 'node_modules', 'electron'));
  const userData = path.join(base, 'userdata');
  const app = spawn(electron, [
    '--inspect=0', ROOT, '--remote-debugging-port=0', `--user-data-dir=${userData}`, '--no-sandbox',
  ], { env: { ...process.env, HOME: home, CONN_CWD: proj }, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  const exited = new Promise((r) => app.once('exit', r));

  try {
    const { inspector, cdp } = await endpoints(app, userData);
    // The window exists only once main has loaded. Reached any sooner, the
    // inspector can land mid-bootstrap, before process.getBuiltinModule.
    const shell = await connect(await target(cdp, (t) => t.type === 'page' && /index\.html/.test(t.url)));
    const main = await connect(inspector);
    await main.run(`(() => {
      const req = process.getBuiltinModule('module').createRequire(${JSON.stringify(path.join(ROOT, 'src/main/index.js'))});
      const { AgentSession } = req('./agent');
      const { BrowserWindow } = req('electron');
      globalThis.__command = (c) => BrowserWindow.getAllWindows()[0].webContents.send('app:command', c);
      AgentSession.prototype.start = async function start() {
        globalThis.__agent = this;
        this.sessionId = '7a7a7a7a-0000-4000-8000-000000000002';
        setTimeout(() => this.emit('ready', { sessionId: this.sessionId }), 0);
      };
      AgentSession.prototype.send = function send() {};
      AgentSession.prototype.models = async function models() { return []; };
      return true;
    })()`);

    await shell.evaluate(async () => {
      for (let i = 0; i < 60 && !window.connChat; i++) await new Promise((r) => setTimeout(r, 250));
      await new Promise((r) => setTimeout(r, 1000));
      document.querySelector('[contenteditable="true"]')?.focus();
    });
    await shell.send('Input.insertText', { text: 'add one to the counter' });
    await shell.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await shell.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    check('claude-session-stood-in', await until(() => main.run('!!globalThis.__agent')), 'no AgentSession was started');

    await main.run(`globalThis.__command({ name: 'preview', open: true })`);
    const open = await until(() => shell.evaluate(() => (document.querySelector('#paneslot')?.getBoundingClientRect().width || 0) > 300));
    check('preview-pane-open', open, 'the pane never got a box');

    const invoke = (tool, args) => main.run(`globalThis.__agent.invoke(${JSON.stringify(tool)}, ${JSON.stringify(args)}, { id: 'main', label: 'the main thread' })`);
    await invoke('navigate', { url });
    const page = await connect(await target(cdp, (t) => t.type === 'page' && t.url === url));
    // A mousedown that reaches the page before its first frame is dropped,
    // though the mousemove gets through. Two frames in, one has been drawn.
    const layout = () => page.evaluate(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => r(true)));
      const drawn = await Promise.race([frame().then(frame), new Promise((r) => setTimeout(() => r(false), 1000))]);
      const r = document.getElementById('add').getBoundingClientRect();
      return { drawn, viewport: [innerWidth, innerHeight], button: [r.left, r.top, r.right, r.bottom] };
    });
    const ready = async () => {
      const { drawn, viewport: [w, h], button: [l, t, r, b] } = await layout();
      return drawn && w > 0 && r > l && b > t && r <= w && b <= h;
    };
    check('preview-page-drawn', await until(ready), JSON.stringify(await layout()));

    const { at } = await invoke('click', { target: '#add' });
    const clicks = () => page.run('window.__clicks');
    const downs = () => page.run('window.__downs');
    check('agent-click-reaches-the-button', await until(async () => (await clicks()) === 1, 2000),
      `agent clicked at ${at.x},${at.y}, button heard ${await clicks()} click(s), mousedown ${JSON.stringify(await downs())}`);

    const faded = await until(() => page.run(`getComputedStyle(document.getElementById('__conn-cursor')).opacity === '0'`), 6000);
    check('cursor-fades-out', faded, 'cursor still showing after 6 s');

    const under = await page.evaluate(() => {
      const button = document.getElementById('add');
      const arrow = document.querySelector('#__conn-cursor svg');
      const a = arrow.getBoundingClientRect();
      const b = button.getBoundingClientRect();
      const stolen = {};
      let total = 0;
      for (let x = Math.max(a.left, b.left); x < Math.min(a.right, b.right); x += 2) {
        for (let y = Math.max(a.top, b.top); y < Math.min(a.bottom, b.bottom); y += 2) {
          total += 1;
          const hit = document.elementFromPoint(x, y);
          if (hit === button) continue;
          const name = `${hit.tagName.toLowerCase()}${hit.closest('#__conn-cursor') ? ' in #__conn-cursor' : ''}`;
          stolen[name] = (stolen[name] || 0) + 1;
        }
      }
      return { total, stolen, svgPointerEvents: getComputedStyle(arrow).pointerEvents };
    });
    const lost = Object.values(under.stolen).reduce((a, b) => a + b, 0);
    check('faded-arrow-covers-nothing', under.total > 0 && lost === 0,
      `${lost} of ${under.total} points under the arrow hit ${JSON.stringify(under.stolen)}, svg pointer-events ${under.svgPointerEvents}`);

    const before = await clicks();
    const mine = { x: at.x + 6, y: at.y + 10 };
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...mine });
    for (const type of ['mousePressed', 'mouseReleased']) {
      await page.send('Input.dispatchMouseEvent', { type, ...mine, button: 'left', clickCount: 1 });
    }
    check('person-click-on-the-same-spot-reaches-the-button', await until(async () => (await clicks()) === before + 1, 2000),
      `clicked at ${mine.x},${mine.y}, button heard ${(await clicks()) - before} click(s), mousedown ${JSON.stringify((await downs()).at(-1))}`);

    page.ws.close();
    shell.ws.close();
    main.ws.close();
  } finally {
    site.close();
    // The whole group, not just the app. The codex it probes at startup leaves
    // a git fetch running after the app has exited. ESRCH means an app that
    // died on its own left nothing behind.
    try { process.kill(-app.pid); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    await exited;
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
  }

  console.log(failures.length ? `\n${failures.length} failed` : '\nall passed');
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
