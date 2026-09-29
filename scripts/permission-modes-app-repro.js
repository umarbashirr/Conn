'use strict';
/* Changing mode mid-chat in the real app, on a Cursor chat whose binary is the
   stand-in agent from permission-modes-repro.js. Bypass is a launch flag for
   Cursor, so a change the running process cannot take has to end that process
   once it is idle, and the next message has to resume the same session under
   the new flag: straight away when idle, after the turn when busy. Every
   process the app starts has to be gone once the app is. Runs on a throwaway
   HOME. Needs a built renderer: `npx vite build` first. */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9345;
const CHAT = 'modes-probe';
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

async function main() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-modes-app-'));
  const home = path.join(base, 'home');
  const proj = path.join(base, 'shop');
  for (const d of [path.join(home, '.conn'), proj]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(home, '.conn', 'open-projects.json'), JSON.stringify([proj]));
  const log = path.join(base, 'agent.log');
  fs.writeFileSync(log, '');
  const refuse = path.join(base, 'logged-out');
  const wrapper = path.join(base, 'fake-cursor');
  fs.writeFileSync(wrapper, [
    '#!/bin/sh',
    `export FAKE_FLAVOR=cursor FAKE_LOG=${JSON.stringify(log)} FAKE_REFUSE=${JSON.stringify(refuse)}`,
    `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(__dirname, 'permission-modes-repro.js'))} --agent "$@"`,
  ].join('\n'));
  fs.chmodSync(wrapper, 0o755);
  fs.writeFileSync(path.join(home, '.conn', 'settings.json'), JSON.stringify({ cursor: { binary: wrapper } }));

  // One entry per process the chat started, in order: how it was launched, how
  // the session was opened, what each permission request got, and whether the
  // process has been told to end. The driver's own model probe runs elsewhere.
  const launches = () => {
    const byPid = new Map();
    for (const e of fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))) {
      if (e.argv) byPid.set(e.pid, { argv: e.argv.join(' '), cwd: e.cwd, answers: [], ended: false });
      const p = byPid.get(e.pid);
      if (e.method) p.method = e.method;
      if ('answer' in e) p.answers.push(e.answer);
      if (e.ended) p.ended = true;
    }
    return [...byPid.values()].filter((p) => p.cwd === fs.realpathSync(proj)).map(({ cwd, ...p }) => p);
  };
  const show = () => JSON.stringify(launches());
  const waitFor = async (fn, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end && !fn(launches())) await sleep(100);
    return fn(launches());
  };

  const electron = require(path.join(ROOT, 'node_modules', 'electron'));
  const app = spawn(electron, [
    ROOT, `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(base, 'userdata')}`, '--no-sandbox',
  ], { env: { ...process.env, HOME: home, CONN_CWD: proj }, stdio: 'ignore' });

  try {
    const page = await connect(await target(PORT, (t) => t.type === 'page' && /index\.html/.test(t.url)));
    await page.evaluate(async (chat) => {
      for (let i = 0; i < 60 && !window.conn?.agent; i++) await new Promise((r) => setTimeout(r, 250));
      window.__probe = { cards: [], session: null };
      window.conn.agent.onPermission((p) => { if (p.chat === chat) window.__probe.cards.push(p.id); });
    }, CHAT);
    const cards = async () => (await page.run('window.__probe.cards')).length;
    const send = (text) => page.evaluate(async (chat, t, project) => {
      const r = await window.conn.agent.send(chat, window.__probe.session, t, [], project, 'cursor');
      if (r?.sessionId) window.__probe.session = r.sessionId;
      return r;
    }, CHAT, text, proj);
    const mode = (m) => page.evaluate((chat, next) => window.conn.agent.mode(chat, next), CHAT, m);
    const answered = (i, n = 1) => waitFor((l) => l[i]?.answers.length >= n);

    fs.writeFileSync(refuse, '');
    const refused = await send('read:a.txt');
    check('failed-start-ends-process', /logged in/.test(refused?.error || '') && await waitFor((l) => l[0]?.ended, 3000), `${JSON.stringify(refused)} ${show()}`);
    fs.rmSync(refuse);

    const first = await send('read:a.txt');
    await answered(1);
    check('ask-launch-has-no-force', launches()[1]?.argv === 'acp' && launches()[1]?.method === 'session/new', `${JSON.stringify(first)} ${show()}`);

    const set = await mode('bypass');
    check('idle-change-to-bypass-ends-process', set?.mode === 'bypass' && await waitFor((l) => l[1].ended, 3000), show());

    const second = await send('execute:rm -rf /tmp/conn-nothing');
    await answered(2);
    const two = launches()[2];
    check('next-message-resumes-with-force', two?.argv === '--force acp' && two?.method === 'session/load', show());
    check('same-session-kept', second?.sessionId && second.sessionId === first?.sessionId, `${first?.sessionId} -> ${second?.sessionId}`);
    check('bypass-auto-approved-no-card', two?.answers[0] === 'allow-once' && (await cards()) === 0, `${show()} cards=${await cards()}`);

    await mode('ask');
    check('back-to-ask-ends-process', await waitFor((l) => l[2].ended, 3000), show());
    await send('execute:ls');
    await waitFor((l) => l.length === 4);
    for (let i = 0; i < 50 && (await cards()) < 1; i++) await sleep(100);
    check('back-to-ask-drops-force-and-cards', launches()[3]?.argv === 'acp' && (await cards()) === 1, `${show()} cards=${await cards()}`);

    await mode('bypass');
    await sleep(500);
    check('busy-change-waits-for-turn', !launches()[3].ended, show());
    const card = (await page.run('window.__probe.cards'))[0];
    await page.evaluate((chat, id) => window.conn.agent.decide(chat, id, 'deny'), CHAT, card);
    check('turn-end-ends-stale-process', await waitFor((l) => l[3].ended && l[3].answers[0] === 'reject-once', 3000), show());

    await send('execute:rm -rf /tmp/conn-nothing');
    await answered(4);
    check('after-busy-change-resumes-with-force', launches()[4]?.argv === '--force acp' && launches()[4]?.answers[0] === 'allow-once', show());

    await mode('ask');
    await waitFor((l) => l[4].ended, 3000);
    await send('read:a.txt');
    await answered(5);
    await mode('plan');
    await sleep(500);
    check('ask-to-plan-moves-in-place', launches().length === 6 && !launches()[5].ended, show());

    page.ws.close();
  } finally {
    const exited = new Promise((r) => app.once('exit', r));
    app.kill();
    const stuck = setTimeout(() => app.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(stuck);
    check('no-agent-outlives-the-app', await waitFor((l) => l.every((x) => x.ended), 3000), show());
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
  }

  console.log(failures.length ? `\n${failures.length} failed` : '\nall passed');
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
