'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MOCK = path.join(ROOT, 'scripts/mock-acp-cli.js');
const REQUIRE = `process.getBuiltinModule('module').createRequire(${JSON.stringify(path.join(ROOT, 'src/main/index.js'))})`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
};

const isZombie = (pid) => fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').pop()[0] === 'Z';
const alive = (pid) => {
  try { return !isZombie(pid); } catch { return false; }
};

async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(150);
  }
  return last;
}

async function target(port, pick) {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json();
      const hit = list.find(pick);
      if (hit) return hit.webSocketDebuggerUrl;
    } catch {}
    await sleep(500);
  }
  throw new Error(`nothing on ${port}`);
}

async function endpoints(app, userData) {
  let err = '';
  app.stderr.on('data', (d) => { err += d; });
  const file = path.join(userData, 'DevToolsActivePort');
  for (let i = 0; i < 120; i++) {
    const inspector = err.match(/Debugger listening on (ws:\/\/\S+)/)?.[1];
    const cdp = fs.existsSync(file) && Number(fs.readFileSync(file, 'utf8').split('\n')[0]);
    if (inspector && cdp) return { inspector, cdp };
    if (app.exitCode !== null || app.signalCode !== null) {
      throw new Error(`app exited (${app.exitCode ?? app.signalCode}) before its debug ports:\n${err.slice(-500)}`);
    }
    await sleep(250);
  }
  throw new Error(`no debug endpoints: ${err.slice(-300)}`);
}

function connect(url) {
  const ws = new WebSocket(url);
  let seq = 0;
  const waiting = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
  };
  const run = (expression) => new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, (res) => {
      if (res.result?.exceptionDetails) reject(new Error(JSON.stringify(res.result.exceptionDetails)));
      else resolve(res.result?.result?.value);
    });
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  const evaluate = (fn, ...args) => run(`(${fn})(...${JSON.stringify(args)})`);
  return new Promise((resolve) => { ws.onopen = () => resolve({ ws, run, evaluate }); });
}

const lines = (file) => (fs.existsSync(file)
  ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
  : []);
const logged = (file) => lines(file).map((l) => JSON.parse(l));

function agent(dir, name, prefix, extra) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, [
    '#!/bin/sh',
    `export MOCK_ACP_STORE=${prefix} MOCK_ACP_LINGER=1 MOCK_ACP_PIDS=${JSON.stringify(path.join(dir, 'pids'))} MOCK_ACP_LOG=${JSON.stringify(path.join(dir, `${prefix}.log`))} ${extra}`,
    `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(MOCK)} "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  return file;
}

const textOf = (m) => (m.message.content.find((b) => b.type === 'text') || {}).text;

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'build', 'renderer', 'index.html'))) throw new Error('no renderer build: run `npx vite build` first');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-acp-history-'));
  const home = path.join(base, 'home');
  const proj = path.join(base, 'shop');
  const bin = path.join(base, 'bin');
  for (const d of [path.join(home, '.conn'), proj, bin]) fs.mkdirSync(d, { recursive: true });
  const cursor = agent(bin, 'agent', 'cursor', 'MOCK_ACP_DELETE=0');
  const opencode = agent(bin, 'opencode', 'opencode', 'MOCK_ACP_DELETE=1');
  fs.writeFileSync(path.join(home, '.conn', 'open-projects.json'), JSON.stringify([proj]));
  fs.writeFileSync(path.join(home, '.conn', 'settings.json'), JSON.stringify({
    agent: { provider: 'cursor', mode: 'bypass' },
    cursor: { binary: cursor },
    opencode: { binary: opencode },
  }));

  const electron = require(path.join(ROOT, 'node_modules', 'electron'));
  const userData = path.join(base, 'userdata');
  const app = spawn(electron, [
    '--inspect=0', ROOT, '--remote-debugging-port=0', `--user-data-dir=${userData}`, '--no-sandbox',
  ], { env: { ...process.env, HOME: home, CONN_CWD: proj }, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  const exited = new Promise((r) => app.once('exit', r));
  const spawned = () => lines(path.join(bin, 'pids')).map((l) => l.split(' '));

  try {
    const { inspector, cdp } = await endpoints(app, userData);
    const shell = await connect(await target(cdp, (t) => t.type === 'page' && /index\.html/.test(t.url)));
    const main = await connect(inspector);
    await shell.evaluate(async () => {
      for (let i = 0; i < 60 && !window.conn?.agent; i++) await new Promise((r) => setTimeout(r, 250));
    });

    const call = (expression) => shell.run(`(async () => { try { return { ok: await ${expression} }; } catch (e) { return { thrown: e.message }; } })()`);
    const rail = async () => {
      const { ok } = await call('window.conn.agent.history()');
      return (ok?.projects || []).find((p) => p.dir === proj)?.sessions || [];
    };

    const listed = await until(async () => {
      const found = await rail();
      return found.some((r) => r.provider === 'cursor') && found.some((r) => r.provider === 'opencode') && found;
    });
    const rows = listed || await rail();
    const cursorOne = rows.find((r) => r.id === 'cursor-chat-0001');
    check('rail-lists-the-cursor-chat', cursorOne?.provider === 'cursor' && cursorOne.title === 'Make the button red', JSON.stringify(rows));
    check('rail-lists-the-opencode-chat', rows.some((r) => r.id === 'opencode-chat-0001' && r.provider === 'opencode'), JSON.stringify(rows));
    check('rail-follows-the-next-page', rows.some((r) => r.id === 'cursor-chat-0002' && r.title === 'Older chat on page two'), JSON.stringify(rows));
    check('rail-rows-are-unique', rows.length > 0 && new Set(rows.map((r) => r.id)).size === rows.length, JSON.stringify(rows));
    check('rail-orders-newest-first', rows.findIndex((r) => r.id === 'cursor-chat-0001') < rows.findIndex((r) => r.id === 'cursor-chat-0002'), JSON.stringify(rows));

    const { ok: t, thrown } = await call(`window.conn.agent.transcript('cursor-chat-0001', ${JSON.stringify(proj)})`);
    const msgs = t?.messages || [];
    const shape = msgs.map((m) => `${m.type}:${m.message.content.map((b) => b.type).join('+')}`).join(' ');
    check('transcript-has-the-whole-conversation', shape === 'user:text assistant:thinking assistant:text assistant:tool_use user:tool_result assistant:text user:text', `${thrown || ''} ${shape}`);
    check('first-user-text-has-no-preface', msgs[0] && textOf(msgs[0]) === 'make the button red', JSON.stringify(msgs[0]));
    check('thought-is-a-thinking-block', msgs[1]?.message.content[0].thinking === 'the css lives in style.css', JSON.stringify(msgs[1]));
    check('agent-chunks-merge-into-one-block', msgs[2] && textOf(msgs[2]) === 'Sure, I will change it.', JSON.stringify(msgs[2]));
    const use = msgs[3]?.message.content[0];
    const result = msgs[4]?.message.content[0];
    check('tool-row-has-its-name-and-input', use?.name === 'Edit' && use.input?.path === 'style.css', JSON.stringify(use));
    check('tool-row-has-its-result', !!use && result?.tool_use_id === use.id && result.content === 'edited style.css' && result.is_error === false, JSON.stringify(result));
    check('transcript-is-not-truncated', t?.truncated === false, JSON.stringify(t?.truncated));
    check('unadvertised-close-is-not-sent', msgs.length > 0 && !logged(path.join(bin, 'cursor.log')).some((e) => e.method === 'session/close'), 'session/close sent to an agent that did not advertise it');

    const { ok: o } = await call(`window.conn.agent.transcript('opencode-chat-0001', ${JSON.stringify(proj)})`);
    check('opencode-transcript-reads', (o?.messages || []).length === 7, JSON.stringify(o?.messages?.length));
    check('advertised-close-is-sent-after-the-read', logged(path.join(bin, 'opencode.log')).some((e) => e.method === 'session/close' && e.sessionId === 'opencode-chat-0001'), 'no session/close');

    const refused = await call(`window.conn.agent.deleteSession('cursor-chat-0002', ${JSON.stringify(proj)})`);
    check('delete-errors-cleanly-when-not-advertised', /cannot delete/i.test(refused.ok?.error || ''), JSON.stringify(refused));
    check('refused-delete-leaves-the-chat-listed', (await rail()).some((r) => r.id === 'cursor-chat-0002'), 'the chat vanished');

    const deleted = await call(`window.conn.agent.deleteSession('opencode-chat-0002', ${JSON.stringify(proj)})`);
    check('delete-succeeds-when-advertised', deleted.ok?.ok === true, JSON.stringify(deleted));
    check('delete-reached-the-agent', logged(path.join(bin, 'opencode.log')).some((e) => e.method === 'session/delete' && e.sessionId === 'opencode-chat-0002'), 'no session/delete');
    const after = await rail();
    check('deleted-chat-leaves-the-rail', after.some((r) => r.id === 'opencode-chat-0001') && !after.some((r) => r.id === 'opencode-chat-0002'), JSON.stringify(after));

    const held = spawned().filter(([what]) => what === 'list').map(([, pid]) => Number(pid));
    check('history-agents-are-held-open', held.length > 0 && held.every(alive), JSON.stringify(spawned()));

    await main.run(`(${REQUIRE}('electron').app.quit(), true)`);
    shell.ws.close();
    main.ws.close();
    check('app-quits', await until(() => app.exitCode !== null || app.signalCode !== null, 15000), 'Electron still running 15 s after app.quit()');
    await sleep(500);
    const left = [...new Set(spawned().map(([, pid]) => Number(pid)))].filter(alive);
    check('no-mock-agent-outlives-the-app', left.length === 0, `still running: ${left.join(",")} of ${JSON.stringify(spawned())}`);
  } finally {
    for (const pid of spawned().map(([, p]) => Number(p)).filter(alive)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    try { process.kill(-app.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    await exited;
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
  }

  console.log(failures.length ? `\n${failures.length} failed` : '\nall passed');
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
