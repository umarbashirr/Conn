'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RUNS = Number(process.env.RUNS) || 20;
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
  window.__events = [];
  document.getElementById('add').addEventListener('click', () => { window.__clicks += 1; });
  for (const type of ['mousemove', 'mousedown', 'mouseup']) {
    document.addEventListener(type, () => window.__events.push(type), true);
  }
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
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-first-frame-'));
  const home = path.join(base, 'home');
  const proj = path.join(base, 'shop');
  for (const d of [path.join(home, '.conn'), proj]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(home, '.conn', 'open-projects.json'), JSON.stringify([proj]));
  fs.writeFileSync(path.join(home, '.conn', 'settings.json'), JSON.stringify({ agent: { provider: 'claude', mode: 'bypass' } }));

  const NO_FRAME_CALLBACKS = COUNTER.replace('<script>', '<script>window.requestAnimationFrame = () => 0;');
  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end(req.url.startsWith('/stalled') ? NO_FRAME_CALLBACKS : COUNTER);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${site.address().port}/`;

  const electron = require(path.join(ROOT, 'node_modules', 'electron'));
  const userData = path.join(base, 'userdata');
  const app = spawn(electron, [
    '--inspect=0', ROOT, '--remote-debugging-port=0', `--user-data-dir=${userData}`, '--no-sandbox',
  ], { env: { ...process.env, HOME: home, CONN_CWD: proj }, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  const exited = new Promise((r) => app.once('exit', r));

  try {
    const { inspector, cdp } = await endpoints(app, userData);
    const shell = await connect(await target(cdp, (t) => t.type === 'page' && /index\.html/.test(t.url)));
    const main = await connect(inspector);
    await main.run(`(() => {
      const req = process.getBuiltinModule('module').createRequire(${JSON.stringify(path.join(ROOT, 'src/main/index.js'))});
      const { AgentSession } = req('./agent');
      const { BrowserWindow } = req('electron');
      globalThis.__command = (c) => BrowserWindow.getAllWindows()[0].webContents.send('app:command', c);
      AgentSession.prototype.start = async function start() {
        globalThis.__agent = this;
        this.sessionId = '7a7a7a7a-0000-4000-8000-000000000006';
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

    const invoke = (tool, args) => main.run(`globalThis.__agent.invoke(${JSON.stringify(tool)}, ${JSON.stringify(args)}, { id: 'main', label: 'the main thread' })
      .catch((e) => ({ thrown: String(e && e.message || e) }))`);

    for (const pane of ['open', 'closed']) {
      await main.run(`globalThis.__command({ name: 'preview', open: ${pane === 'open'} })`);
      const width = () => shell.evaluate(() => document.querySelector('#paneslot')?.getBoundingClientRect().width || 0);
      check(`preview-pane-${pane}`, await until(async () => (pane === 'open') === ((await width()) > 300)), `pane width ${await width()}`);

      const lies = [];
      let heard = 0;
      let refused = 0;
      for (let i = 0; i < RUNS; i++) {
        const url = `${origin}?${pane}=${i}`;
        await invoke('navigate', { url });
        const result = await invoke('click', { target: '#add' });
        const page = await connect(await target(cdp, (t) => t.type === 'page' && t.url === url));
        await sleep(300);
        const seen = await page.evaluate(() => ({ clicks: window.__clicks, events: window.__events }));
        page.ws.close();
        const ok = result && result.ok === true;
        if (seen.clicks === 1) heard += 1;
        if (!ok) refused += 1;
        if (ok && seen.clicks !== 1) lies.push(`run ${i}: page heard ${JSON.stringify(seen.events)}`);
      }
      console.log(`  ${pane} pane: ${RUNS} clicks, ${heard} heard, ${refused} reported as failed, ${lies.length} reported ok but not heard`);
      check(`${pane}-pane-click-never-reports-ok-when-the-page-heard-nothing`, lies.length === 0, lies.join('; '));
      check(`${pane}-pane-most-clicks-land`, heard >= RUNS * 0.9, `${heard} of ${RUNS} clicks heard`);
    }

    const stalled = `${origin}stalled`;
    await invoke('navigate', { url: stalled });
    const refusal = await invoke('click', { target: '#add' });
    const page = await connect(await target(cdp, (t) => t.type === 'page' && t.url === stalled));
    const events = await page.run('window.__events');
    page.ws.close();
    check('click-on-a-page-that-never-draws-is-an-error', /not drawn/.test(refusal?.thrown || ''), JSON.stringify(refusal));
    check('click-on-a-page-that-never-draws-sends-no-press', !events.includes('mousedown'), JSON.stringify(events));

    shell.ws.close();
    main.ws.close();
  } finally {
    site.close();
    try { process.kill(-app.pid); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    await exited;
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
  }

  console.log(failures.length ? `\n${failures.length} failed` : '\nall passed');
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
