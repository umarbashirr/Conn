'use strict';
/* A decided permission, drawn in the real app. While a card is open it is the
   amber card with Allow, Always and Deny. Once answered, it belongs on the row
   of the call it let through, as a small "allowed", "always allowed" or
   "denied" mark, and not as a line of its own reading "Allowed Bash" that looks
   like a button. A Claude card names its row; a preview-bridge card cannot and
   is paired with its call by tool. An answered question keeps its Q/A line, and
   a subagent's card, whose row is not in the main list, stays a line.

   The agent is answered from the main process over the Node inspector: the
   send, the messages and the permission cards are pushed from there, and the
   decisions are recorded there instead of reaching a session. Runs on a
   throwaway HOME. Needs a built renderer: `npx vite build` first. */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9503;
const INSPECT = 9504;
const SHOTS = '/tmp/live-card-shots';
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

// Where a real click lands on the transcript's button that reads, is labelled or is titled this.
function spot(text) {
  const el = [...document.querySelectorAll('#agent-root button')]
    .find((b) => b.textContent.trim() === text || b.getAttribute('aria-label') === text || b.title === text);
  if (!el) return null;
  el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
}

async function click(page, text) {
  const p = await page.evaluate(spot, text);
  if (!p) throw new Error(`no button reading ${text} to click`);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none', buttons: 0 });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(250);
}

function view() {
  const root = document.querySelector('#agent-root');
  const buttons = [...root.querySelectorAll('button')].map((b) => b.textContent.trim());
  const mark = (id) => document.querySelector(`#row-${id} [data-slot="perm-mark"]`)?.textContent.trim() ?? null;
  const lines = [...root.querySelectorAll('div')]
    .map((d) => d.textContent.replace(/\s+/g, ' ').trim())
    .filter((t) => /^(Allowed|Always allow|Denied) \S+$/.test(t));
  const qa = [...root.querySelectorAll('div')]
    .filter((d) => d.children.length === 2 && d.children[0].tagName === 'DIV' && d.children[1].tagName === 'DIV')
    .map((d) => [d.children[0].textContent.trim(), d.children[1].textContent.trim()]);
  return {
    card: ['Allow', 'Always', 'Deny'].every((t) => buttons.includes(t)),
    question: buttons.includes('Send answer'),
    marks: { tb1: mark('tb1'), tw1: mark('tw1'), tq1: mark('tq1') },
    allMarks: [...root.querySelectorAll('[data-slot="perm-mark"]')].map((m) => m.textContent.trim()),
    lines: [...new Set(lines)],
    qa,
    transcript: root.textContent,
  };
}

const call = (id, name, input) => ({
  type: 'assistant', parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const result = (id, content) => ({
  type: 'user', parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
});
const INIT = { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-haiku-4-5' };
const RESULT = { type: 'result', subtype: 'success', duration_ms: 1200 };
const QUESTIONS = [{
  question: 'Which database should the app use?',
  header: 'Database',
  multiSelect: false,
  options: [
    { label: 'Postgres', description: 'A server, for anything shared' },
    { label: 'SQLite', description: 'A file beside the app' },
  ],
}];

async function main() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-perm-mark-'));
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
      globalThis.__decided = [];
      ipcMain.removeAllListeners('agent:decide');
      ipcMain.on('agent:decide', (_e, { id, decision }) => { globalThis.__decided.push({ id, decision }); });
      ipcMain.removeHandler('agent:send');
      ipcMain.handle('agent:send', (e, { chat }) => {
        globalThis.__say = (msgs) => msgs.forEach((msg) => e.sender.send('agent:message', { chat, msg }));
        globalThis.__perm = (p) => e.sender.send('agent:permission', { chat, ...p });
        setTimeout(() => globalThis.__say([${JSON.stringify(INIT)}]), 50);
        return { ok: true };
      });
      return true;
    })()`);
    const say = (msgs) => main.run(`globalThis.__say(${JSON.stringify(msgs)})`);
    const ask = (p) => main.run(`globalThis.__perm(${JSON.stringify(p)})`);
    const decided = () => main.run('globalThis.__decided');

    const page = await connect(await target(PORT, (t) => t.type === 'page' && /index\.html/.test(t.url)));
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 950, deviceScaleFactor: 1, mobile: false });
    await page.evaluate(async () => {
      for (let i = 0; i < 60 && !window.connChat; i++) await new Promise((r) => setTimeout(r, 250));
      await new Promise((r) => setTimeout(r, 1000));
      [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Later')?.click();
    });
    await page.run(`window.__view = ${view}`);
    const state = () => page.evaluate(() => window.__view());

    await page.evaluate(() => document.querySelector('#agent-root [contenteditable="true"]').focus());
    await page.send('Input.insertText', { text: 'set up the database' });
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await until(page, () => /set up the database/.test(document.querySelector('#agent-root').textContent) || null, null, 5000);
    await sleep(200);

    await say([call('tb1', 'Bash', { command: 'ls' })]);
    await ask({ id: 'p1', tool: 'Bash', input: { command: 'ls' }, forId: 'tb1', agent: null });
    const asked = await until(page, () => (window.__view().card ? window.__view() : null), null, 3000);
    check('bash-card-asks', asked?.card === true && asked.marks.tb1 === null, JSON.stringify(asked && { card: asked.card, marks: asked.marks }));

    await click(page, 'Allow');
    await until(page, () => window.__view().marks.tb1 || null, null, 2000);
    const allowed = await state();
    check('allow-marks-the-bash-row', allowed.marks.tb1 === 'allowed', `row tb1 mark ${JSON.stringify(allowed.marks.tb1)}`);
    check('allow-leaves-no-line', !allowed.lines.includes('Allowed Bash'), `lines ${JSON.stringify(allowed.lines)}`);
    check('allow-card-gone', allowed.card === false, 'the Allow/Always/Deny card is still up');
    check('allow-reaches-main', JSON.stringify(await decided()) === JSON.stringify([{ id: 'p1', decision: 'allow' }]),
      JSON.stringify(await decided()));
    await say([result('tb1', 'package.json\nsrc')]);

    await say([call('tw1', 'mcp__preview__browser_wait', {})]);
    await ask({ id: 'b1', tool: 'browser_waitFor', input: { networkIdle: true }, agent: { id: 'bridge', label: 'preview' } });
    const bridged = await until(page, () => (window.__view().card ? window.__view() : null), null, 3000);
    check('bridge-card-asks', bridged?.card === true, 'no Allow/Always/Deny card for the bridge prompt');

    await click(page, 'Always');
    await until(page, () => window.__view().marks.tw1 || null, null, 2000);
    const always = await state();
    check('always-marks-the-wait-row', always.marks.tw1 === 'always allowed', `row tw1 mark ${JSON.stringify(always.marks.tw1)}`);
    check('always-leaves-no-line', always.lines.length === 0, `lines ${JSON.stringify(always.lines)}`);
    check('always-reaches-main', JSON.stringify((await decided()).at(-1)) === JSON.stringify({ id: 'b1', decision: 'always' }),
      JSON.stringify(await decided()));
    await say([result('tw1', 'network idle')]);

    await say([call('tq1', 'AskUserQuestion', { questions: QUESTIONS })]);
    await ask({ id: 'p2', tool: 'AskUserQuestion', input: { questions: QUESTIONS }, forId: 'tq1', agent: null });
    const question = await until(page, () => (window.__view().question ? window.__view() : null), null, 3000);
    check('question-card-asks', question?.question === true, 'no question card');

    await click(page, 'Postgres');
    await click(page, 'Send answer');
    await until(page, () => !window.__view().question || null, null, 2000);
    const answered = await state();
    check('answer-is-a-qa-line', answered.qa.some(([q, a]) => q === QUESTIONS[0].question && a === 'Postgres'),
      `qa ${JSON.stringify(answered.qa)}`);
    check('answer-marks-no-row', answered.marks.tq1 === null, `row tq1 mark ${JSON.stringify(answered.marks.tq1)}`);
    check('answer-reaches-main', JSON.stringify((await decided()).at(-1)) === JSON.stringify({ id: 'p2', decision: 'allow' }),
      JSON.stringify(await decided()));
    await say([result('tq1', 'User has answered your questions: "Which database should the app use?"="Postgres".')]);

    await ask({ id: 'p3', tool: 'Read', input: { file_path: '/x' }, forId: 'not-in-this-list', agent: { id: 'task1', label: 'helper', toolUseId: 'nope' } });
    const helper = await until(page, () => (window.__view().card ? window.__view() : null), null, 3000);
    check('subagent-card-asks', helper?.card === true, 'no Allow/Always/Deny card for the subagent prompt');

    await click(page, 'Deny');
    await until(page, () => !window.__view().card || null, null, 2000);
    const denied = await state();
    check('subagent-deny-stays-a-line', denied.lines.includes('Denied Read'), `lines ${JSON.stringify(denied.lines)}`);
    check('deny-reaches-main', JSON.stringify((await decided()).at(-1)) === JSON.stringify({ id: 'p3', decision: 'deny' }),
      JSON.stringify(await decided()));

    // Three calls in a row fold into one line once no perm line sits between them.
    if (await page.evaluate(spot, 'Show each call')) await click(page, 'Show each call');
    await until(page, () => window.__view().marks.tb1 || null, null, 2000);
    const folded = await state();
    check('marks-ride-their-rows-into-the-fold', folded.marks.tb1 === 'allowed' && folded.marks.tw1 === 'always allowed',
      JSON.stringify(folded.marks));
    check('subagent-deny-marks-nothing', JSON.stringify(folded.allMarks) === JSON.stringify(['allowed', 'always allowed']),
      `marks ${JSON.stringify(folded.allMarks)}`);

    await say([{ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Postgres it is.' }] } }, RESULT]);
    await until(page, () => /done in/.test(window.__view().transcript) || null, null, 3000);
    const done = await state();
    check('marks-survive-the-turn-end', done.marks.tb1 === 'allowed' && done.marks.tw1 === 'always allowed',
      JSON.stringify(done.marks));

    fs.mkdirSync(SHOTS, { recursive: true });
    const box = await page.evaluate(async () => {
      [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Later')?.click();
      await new Promise((r) => setTimeout(r, 300));
      const r = document.querySelector('#agent-root').getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height, scale: 1 };
    });
    const shot = await page.send('Page.captureScreenshot', { format: 'png', clip: box });
    fs.writeFileSync(path.join(SHOTS, 'perm-marks.png'), Buffer.from(shot.result.data, 'base64'));

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
