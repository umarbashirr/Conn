'use strict';
/* A table or diagram in the chat opened full window, with a page up in the
   preview. The preview is a native view the window paints above the document,
   so it has to be frozen behind a still while anything covers it. Streamdown's
   fullscreen layers are not Radix layers, nobody froze the pane for them, and
   the live page painted straight through the open table.

   The agent is answered from the main process over the Node inspector. What
   main is told about the pane's visibility is read off the same IPC that sets
   the native view. Runs on a throwaway HOME. Needs a built renderer:
   `npx vite build` first. */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9371;
const INSPECT = 9372;
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

async function click(page, { x, y }) {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  }
}

const REPLY = [
  'Here is the stack.',
  '',
  '| PR | Branch | Commits |',
  '| --- | --- | --- |',
  '| https://github.com/acme/api/pull/46 | `feat/severity` | 2 commits |',
  '| https://github.com/acme/web/pull/71 | `feat/severity` | 1 commit |',
  '',
  '```mermaid',
  'graph LR',
  '  A[api] --> B[web]',
  '```',
].join('\n');

const text = (t) => ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: t }] } });
const INIT = { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-haiku-4-5' };
const RESULT = { type: 'result', subtype: 'success', duration_ms: 10 };

function fullscreenButton(scope) {
  const block = document.querySelector(scope);
  const btn = block && [...block.querySelectorAll('button')].find((b) => b.title === 'View fullscreen');
  if (!btn) return null;
  const r = btn.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

const covered = () => !!document.querySelector('#paneslot .pane-still');

async function main() {
  const site = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>stop activity</title><body style="background:#e8f0ff"><h1>Stop activity</h1></body>');
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${site.address().port}/`;

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-fullscreen-'));
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
      ipcMain.removeHandler('agent:send');
      ipcMain.handle('agent:send', (e, { chat }) => {
        const msgs = [${JSON.stringify(INIT)}, ${JSON.stringify(text(REPLY))}, ${JSON.stringify(RESULT)}];
        setTimeout(() => msgs.forEach((msg) => e.sender.send('agent:message', { chat, msg })), 50);
        return { ok: true };
      });
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

    await page.evaluate(() => document.querySelector('#agent-root [contenteditable="true"]').focus());
    await page.send('Input.insertText', { text: 'list the stack' });
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });

    for (const [name, scope, layer] of [
      ['table', '[data-streamdown="table-wrapper"]', '[data-streamdown="table-fullscreen"]'],
      ['mermaid', '[data-streamdown="mermaid-block"]', 'body > .fixed.inset-0'],
    ]) {
      const at = await until(page, fullscreenButton, scope, 20000);
      if (!at) { check(`${name}-fullscreen-button`, false, 'never rendered'); continue; }
      await click(page, at);
      const open = await until(page, (sel) => !!document.querySelector(sel) || null, layer, 3000);
      check(`${name}-fullscreen-open`, !!open, 'overlay never mounted');
      await until(page, covered, null, 3000);
      await sleep(300);
      check(`${name}-fullscreen-freezes-preview`, (await shown()) === false && await page.evaluate(covered),
        JSON.stringify({ visible: await shown(), still: await page.evaluate(covered) }));

      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await until(page, (sel) => !document.querySelector(sel) || null, layer, 3000);
      await until(page, () => !document.querySelector('#paneslot .pane-still') || null, null, 3000);
      await sleep(300);
      check(`${name}-close-brings-preview-back`, (await shown()) === true && !(await page.evaluate(covered)),
        JSON.stringify({ visible: await shown(), still: await page.evaluate(covered) }));
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
