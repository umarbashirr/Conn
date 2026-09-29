'use strict';
/* Links in the chat, clicked in the real app. A reply with a web link and a
   mail link lands in the transcript. A plain click opens the web link in the
   Browser pane with no dialog; Ctrl+click and middle click send it to the
   system browser instead; a mail link always goes out; the copy button beside
   a link copies it, says so, reverts, and opens nothing; and main refuses to
   send anything but web and mail links out of the app.

   The agent and shell.openExternal are answered from the main process over the
   Node inspector, so no agent runs and no browser opens. The page the link
   points at is served locally. Runs on a throwaway HOME. Needs a built
   renderer: `npx vite build` first. */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9339;
const INSPECT = 9340;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
};

async function target(port, pick) {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const hit = list.find(pick);
      if (hit) return hit.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error(`nothing to debug on ${port}`);
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

async function until(page, fn, arg, ms = 5000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await page.evaluate(fn, arg);
    if (last) return last;
    await sleep(150);
  }
  return last;
}

const CTRL = 2;

async function click(page, p, { modifiers = 0, button = 'left' } = {}) {
  const buttons = { left: 1, middle: 4 }[button];
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none', buttons: 0, modifiers });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button, buttons, clickCount: 1, modifiers });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button, buttons: 0, clickCount: 1, modifiers });
  await sleep(250);
}

function center(selector) {
  const el = document.querySelector(selector);
  if (!el) return null;
  el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + Math.min(r.width / 2, 20)), y: Math.round(r.top + r.height / 2) };
}

function browserShowing() {
  const url = document.querySelector('#url');
  return url?.offsetParent ? url.value : null;
}

async function main() {
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>Docs</title><h1>Docs</h1>'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const web = `http://127.0.0.1:${server.address().port}/docs`;
  const mail = 'mailto:hello@example.com';
  const reply = `Read [the docs](${web}) first, or write to [us](${mail}).`;

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-links-'));
  const home = path.join(base, 'home');
  const proj = path.join(base, 'shop');
  for (const d of [path.join(home, '.conn'), proj]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(home, '.conn', 'open-projects.json'), JSON.stringify([proj]));

  const electron = require(path.join(ROOT, 'node_modules', 'electron'));
  const app = spawn(electron, [
    `--inspect=${INSPECT}`, ROOT, `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(base, 'userdata')}`, '--no-sandbox',
  ], { env: { ...process.env, HOME: home, CONN_CWD: proj }, stdio: 'ignore' });

  try {
    const main = await connect(await target(INSPECT, (t) => t.type === 'node'));
    await main.run(`(() => {
      const req = process.getBuiltinModule('module').createRequire(${JSON.stringify(path.join(ROOT, 'src/main/index.js'))});
      const { ipcMain, shell } = req('electron');
      globalThis.__external = [];
      shell.openExternal = async (url) => { globalThis.__external.push(url); };
      ipcMain.removeHandler('agent:send');
      ipcMain.handle('agent:send', (e, { chat }) => {
        const say = (msg) => e.sender.send('agent:message', { chat, msg });
        setTimeout(() => {
          say({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
          say({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ${JSON.stringify(reply)} } } });
          say({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
        }, 50);
        return { ok: true };
      });
      return true;
    })()`);
    const external = () => main.run('globalThis.__external');

    const page = await connect(await target(PORT, (t) => t.type === 'page' && /index\.html/.test(t.url)));
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 950, deviceScaleFactor: 1, mobile: false });
    await page.evaluate(async () => {
      for (let i = 0; i < 60 && !window.connChat; i++) await new Promise((r) => setTimeout(r, 250));
      await new Promise((r) => setTimeout(r, 1000));
      window.__copied = [];
      navigator.clipboard.writeText = async (t) => { window.__copied.push(t); };
    });

    await page.evaluate(() => document.querySelector('#agent-root [contenteditable="true"]').focus());
    await page.send('Input.insertText', { text: 'where are the docs' });
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });

    const webLink = `#agent-root a[href="${web}"]`;
    const mailLink = `#agent-root a[href="${mail}"]`;
    const copy = `${webLink} + button`;
    const rendered = await until(page, (s) => !!document.querySelector(s) || null, webLink, 8000);
    check('reply-renders-links', rendered === true && await page.evaluate((s) => !!document.querySelector(s), mailLink), 'links missing');

    const title = await page.evaluate((s) => document.querySelector(s).title, webLink);
    check('link-says-what-a-click-does', title === 'Open in Conn browser · Ctrl+click to open externally', title);
    check('mail-link-says-where-it-goes', await page.evaluate((s) => document.querySelector(s).title, mailLink) === 'Open in your mail app', 'wrong title');
    check('nothing-open-at-start', (await page.evaluate(browserShowing)) === null, 'browser already open');

    const copyState = () => page.evaluate((s) => {
      const b = document.querySelector(s);
      return b && { label: b.getAttribute('aria-label'), copied: b.dataset.copied === 'true', check: !!b.querySelector('.lucide-check') };
    }, copy);
    check('copy-button-beside-link', (await copyState())?.label === 'Copy link', JSON.stringify(await copyState()));
    await click(page, await page.evaluate(center, copy));
    const copied = await copyState();
    check('copy-writes-clipboard', JSON.stringify(await page.evaluate(() => window.__copied)) === JSON.stringify([web]), JSON.stringify(await page.evaluate(() => window.__copied)));
    check('copy-shows-copied', copied.label === 'Copied' && copied.copied && copied.check, JSON.stringify(copied));
    check('copy-opens-nothing', (await page.evaluate(browserShowing)) === null && (await external()).length === 0, `browser ${await page.evaluate(browserShowing)}, external ${JSON.stringify(await external())}`);
    await sleep(1700);
    const reverted = await copyState();
    check('copy-reverts', reverted.label === 'Copy link' && !reverted.copied && !reverted.check, JSON.stringify(reverted));

    await click(page, await page.evaluate(center, webLink), { modifiers: CTRL });
    check('ctrl-click-opens-externally', JSON.stringify(await external()) === JSON.stringify([web]), JSON.stringify(await external()));
    check('ctrl-click-leaves-browser-shut', (await page.evaluate(browserShowing)) === null, await page.evaluate(browserShowing));

    await click(page, await page.evaluate(center, webLink), { button: 'middle' });
    check('middle-click-opens-externally', JSON.stringify(await external()) === JSON.stringify([web, web]), JSON.stringify(await external()));

    await click(page, await page.evaluate(center, mailLink));
    check('mail-link-always-external', (await external()).at(-1) === mail && (await page.evaluate(browserShowing)) === null, JSON.stringify(await external()));

    await click(page, await page.evaluate(center, webLink));
    const opened = await until(page, browserShowing, null, 5000);
    check('click-opens-browser-pane-at-url', opened === web, `url ${opened}`);
    check('click-stays-in-app', (await external()).length === 3, JSON.stringify(await external()));
    check('no-dialog', await page.evaluate(() => !document.querySelector('[role="dialog"], [role="alertdialog"]')), 'a dialog is in the DOM');
    check('app-window-did-not-navigate', await page.evaluate(() => /index\.html$/.test(location.pathname)), 'window navigated');

    const refused = await page.evaluate(() => window.conn.links.openExternal('file:///etc/passwd'));
    check('main-refuses-other-schemes', !!refused?.error && (await external()).length === 3, JSON.stringify(refused));

    page.ws.close();
    main.ws.close();
  } finally {
    const exited = new Promise((r) => app.once('exit', r));
    app.kill();
    const stuck = setTimeout(() => app.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(stuck);
    server.close();
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
  }

  console.log(failures.length ? `\n${failures.length} failed` : '\nall passed');
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
