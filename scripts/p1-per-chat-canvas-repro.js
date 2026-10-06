'use strict';
/* Two chats in one folder are two pieces of work, and each draws on its own
   Canvas board. The brief names a folder that is the chat's alone, the board
   shows only that folder, and the pairing survives a restart.

   Drives the real app over the DevTools protocol on a throwaway HOME, with the
   stand-in ACP agent as the Cursor CLI. The test writes frames where the brief
   told the agent to, which is all an agent does to draw. Needs a built
   renderer: `npx vite build` first. */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9347;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
};

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-per-chat-'));
  const home = path.join(base, 'home');
  const project = path.join(base, 'alpha');
  for (const d of [home, project]) fs.mkdirSync(d, { recursive: true });
  const log = path.join(base, 'acp.log');
  const agent = path.join(base, 'agent');
  fs.writeFileSync(agent, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(ROOT, 'scripts/mock-acp-cli.js'))} "$@"\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(home, '.conn'), { recursive: true });
  fs.writeFileSync(path.join(home, '.conn', 'open-projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(home, '.conn', 'settings.json'), JSON.stringify({
    agent: { provider: 'cursor', mode: 'bypass' },
    cursor: { binary: agent },
  }));
  return { base, home, project, log };
}

async function renderer() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error('renderer never came up');
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
  const evaluate = async (fn, ...args) => {
    const res = await send('Runtime.evaluate', {
      expression: `(${fn})(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true,
    });
    if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails));
    return res.result?.result?.value;
  };
  return new Promise((resolve) => { ws.onopen = () => resolve({ ws, send, evaluate }); });
}

const entries = (log) => (fs.existsSync(log)
  ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : []);

async function until(fn, ms = 15000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(200);
  }
  return null;
}

async function type(page, text) {
  await page.evaluate(() => document.querySelector('[contenteditable="true"]')?.focus());
  await page.send('Input.insertText', { text });
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
}

// A new chat in the folder, with $canvas in the message, sent. The model list
// starts sessions of its own that never get a prompt, so the chat's session is
// the last one started before its prompt arrived.
async function startChat(page, fx, words) {
  const before = entries(fx.log).filter((e) => e.method === 'session/prompt').length;
  await page.evaluate(async (dir) => {
    window.connChat.newChat(dir);
    await new Promise((r) => setTimeout(r, 600));
    window.connChat.design();
    await new Promise((r) => setTimeout(r, 400));
  }, fx.project);
  await type(page, words);
  const prompt = await until(() => entries(fx.log).filter((e) => e.method === 'session/prompt')[before]);
  const log = entries(fx.log);
  const started = log.slice(0, log.indexOf(log.filter((e) => e.method === 'session/prompt')[before]))
    .filter((e) => e.method === 'session/new').pop();
  const key = await page.evaluate(() => window.__rail?.active);
  return { key, started, prompt };
}

// The folder the brief told the agent to write frames into, relative to its cwd.
const boardIn = (text) => /A new frame is a new file, (\S+)\/<kebab-name>\.json/.exec(text || '')?.[1] || null;

function drawFrame(fx, board, file, name) {
  const dir = path.join(fx.project, board);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), JSON.stringify({ type: 'frame', name, x: 0, y: 0, width: 240, height: 120, fill: '#ffffff' }));
}

const framesOnBoard = (page) => page.evaluate(() => [...document.querySelectorAll('#canvas-view [data-frame]')].map((f) => f.dataset.frame).sort());

async function showChat(page, key) {
  await page.evaluate(async (k) => {
    await window.connChat.open({ key: k });
    await new Promise((r) => setTimeout(r, 300));
  }, key);
}

async function main() {
  const fx = fixture();
  const electron = require(path.join(ROOT, 'node_modules', 'electron'));
  const app = spawn(electron, [
    ROOT, `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(fx.base, 'userdata')}`, '--no-sandbox',
  ], { env: { ...process.env, HOME: fx.home, CONN_CWD: fx.project, MOCK_ACP_LOG: fx.log }, stdio: 'ignore' });

  try {
    const page = await connect(await renderer());
    await page.evaluate(async () => {
      for (let i = 0; i < 60 && !(window.connChat && window.connRail); i++) await new Promise((r) => setTimeout(r, 250));
      const sync = window.connRail.sync;
      window.connRail.sync = (x) => { window.__rail = x; sync(x); };
      await new Promise((r) => setTimeout(r, 1000));
    });

    const a = await startChat(page, fx, 'draw a pricing card');
    const b = await startChat(page, fx, 'draw a signup form');
    check('two-chats-started', a.key && b.key && a.key !== b.key && a.started && b.started, JSON.stringify({ a: a.key, b: b.key }));

    // ---- Canvas: one board per chat.
    const boardA = boardIn(a.prompt?.text);
    const boardB = boardIn(b.prompt?.text);
    check('brief-names-a-board', !!boardA && !!boardB, `prompt=${JSON.stringify(a.prompt?.text?.slice(0, 400))}`);
    check('chats-get-different-boards', boardA && boardB && boardA !== boardB, `both told ${boardA}`);
    if (boardA && boardB) {
      drawFrame(fx, boardA, 'pricing-card.json', 'Pricing card');
      drawFrame(fx, boardB, 'signup-form.json', 'Signup form');
      const onB = await until(async () => { const f = await framesOnBoard(page); return f.length ? f : null; }, 5000);
      check('board-b-shows-only-b', JSON.stringify(onB) === JSON.stringify(['signup-form.json']), `chat B board: ${JSON.stringify(onB)}`);
      await showChat(page, a.key);
      const onA = await until(async () => {
        const f = await framesOnBoard(page);
        return f.includes('pricing-card.json') || f.length > 1 ? f : null;
      }, 5000);
      check('board-a-shows-only-a', JSON.stringify(onA) === JSON.stringify(['pricing-card.json']), `chat A board: ${JSON.stringify(onA)}`);
    }

    page.ws.close();
  } finally {
    const exited = new Promise((r) => app.once('exit', r));
    app.kill();
    await exited;
    fs.rmSync(fx.base, { recursive: true, force: true, maxRetries: 5 });
  }

  console.log(failures.length ? `\n${failures.length} failed` : '\nall passed');
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
