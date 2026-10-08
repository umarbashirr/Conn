'use strict';
/* A dialog opened with a page up in the preview. It belongs in the middle of
   the window like it does with the preview shut, and it sat in the middle of
   the chat column instead.

   Each dialog is opened two ways: a click, which warms the still on the way
   down, and a chord, which does not. Besides where it lands, the script times
   how long any of the box sits over the live page before the still replaces
   it, since the preview is a native view painted above the document.
   Runs on a throwaway HOME. Needs a built renderer: `npx vite build` first. */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9381;
const INSPECT = 9382;
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
    await sleep(100);
  }
  return last;
}

async function key(page, k, code, vk, modifiers = 0) {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers });
}

// Every frame from the dialog's first paint until the still is up, noting the
// frames where the box reaches into the pane while the live page is still on it.
function trace() {
  const t = { open: null, still: null, exposed: 0, last: 0 };
  const tick = () => {
    const box = document.querySelector('[data-slot="dialog-content"]');
    const still = document.querySelector('#paneslot .pane-still');
    const now = performance.now();
    if (box && t.open === null) t.open = now;
    if (box && !still) {
      const r = box.getBoundingClientRect();
      const p = document.querySelector('#paneslot').getBoundingClientRect();
      if (r.right > p.left + 1) { t.exposed += 1; t.last = now; }
    }
    if (still) { t.still = now; return; }
    if (t.open === null || now - t.open < 3000) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  window.__trace = t;
}

function placement() {
  const box = document.querySelector('[data-slot="dialog-content"]').getBoundingClientRect();
  const t = window.__trace;
  return {
    boxCenter: Math.round(box.left + box.width / 2),
    windowCenter: Math.round(window.innerWidth / 2),
    coverMs: t.still === null ? null : Math.round(t.still - t.open),
    exposedFrames: t.exposed,
    exposedMs: t.exposed ? Math.round(t.last - t.open) : 0,
  };
}

async function main() {
  const site = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>stop activity</title><body style="background:#e8f0ff"><h1>Stop activity</h1></body>');
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${site.address().port}/`;

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-dialog-'));
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
      const { ipcMain, BrowserWindow } = req('electron');
      globalThis.__visible = [];
      ipcMain.on('browser:visible', (_e, v) => globalThis.__visible.push(v));
      globalThis.__command = (c) => BrowserWindow.getAllWindows()[0].webContents.send('app:command', c);
      return true;
    })()`);
    const shown = () => main.run('globalThis.__visible.at(-1)');

    const page = await connect(await target(PORT, (t) => t.type === 'page' && /index\.html/.test(t.url)));
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 950, deviceScaleFactor: 1, mobile: false });
    await page.evaluate(async () => {
      for (let i = 0; i < 60 && !window.connChat; i++) await new Promise((r) => setTimeout(r, 250));
      await new Promise((r) => setTimeout(r, 1000));
      [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Later')?.click();
    });

    await main.run(`globalThis.__command({ name: 'preview', open: true })`);
    await until(page, () => (document.querySelector('#paneslot')?.getBoundingClientRect().width || 0) > 100 || null, null, 5000);
    await page.evaluate((u) => window.conn.browser.action('navigate', u), url);
    const end = Date.now() + 8000;
    while (Date.now() < end && (await shown()) !== true) await sleep(100);
    check('preview-live', (await shown()) === true, JSON.stringify(await main.run('globalThis.__visible')));
    await sleep(1000);

    const opens = [
      ['usage-by-click', async () => {
        const at = await page.evaluate(() => {
          const r = document.querySelector('[title^="Tokens, cost and plan limits"]').getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
        for (const type of ['mousePressed', 'mouseReleased']) {
          await page.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
        }
      }],
      ['palette-by-chord', async () => {
        await page.evaluate(() => document.querySelector('#agent-root [contenteditable="true"]').focus());
        await key(page, 'k', 'KeyK', 75, 2);
      }],
    ];
    for (const [name, open] of opens) {
      await page.run(`(${trace})()`);
      await open();
      await until(page, () => document.querySelector('#paneslot .pane-still') || null, null, 3000);
      await sleep(400);
      const p = await page.evaluate(placement);
      console.log(`  ${name} ${JSON.stringify(p)}`);
      check(`${name}-centered-on-window`, Math.abs(p.boxCenter - p.windowCenter) <= 2,
        `box center ${p.boxCenter}, window center ${p.windowCenter}`);
      check(`${name}-freezes-preview`, (await shown()) === false && p.coverMs !== null, JSON.stringify(p));

      await key(page, 'Escape', 'Escape', 27);
      await until(page, () => !document.querySelector('[data-slot="dialog-content"]') || null, null, 3000);
      await until(page, () => !document.querySelector('#paneslot .pane-still') || null, null, 3000);
      await sleep(400);
      check(`${name}-close-brings-preview-back`, (await shown()) === true, `visible ${await shown()}`);
    }

    page.ws.close();
    main.ws.close();
  } finally {
    const exited = new Promise((r) => app.once('exit', r));
    app.kill();
    const stuck = setTimeout(() => app.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(stuck);
    site.close();
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
  }

  console.log(failures.length ? `\n${failures.length} failed` : '\nall passed');
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
