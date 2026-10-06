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

const { boardDir, CANVAS_DIR } = require('../src/shared/canvas');

const ROOT = path.join(__dirname, '..');
const PORT = 9347;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
};

// A Claude transcript the rail lists, the way a chat left behind by an earlier run looks on disk.
const RESTORED = { id: '5e5e5e5e-0000-4000-8000-000000000001', board: 'restoreboard', title: 'restore me' };

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-per-chat-'));
  const home = path.join(base, 'home');
  const project = path.join(base, 'alpha');
  const older = path.join(base, 'beta');
  for (const d of [home, project, older]) fs.mkdirSync(d, { recursive: true });
  const log = path.join(base, 'acp.log');
  const agent = path.join(base, 'agent');
  fs.writeFileSync(agent, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(ROOT, 'scripts/mock-acp-cli.js'))} "$@"\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(home, '.conn'), { recursive: true });
  fs.writeFileSync(path.join(home, '.conn', 'open-projects.json'), JSON.stringify([project, older]));
  const transcripts = path.join(home, '.claude', 'projects', project.replace(/[/.]/g, '-'));
  fs.mkdirSync(transcripts, { recursive: true });
  const at = new Date().toISOString();
  fs.writeFileSync(path.join(transcripts, `${RESTORED.id}.jsonl`), [
    { type: 'user', sessionId: RESTORED.id, cwd: project, timestamp: at, uuid: `${RESTORED.id}-u`, message: { role: 'user', content: RESTORED.title } },
    { type: 'assistant', sessionId: RESTORED.id, cwd: project, timestamp: at, uuid: `${RESTORED.id}-a`, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.writeFileSync(path.join(home, '.conn', 'canvas-ids.json'), JSON.stringify({ [RESTORED.id]: RESTORED.board }));
  drawFrame(project, boardDir(RESTORED.board), 'restored.json', 'Restored');
  fs.writeFileSync(path.join(home, '.conn', 'settings.json'), JSON.stringify({
    agent: { provider: 'cursor', mode: 'bypass' },
    cursor: { binary: agent },
  }));
  fs.mkdirSync(path.join(older, CANVAS_DIR), { recursive: true });
  fs.writeFileSync(path.join(older, CANVAS_DIR, 'old-design.json'), JSON.stringify({ type: 'frame', name: 'Old design', x: 0, y: 0, width: 200, height: 100, fill: '#ffffff' }));
  return { base, home, project, older, log };
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
async function startChat(page, fx, words, dir = fx.project) {
  const before = entries(fx.log).filter((e) => e.method === 'session/prompt').length;
  await page.evaluate(async (d) => {
    window.connChat.newChat(d);
    await new Promise((r) => setTimeout(r, 600));
    window.connChat.design();
    await new Promise((r) => setTimeout(r, 400));
  }, dir);
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

function drawFrame(root, board, file, name) {
  const dir = path.join(root, board);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), JSON.stringify({ type: 'frame', name, x: 0, y: 0, width: 240, height: 120, fill: '#ffffff' }));
}

const idsOnDisk = (fx) => {
  try { return JSON.parse(fs.readFileSync(path.join(fx.home, '.conn', 'canvas-ids.json'), 'utf8')); } catch { return {}; }
};

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

    const boardA = boardIn(a.prompt?.text);
    const boardB = boardIn(b.prompt?.text);
    check('brief-names-a-board', !!boardA && !!boardB, `prompt=${JSON.stringify(a.prompt?.text?.slice(0, 400))}`);
    check('chats-get-different-boards', boardA && boardB && boardA !== boardB, `both told ${boardA}`);
    if (boardA && boardB) {
      drawFrame(fx.project, boardA, 'pricing-card.json', 'Pricing card');
      drawFrame(fx.project, boardB, 'signup-form.json', 'Signup form');
      const onB = await until(async () => { const f = await framesOnBoard(page); return f.length ? f : null; }, 5000);
      check('board-b-shows-only-b', JSON.stringify(onB) === JSON.stringify(['signup-form.json']), `chat B board: ${JSON.stringify(onB)}`);
      await showChat(page, a.key);
      const onA = await until(async () => {
        const f = await framesOnBoard(page);
        return f.includes('pricing-card.json') || f.length > 1 ? f : null;
      }, 5000);
      check('board-a-shows-only-a', JSON.stringify(onA) === JSON.stringify(['pricing-card.json']), `chat A board: ${JSON.stringify(onA)}`);
    }

    const transform = () => page.evaluate(() => document.querySelector('#canvas-view [data-canvas-world]')?.style.transform || null);
    const fitted = await transform();
    const middle = await page.evaluate(() => {
      const r = document.querySelector('#canvas-view [data-canvas-board]').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...middle, deltaX: 0, deltaY: -240, modifiers: 2 });
    await sleep(300);
    const zoomed = await transform();
    await showChat(page, b.key);
    await sleep(400);
    const beside = await transform();
    await showChat(page, a.key);
    await sleep(400);
    check('board-remembers-its-viewport', zoomed !== fitted && beside !== zoomed && (await transform()) === zoomed, `fitted ${fitted}, zoomed ${zoomed}, other chat ${beside}, back ${await transform()}`);

    const sessionA = await until(() => page.evaluate((k) => window.__rail?.chats?.find((c) => c.key === k)?.session || null, a.key));
    const written = boardA && sessionA && await until(() => (idsOnDisk(fx)[sessionA] === path.basename(boardA) ? idsOnDisk(fx) : null), 5000);
    check('mapping-written', !!written, `session ${sessionA}, board ${boardA}, canvas-ids.json: ${JSON.stringify(idsOnDisk(fx))}`);

    const chatsDir = await page.evaluate(async () => (await window.conn.project.info()).chats);
    const loose = await startChat(page, fx, 'draw a landing page', chatsDir);
    const boardL = boardIn(loose.prompt?.text);
    const looseFrame = boardL && (drawFrame(chatsDir, boardL, 'landing.json', 'Landing'), await until(async () => {
      const f = await framesOnBoard(page);
      return f.length ? f : null;
    }, 5000));
    check(
      'folderless-board-under-chats-dir',
      /^\.conn\/canvas\/[a-z0-9]{6,32}$/.test(boardL || '') && loose.started?.cwd === chatsDir && JSON.stringify(looseFrame) === JSON.stringify(['landing.json']),
      `board ${boardL}, session cwd ${loose.started?.cwd}, frames ${JSON.stringify(looseFrame)}`,
    );

    const fresh = await startChat(page, fx, 'draw a dashboard', fx.older);
    const boardO = boardIn(fresh.prompt?.text);
    const legacyFile = path.join(fx.older, CANVAS_DIR, 'old-design.json');
    const offer = await until(() => page.evaluate(() => document.querySelector('#canvas-view [data-canvas-legacy]')?.textContent || null), 5000);
    await page.evaluate(() => [...document.querySelectorAll('#canvas-view [data-canvas-legacy] button')].find((b) => /Move them here/.test(b.textContent))?.click());
    const adopted = await until(async () => {
      const f = await framesOnBoard(page);
      return f.length ? f : null;
    }, 5000);
    const again = boardO && await page.evaluate((dir, id) => window.conn.canvas.adopt(dir, id), fx.older, path.basename(boardO));
    check(
      'adopt-moves-legacy',
      /1 earlier design/.test(offer || '') && JSON.stringify(adopted) === JSON.stringify(['old-design.json'])
        && !fs.existsSync(legacyFile) && fs.existsSync(path.join(fx.older, boardO || '', 'old-design.json'))
        && again?.moved?.length === 0,
      `offer ${JSON.stringify(offer)}, board draws ${JSON.stringify(adopted)}, legacy file left: ${fs.existsSync(legacyFile)}, second adopt ${JSON.stringify(again)}`,
    );

    fs.writeFileSync(legacyFile, '{"type":"frame","name":"Newer"}');
    const kept = await page.evaluate((dir, id) => window.conn.canvas.adopt(dir, id), fx.older, path.basename(boardO || ''));
    check(
      'adopt-keeps-a-taken-name',
      JSON.stringify(kept) === JSON.stringify({ moved: [], skipped: ['old-design.json'] })
        && fs.existsSync(legacyFile) && JSON.parse(fs.readFileSync(path.join(fx.older, boardO || '', 'old-design.json'), 'utf8')).name === 'Old design',
      `second name: ${JSON.stringify(kept)}`,
    );

    // Opening a Claude chat switches the window to Claude, which has no login here, so what follows runs last.
    const restored = await page.evaluate(async (want, dir) => {
      const data = await window.conn.agent.history();
      const row = data.projects.find((p) => p.dir === dir)?.sessions.find((r) => r.id === want);
      if (!row) return null;
      await window.connChat.open({ ...row, project: dir });
      await new Promise((r) => setTimeout(r, 600));
      window.connChat.design();
      await new Promise((r) => setTimeout(r, 400));
      return row.canvas;
    }, RESTORED.id, fx.project);
    const back = await until(async () => {
      const f = await framesOnBoard(page);
      return f.length ? f : null;
    }, 5000);
    check('board-survives-restart', restored === RESTORED.board && JSON.stringify(back) === JSON.stringify(['restored.json']), `rail row says ${restored}, board draws ${JSON.stringify(back)}`);

    const restoredBoard = path.join(fx.project, boardDir(RESTORED.board));
    await page.evaluate(async (id, dir) => {
      await window.connChat.remove({ id, project: dir, key: window.__rail.active });
    }, RESTORED.id, fx.project);
    const gone = await until(() => (!fs.existsSync(restoredBoard) && !(RESTORED.id in idsOnDisk(fx)) ? true : null), 5000);
    check('deleting-a-chat-takes-its-board', !!gone, `board folder exists: ${fs.existsSync(restoredBoard)}, canvas-ids.json: ${JSON.stringify(idsOnDisk(fx))}`);

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
