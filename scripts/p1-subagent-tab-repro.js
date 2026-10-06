'use strict';
/* A Claude chat's main thread has the person's app open in a tab. A subagent
   it starts goes off to read the web. The subagent's first navigate opens a tab
   of its own behind the app, so the app's page and the strip's front tab are
   untouched, and once the subagent finishes its tab stays for anyone to pick up.

   Claude's side is stood in for from the main process over the Node inspector:
   AgentSession starts no CLI, and the browser tools are called through the same
   invoke the in-process MCP server calls, with the main thread's and a
   subagent's actors. Runs on a throwaway HOME. Needs a built renderer:
   `npx vite build` first. */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9349;
const INSPECT = 9350;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
};

function pages() {
  const server = http.createServer((req, res) => {
    const name = req.url.replace(/^\//, '') || 'root';
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>${name}</title><h1>${name}</h1>`);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function target(port, pick) {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const hit = list.find(pick);
      if (hit) return hit.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error(`nothing on ${port}`);
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
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-subagent-tab-'));
  const home = path.join(base, 'home');
  const proj = path.join(base, 'shop');
  for (const d of [home, proj]) fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(path.join(home, '.conn'), { recursive: true });
  fs.writeFileSync(path.join(home, '.conn', 'open-projects.json'), JSON.stringify([proj]));
  fs.writeFileSync(path.join(home, '.conn', 'settings.json'), JSON.stringify({ agent: { provider: 'claude', mode: 'bypass' } }));

  const site = await pages();
  const at = (p) => `http://127.0.0.1:${site.address().port}/${p}`;
  const electron = require(path.join(ROOT, 'node_modules', 'electron'));
  const app = spawn(electron, [
    `--inspect=${INSPECT}`, ROOT, `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(base, 'userdata')}`, '--no-sandbox',
  ], { env: { ...process.env, HOME: home, CONN_CWD: proj }, stdio: 'ignore' });

  try {
    const main = await connect(await target(INSPECT, (t) => t.type === 'node'));
    await main.run(`(() => {
      const req = process.getBuiltinModule('module').createRequire(${JSON.stringify(path.join(ROOT, 'src/main/index.js'))});
      const { AgentSession } = req('./agent');
      AgentSession.prototype.start = async function start() {
        globalThis.__agent = this;
        this.sessionId = '7a7a7a7a-0000-4000-8000-000000000001';
        setTimeout(() => this.emit('ready', { sessionId: this.sessionId }), 0);
      };
      AgentSession.prototype.send = function send() {};
      AgentSession.prototype.models = async function models() { return []; };
      return true;
    })()`);

    const page = await connect(await target(PORT, (t) => t.type === 'page' && /index\.html/.test(t.url)));
    await page.evaluate(async () => {
      for (let i = 0; i < 60 && !window.connChat; i++) await new Promise((r) => setTimeout(r, 250));
      await new Promise((r) => setTimeout(r, 1000));
      document.querySelector('[contenteditable="true"]')?.focus();
    });
    await page.send('Input.insertText', { text: 'run the shop and research competitors' });
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    check('claude-session-stood-in', await until(() => main.run('!!globalThis.__agent')), 'no AgentSession was started');

    const invoke = (tool, args, actor) => main.run(`globalThis.__agent.invoke(${JSON.stringify(tool)}, ${JSON.stringify(args)}, ${JSON.stringify(actor)})`);
    const MAIN = { id: 'main', label: 'the main thread' };
    const SUB = { id: 'task-research-1', label: 'Research competitor pricing', type: 'general-purpose' };
    const strip = () => page.evaluate(() => ({
      tabs: [...document.querySelectorAll('section#right [role="tab"]')].map((t) => t.textContent.trim()),
      front: document.querySelector('section#right [role="tab"][aria-selected="true"]')?.textContent.trim() || null,
    }));

    await invoke('navigate', { url: at('app') }, MAIN);
    const appUp = await until(async () => { const s = await strip(); return s.tabs.includes('app') ? s : null; });
    check('main-thread-opens-the-app', !!appUp, JSON.stringify(await strip()));

    await invoke('navigate', { url: at('research') }, SUB);
    const both = await until(async () => { const s = await strip(); return s.tabs.includes('research') ? s : null; });
    check('subagent-gets-its-own-tab', JSON.stringify(both?.tabs.filter((t) => /app|research/.test(t))) === JSON.stringify(['app', 'research']), JSON.stringify(both));
    check('subagent-tab-stays-behind', both?.front === 'app', `front tab is ${both?.front}`);

    const mainState = await invoke('state', {}, MAIN);
    const subState = await invoke('state', {}, SUB);
    check('main-thread-page-untouched', mainState?.url === at('app'), `main thread reads ${mainState?.url}`);
    check('subagent-reads-its-own-page', subState?.url === at('research'), `subagent reads ${subState?.url}`);

    await invoke('click', { target: 'h1' }, SUB);
    const listed = await invoke('tabs', {}, MAIN);
    const research = listed?.tabs?.find((t) => t.url === at('research'));
    check('listing-names-the-subagent', research?.driver === SUB.label && listed?.tabs?.find((t) => t.url === at('app'))?.driver === 'you', JSON.stringify(listed));

    await main.run(`globalThis.__agent.emit('message', { type: 'system', subtype: 'task_notification', task_id: ${JSON.stringify(SUB.id)}, status: 'completed' })`);
    const after = await invoke('tabs', {}, MAIN);
    check('finished-subagent-lets-go', after?.tabs?.length === 2 && after.tabs.find((t) => t.url === at('research'))?.driver === null, JSON.stringify(after));

    await invoke('tabSelect', { tab: research?.id }, MAIN);
    const picked = await invoke('state', {}, MAIN);
    check('main-thread-picks-up-the-research', picked?.url === at('research'), `main thread reads ${picked?.url}`);

    page.ws.close();
    main.ws.close();
  } finally {
    site.close();
    const exited = new Promise((r) => app.once('exit', r));
    app.kill();
    await exited;
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
  }

  console.log(failures.length ? `\n${failures.length} failed` : '\nall passed');
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
