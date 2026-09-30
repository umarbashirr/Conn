'use strict';
/* A chat with no folder is still a chat inside Conn. Its agent has to get the
   conn MCP server and the preview-pane instructions like a project chat does,
   and a page it opens has to land in that chat's own column.

   Drives the real app over the DevTools protocol on a throwaway HOME, with the
   stand-in ACP agent as the Cursor CLI so no real account is used. Needs a
   built renderer: `npx vite build` first. */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9334;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
};

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-folderless-'));
  const home = path.join(base, 'home');
  const project = path.join(base, 'alpha');
  for (const d of [home, project]) fs.mkdirSync(d, { recursive: true });
  const log = path.join(base, 'acp.log');
  const agent = path.join(base, 'agent');
  fs.writeFileSync(agent, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(ROOT, 'scripts/mock-acp-cli.js'))} "$@"\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(home, '.conn'), { recursive: true });
  fs.writeFileSync(path.join(home, '.conn', 'open-projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(home, '.conn', 'settings.json'), JSON.stringify({
    agent: { provider: 'cursor', mode: 'auto' },
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

async function main() {
  const fx = fixture();
  const electron = require(path.join(ROOT, 'node_modules', 'electron'));
  const app = spawn(electron, [
    ROOT, `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(fx.base, 'userdata')}`, '--no-sandbox',
  ], { env: { ...process.env, HOME: fx.home, CONN_CWD: fx.project, MOCK_ACP_LOG: fx.log }, stdio: 'ignore' });

  try {
    const page = await connect(await renderer());
    await page.evaluate(async () => {
      for (let i = 0; i < 60 && !window.connChat; i++) await new Promise((r) => setTimeout(r, 250));
      await new Promise((r) => setTimeout(r, 1000));
    });
    const chats = await page.evaluate(async () => (await window.conn.project.info()).chats);

    await page.evaluate(async (dir) => {
      window.connChat.newChat(dir);
      await new Promise((r) => setTimeout(r, 800));
      document.querySelector('[contenteditable="true"]')?.focus();
    }, chats);
    await page.send('Input.insertText', { text: 'fill out the form at example.com' });
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });

    const started = await until(() => entries(fx.log).find((e) => e.method === 'session/new' && e.cwd === chats));
    const prompt = await until(() => entries(fx.log).find((e) => e.method === 'session/prompt'));
    check('folderless-session-started', !!started, `no session/new in ${chats}: ${JSON.stringify(entries(fx.log).map((e) => [e.method, e.cwd]))}`);
    const conn = started?.mcpServers?.find((s) => s.name === 'conn');
    check('folderless-gets-conn-mcp', !!conn, `servers=${JSON.stringify((started?.mcpServers || []).map((s) => s.name))}`);
    check('folderless-told-about-preview', /preview pane inside this app/.test(prompt?.text || ''), `prompt=${JSON.stringify(prompt?.text)}`);

    if (conn) {
      const env = Object.fromEntries((conn.env || []).map(({ name, value }) => [name, value]));
      const res = await fetch(`${env.CONN_BRIDGE_URL}/tool/navigate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-conn-token': env.CONN_TOKEN, 'x-conn-cwd': env.CONN_CWD },
        body: JSON.stringify({ url: 'about:blank' }),
      });
      const body = await res.json().catch(() => ({}));
      check('folderless-navigate-ok', res.ok && !body.error, `${res.status} ${JSON.stringify(body)}`);
      const tabs = await until(() => page.evaluate(() => {
        const list = [...document.querySelectorAll('section#right [role="tab"]')].map((t) => t.textContent.trim());
        return list.length ? list : null;
      }), 5000);
      check('folderless-preview-tab-in-its-column', !!tabs?.length, 'no tab drawn in the chat on screen');
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
