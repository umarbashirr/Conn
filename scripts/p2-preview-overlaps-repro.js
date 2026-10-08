'use strict';
/* Toasts and toolbar tooltips with a page up in the preview. The preview is a
   native view the window paints above the document, so anything the document
   draws inside the view's bounds is hidden while the view is live. Toasts sat
   top right, on the preview. Tooltips on the bars above the preview opened
   downward into it.

   The view's bounds are read off the IPC that places it, and each layer passes
   when it stays clear of them or the view is frozen behind a still. Runs on a
   throwaway HOME. Needs a built renderer: `npx vite build` first. */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9391;
const INSPECT = 9392;
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

function layer({ sel, view }) {
  const el = [...document.querySelectorAll(sel)].at(-1);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const overlap = r.right > view.x + 1 && r.left < view.x + view.width - 1
    && r.bottom > view.y + 1 && r.top < view.y + view.height - 1;
  return {
    overlap,
    still: !!document.querySelector('#paneslot .pane-still'),
    rect: [r.left, r.top, r.right, r.bottom].map(Math.round),
    view: [view.x, view.y, view.x + view.width, view.y + view.height],
  };
}

async function main() {
  const site = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>stop activity</title><body style="background:#e8f0ff"><h1>Stop activity</h1></body>');
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${site.address().port}/`;

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-overlaps-'));
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
      ipcMain.on('browser:bounds', (_e, b) => { globalThis.__bounds = b; });
      globalThis.__command = (c) => BrowserWindow.getAllWindows()[0].webContents.send('app:command', c);
      // A window behind others is throttled, and a transition or a capture then
      // takes seconds instead of a frame.
      globalThis.__front = () => BrowserWindow.getAllWindows()[0].setAlwaysOnTop(true);
      return true;
    })()`);
    const shown = () => main.run('globalThis.__visible.at(-1)');
    const command = (c) => main.run(`globalThis.__command(${JSON.stringify(c)})`);

    const page = await connect(await target(PORT, (t) => t.type === 'page' && /index\.html/.test(t.url)));
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 950, deviceScaleFactor: 1, mobile: false });
    await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await main.run('globalThis.__front()');
    await page.evaluate(async () => {
      for (let i = 0; i < 60 && !window.connChat; i++) await new Promise((r) => setTimeout(r, 250));
      await new Promise((r) => setTimeout(r, 1000));
      [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Later')?.click();
    });

    await command({ name: 'preview', open: true });
    await until(page, () => (document.querySelector('#paneslot')?.getBoundingClientRect().width || 0) > 100 || null, null, 5000);
    await page.evaluate((u) => window.conn.browser.action('navigate', u), url);
    const end = Date.now() + 8000;
    while (Date.now() < end && (await shown()) !== true) await sleep(100);
    check('preview-live', (await shown()) === true, JSON.stringify(await main.run('globalThis.__visible')));
    await sleep(800);

    // Seen means clear of the live view, or the view frozen behind a still.
    async function seen(name, sel) {
      let last = null;
      const stop = Date.now() + 2500;
      while (Date.now() < stop) {
        const view = await main.run('globalThis.__bounds');
        if (!view) { await sleep(100); continue; }
        const hit = await page.evaluate(layer, { sel, view });
        if (!hit) { last = null; break; }
        last = { ...hit, visible: await shown() };
        if (!last.overlap || (last.visible === false && last.still)) break;
        await sleep(100);
      }
      console.log(`  ${name} ${JSON.stringify(last)}`);
      return !!last && (!last.overlap || (last.visible === false && last.still));
    }

    // Update checks land late with toasts that never time out, and one parked
    // on the toolbar would take the hover meant for a button.
    async function clearToasts() {
      await page.evaluate(() => document.querySelectorAll('[data-sonner-toast]').forEach((t) => {
        const close = t.querySelector('[data-close-button]')
          || [...t.querySelectorAll('button')].find((b) => /^(later|ignore|ok)$/i.test(b.textContent.trim()));
        close?.click();
      }));
      await until(page, () => !document.querySelector('[data-sonner-toast]') || null, null, 3000);
      await sleep(400);
    }

    async function toastCase(name) {
      await clearToasts();
      await command({ name: 'about' });
      // Judged where it settles, not on the way in from above the window.
      await until(page, () => {
        const t = [...document.querySelectorAll('[data-sonner-toast]')].at(-1);
        return (t && t.getBoundingClientRect().top >= 39) || null;
      }, null, 3000);
      check(name, await seen(name, '[data-sonner-toast]'), 'toast under the live preview');
      await clearToasts();
    }

    // Focus opens a Radix tooltip as surely as a hover, without the pointer
    // heuristics a synthetic mouse trips over.
    async function tipCase(name, sel) {
      await clearToasts();
      const ready = await until(page, (q) => !!document.querySelector(q)?.getBoundingClientRect().width || null, sel, 5000);
      if (!ready) { check(name, false, `no ${sel}`); return; }
      await page.evaluate((q) => document.querySelector(q).focus(), sel);
      const open = await until(page, () => !!document.querySelector('[data-slot="tooltip-content"]') || null, null, 3000);
      if (!open) { check(name, false, 'tooltip never opened'); return; }
      await sleep(300);
      check(name, await seen(name, '[data-slot="tooltip-content"]'), 'tooltip under the live preview');
      await page.evaluate(() => document.activeElement?.blur());
      await until(page, () => !document.querySelector('[data-slot="tooltip-content"]') || null, null, 3000);
    }

    await toastCase('toast-beside-preview');
    await tipCase('toolbar-tooltip-clear-of-preview', '#right button:has(.lucide-rotate-cw)');

    await page.evaluate(() => window.conn.browser.action('setViewport', { width: 1280, height: 800 }));
    await until(page, () => !!document.querySelector('#right button:has(.lucide-rotate-ccw-square)') || null, null, 5000);
    await sleep(500);
    await tipCase('responsive-tooltip-clear-of-preview', '#right button:has(.lucide-rotate-ccw-square)');
    await page.evaluate(() => window.conn.browser.action('setViewport', null));
    await sleep(500);

    await command({ name: 'previewFull', open: true });
    await sleep(800);
    await toastCase('toast-at-full-width');
    await command({ name: 'previewFull', open: false });
    await sleep(800);
    check('preview-live-after', (await shown()) === true, `visible ${await shown()}`);

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
