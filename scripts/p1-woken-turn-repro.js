'use strict';
/* A turn the SDK starts on its own, driven in the real app. When a background
   agent or shell finishes, the SDK wakes the main thread and runs a turn nobody
   sent: it opens with a system init and ends with a result like any other. The
   chat has to read as running for the whole of it, with Stop in the composer
   and a spinner on its rail row, and go back to idle at its result. It read as
   idle throughout, because only a human send ever marked a chat busy.

   The agent is answered from the main process over the Node inspector, and the
   woken turn is pushed from there on the same chat with no send behind it.
   Runs on a throwaway HOME. Needs a built renderer: `npx vite build` first. */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9361;
const INSPECT = 9362;
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

function view(title) {
  const row = document.querySelector(`[data-sidebar="menu-button"][title="${title}"]`);
  return {
    stop: !!document.querySelector('#agent-root button[type="submit"] .lucide-square'),
    transcript: document.querySelector('#agent-root')?.textContent || '',
    rail: row && {
      spinner: !!row.querySelector('svg.animate-spin'),
      badge: [...row.querySelectorAll('[data-slot="badge"]')].map((b) => b.textContent.trim()).join(','),
    },
  };
}

const text = (t) => ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: t }] } });
const INIT = { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-haiku-4-5' };
const RESULT = { type: 'result', subtype: 'success', duration_ms: 10 };
const WOKEN = [
  { type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed' },
  INIT,
  text('The agent is back, picking up from there.'),
];

async function main() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-woken-'));
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
      const { ipcMain } = req('electron');
      globalThis.__sent = [];
      ipcMain.removeHandler('agent:send');
      ipcMain.handle('agent:send', (e, { chat, text }) => {
        globalThis.__sent.push(text);
        globalThis.__say = (msgs) => msgs.forEach((msg) => e.sender.send('agent:message', { chat, msg }));
        setTimeout(() => globalThis.__say([${JSON.stringify(INIT)}, ${JSON.stringify(text('on it'))}, ${JSON.stringify(RESULT)}]), 50);
        return { ok: true };
      });
      return true;
    })()`);
    const say = (msgs) => main.run(`globalThis.__say(${JSON.stringify(msgs)})`);

    const page = await connect(await target(PORT, (t) => t.type === 'page' && /index\.html/.test(t.url)));
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 950, deviceScaleFactor: 1, mobile: false });
    await page.evaluate(async () => {
      for (let i = 0; i < 60 && !window.connChat; i++) await new Promise((r) => setTimeout(r, 250));
      await new Promise((r) => setTimeout(r, 1000));
      [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Later')?.click();
    });
    await page.run(`window.__view = ${view}`);
    const state = () => page.evaluate(() => window.__view('first task'));

    await page.evaluate(() => document.querySelector('#agent-root [contenteditable="true"]').focus());
    await page.send('Input.insertText', { text: 'first task' });
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });

    await until(page, () => {
      const s = window.__view('first task');
      return /done in/.test(s.transcript) && !s.stop && s.rail ? true : null;
    }, null, 5000);
    const first = await state();
    check('idle-after-human-turn', /on it/.test(first.transcript) && !first.stop && first.rail && !first.rail.spinner && !first.rail.badge,
      JSON.stringify({ stop: first.stop, rail: first.rail, sent: await main.run('globalThis.__sent') }));

    await say(WOKEN);
    await until(page, () => /picking up from there/.test(window.__view('first task').transcript) || null, null, 3000);
    await sleep(300);
    const woken = await state();
    check('woken-turn-shows-stop', /picking up from there/.test(woken.transcript) && woken.stop === true, `stop ${woken.stop}`);
    check('woken-turn-rail-busy', woken.rail?.spinner === true && woken.rail.badge === 'working', JSON.stringify(woken.rail));
    check('woken-turn-sent-nothing', JSON.stringify(await main.run('globalThis.__sent')) === '["first task"]',
      JSON.stringify(await main.run('globalThis.__sent')));

    await say([RESULT]);
    await until(page, () => {
      const s = window.__view('first task');
      return (s.transcript.match(/done in/g) || []).length === 2 && !s.stop ? true : null;
    }, null, 3000);
    const after = await state();
    check('idle-after-woken-result', (after.transcript.match(/done in/g) || []).length === 2 && after.stop === false, `stop ${after.stop}`);
    check('rail-idle-after-woken-result', after.rail && !after.rail.spinner && !after.rail.badge, JSON.stringify(after.rail));

    page.ws.close();
    main.ws.close();
  } finally {
    const exited = new Promise((r) => app.once('exit', r));
    app.kill();
    const stuck = setTimeout(() => app.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(stuck);
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
  }

  console.log(failures.length ? `\n${failures.length} failed` : '\nall passed');
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
