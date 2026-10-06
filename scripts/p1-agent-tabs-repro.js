'use strict';
/* An agent drives its own chat's browser tabs and nobody else's, and it can
   open, list, switch and close them rather than reusing the one it found.

   Drives the real app over the DevTools protocol on a throwaway HOME, with the
   stand-in ACP agent as the Cursor CLI. The agents' side is the real
   mcp/server.js started with the env each chat's agent was handed, which is
   the road a Cursor, Grok, OpenCode or Codex agent takes to the pane. Needs a
   built renderer: `npx vite build` first. */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9348;
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

function pages() {
  const server = http.createServer((req, res) => {
    const name = req.url.replace(/^\//, '') || 'root';
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>${name}</title><h1>${name}</h1>`);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
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

// A new chat in the folder, with a message sent. The model list
// starts sessions of its own that never get a prompt, so the chat's session is
// the last one started before its prompt arrived.
async function startChat(page, fx, words) {
  const before = entries(fx.log).filter((e) => e.method === 'session/prompt').length;
  await page.evaluate(async (dir) => {
    window.connChat.newChat(dir);
    await new Promise((r) => setTimeout(r, 600));
  }, fx.project);
  await type(page, words);
  const prompt = await until(() => entries(fx.log).filter((e) => e.method === 'session/prompt')[before]);
  const log = entries(fx.log);
  const started = log.slice(0, log.indexOf(log.filter((e) => e.method === 'session/prompt')[before]))
    .filter((e) => e.method === 'session/new').pop();
  const key = await page.evaluate(() => window.__rail?.active);
  return { key, started, prompt };
}

async function showChat(page, key) {
  await page.evaluate(async (k) => {
    await window.connChat.open({ key: k });
    await new Promise((r) => setTimeout(r, 300));
  }, key);
}

// The tabs drawn in the column of the chat on screen, and the one it is on.
const stripTabs = (page) => page.evaluate(() => [...document.querySelectorAll('section#right [role="tab"]')].map((t) => t.textContent.trim()));
const activeStripTab = (page) => page.evaluate(() => document.querySelector('section#right [role="tab"][data-state="active"]')?.textContent.trim() ?? null);

// A raw bridge call, the way a terminal's conn CLI makes it: the chat's token
// and folder, and whatever extra headers the caller adds.
async function post(env, tool, args, headers = {}) {
  const res = await fetch(`${env.CONN_BRIDGE_URL}/tool/${tool}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-conn-token': env.CONN_TOKEN, 'x-conn-cwd': env.CONN_CWD, ...headers },
    body: JSON.stringify(args),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function mcpClient(conn) {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const env = Object.fromEntries((conn.env || []).map(({ name, value }) => [name, value]));
  const client = new Client({ name: 'repro', version: '0.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: conn.args,
    env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: '1' },
  }));
  const call = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (res.isError) throw new Error(text);
    try { return JSON.parse(text); } catch { return text; }
  };
  return { client, env, call };
}

async function main() {
  const fx = fixture();
  const site = await pages();
  const at = (p) => `http://127.0.0.1:${site.address().port}/${p}`;
  const electron = require(path.join(ROOT, 'node_modules', 'electron'));
  const app = spawn(electron, [
    ROOT, `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(fx.base, 'userdata')}`, '--no-sandbox',
  ], { env: { ...process.env, HOME: fx.home, CONN_CWD: fx.project, MOCK_ACP_LOG: fx.log }, stdio: 'ignore' });
  const clients = [];

  try {
    const page = await connect(await renderer());
    await page.evaluate(async () => {
      for (let i = 0; i < 60 && !(window.connChat && window.connRail); i++) await new Promise((r) => setTimeout(r, 250));
      const sync = window.connRail.sync;
      window.connRail.sync = (x) => { window.__rail = x; sync(x); };
      await new Promise((r) => setTimeout(r, 1000));
    });

    const a = await startChat(page, fx, 'run the app');
    const b = await startChat(page, fx, 'research pricing pages');
    check('two-chats-started', a.key && b.key && a.key !== b.key && a.started && b.started, JSON.stringify({ a: a.key, b: b.key }));

    // ---- Browser: each agent drives its own chat's tabs.
    const connA = a.started?.mcpServers?.find((s) => s.name === 'conn');
    const connB = b.started?.mcpServers?.find((s) => s.name === 'conn');
    const A = await mcpClient(connA);
    const B = await mcpClient(connB);
    clients.push(A, B);
    check('mcp-env-names-the-chat', A.env.CONN_CHAT === a.key && B.env.CONN_CHAT === b.key && a.key !== b.key,
      JSON.stringify({ a: [A.env.CONN_CHAT, a.key], b: [B.env.CONN_CHAT, b.key] }));

    await showChat(page, b.key);
    await A.call('browser_navigate', { url: at('app') });
    await B.call('browser_navigate', { url: at('research') });
    const stateA = await A.call('browser_state');
    const stateB = await B.call('browser_state');
    check('agent-a-keeps-its-page', stateA?.url === at('app'), `chat A's agent reads ${stateA?.url}`);
    check('agent-b-on-its-page', stateB?.url === at('research'), `chat B's agent reads ${stateB?.url}`);
    const bStrip = await stripTabs(page);
    check('chat-b-column-has-only-its-tab', bStrip.filter((t) => /app|research/.test(t)).join() === 'research', `chat B strip: ${JSON.stringify(bStrip)}`);
    const shot = String(await A.call('browser_screenshot').catch((e) => e.message));
    const [, w, h] = /(\d+)x(\d+)/.exec(shot) || [];
    check('parked-tab-screenshot', Number(w) > 0 && Number(h) > 0, `screenshot of the off-screen tab: ${shot}`);

    // ---- Permission: a bridge call is judged by its own chat's mode, not the on-screen chat's.
    await page.evaluate((k) => window.conn.agent.mode(k, 'plan'), a.key);
    const planned = await A.call('browser_navigate', { url: at('plan') }).then(() => 'allowed', (e) => e.message);
    const bypassed = await B.call('browser_navigate', { url: at('research') }).then(() => 'allowed', (e) => e.message);
    check('bridge-judged-by-its-own-mode', /plan mode only looks at the page/.test(planned) && bypassed === 'allowed', `A in plan: ${planned}; B in bypass: ${bypassed}`);
    await page.evaluate((k) => window.conn.agent.mode(k, 'bypass'), a.key);

    // ---- Terminal: a caller with no chat of its own drives the chat on screen, as before.
    const terminal = await post(B.env, 'navigate', { url: at('terminal') });
    const landed = await B.call('browser_state');
    check('terminal-caller-keeps-the-fallback', terminal.status === 200 && landed?.url === at('terminal'), `${terminal.status} ${JSON.stringify(terminal.body)}; on-screen chat reads ${landed?.url}`);
    await B.call('browser_navigate', { url: at('research') });
    const unknown = await post(B.env, 'navigate', { url: at('nope') }, { 'x-conn-chat': 'c-never-seen' });
    check('unknown-chat-refused', unknown.status === 500 && /c-never-seen/.test(unknown.body?.error || ''), JSON.stringify(unknown));

    // ---- Tabs: an agent can open, list, switch and close its own.
    const tools = (await A.client.listTools()).tools.map((t) => t.name);
    const TAB_TOOLS = ['browser_tabs', 'browser_tab_new', 'browser_tab_select', 'browser_tab_close'];
    check('tab-tools-listed', TAB_TOOLS.every((n) => tools.includes(n)), `tools=${tools.join(',')}`);
    if (TAB_TOOLS.every((n) => tools.includes(n))) {
      const opened = await A.call('browser_tab_new', { url: at('docs') });
      const listed = await A.call('browser_tabs');
      const rows = listed?.tabs || [];
      check('new-tab-listed', rows.length === 2 && rows.some((t) => t.url === at('app')) && rows.some((t) => t.url === at('docs')), JSON.stringify(listed));
      check('listing-names-driven-tab', listed?.current === opened?.tab, JSON.stringify({ listed, opened }));
      const nowA = await A.call('browser_state');
      check('new-tab-is-driven', nowA?.url === at('docs'), `after new: ${nowA?.url}`);
      const appTab = rows.find((t) => t.url === at('app'))?.id;
      await A.call('browser_tab_select', { tab: appTab });
      const back = await A.call('browser_state');
      check('select-switches-driven-tab', back?.url === at('app'), `after select: ${back?.url}`);
      const stillB = await B.call('browser_state');
      check('other-chat-untouched', stillB?.url === at('research'), `chat B now ${stillB?.url}`);
      const foreign = await B.call('browser_tab_select', { tab: appTab }).then(() => null, (e) => e.message);
      check('cannot-select-another-chats-tab', !!foreign, 'chat B selected chat A\'s tab');
      const refusedClose = await B.call('browser_tab_close').then(() => 'closed', (e) => e.message);
      check('close-refused-while-another-drives', /being driven by another agent/.test(refusedClose), `chat B closing the tab the terminal also drives: ${refusedClose}`);
      await A.call('browser_show', { open: true });
      await showChat(page, a.key);
      const shown = await until(() => activeStripTab(page).then((t) => (t === 'app' ? t : null)), 5000);
      check('show-brings-driven-tab-forward', shown === 'app', `chat A's strip is on ${JSON.stringify(await activeStripTab(page))}, driving app`);
      await A.call('browser_tab_close', { tab: opened?.tab });
      const after = await A.call('browser_tabs');
      check('close-removes-tab', (after?.tabs || []).length === 1, JSON.stringify(after));
      const aStrip = await until(async () => { const s = await stripTabs(page); return s.includes('app') && !s.includes('docs') ? s : null; }, 5000);
      check('chat-a-strip-matches', JSON.stringify((aStrip || []).filter((t) => /app|docs|research/.test(t))) === JSON.stringify(['app']), `chat A strip: ${JSON.stringify(aStrip)}`);

      // ---- The human closes the agent's tab from the strip: the agent's next page lands somewhere live.
      await page.evaluate(() => document.querySelector('section#right [role="tab"] [role="button"][aria-label="Close app"]')
        ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true })));
      const emptied = await until(async () => ((await A.call('browser_tabs'))?.tabs || []).length === 0, 5000);
      const again = await A.call('browser_navigate', { url: at('again') }).then(() => null, (e) => e.message);
      const relisted = await A.call('browser_tabs');
      const againStrip = await until(async () => { const s = await stripTabs(page); return s.includes('again') ? s : null; }, 5000);
      check('human-close-unpins', emptied && !again && relisted?.tabs?.length === 1 && relisted.tabs[0].url === at('again') && !!againStrip,
        JSON.stringify({ emptied, again, relisted, strip: againStrip }));
    }

    page.ws.close();
  } finally {
    for (const c of clients) await c.client.close().catch(() => {});
    site.close();
    const exited = new Promise((r) => app.once('exit', r));
    app.kill();
    await exited;
    fs.rmSync(fx.base, { recursive: true, force: true, maxRetries: 5 });
  }

  console.log(failures.length ? `\n${failures.length} failed` : '\nall passed');
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
