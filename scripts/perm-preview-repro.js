'use strict';
/* The permission card shows what it asks about. A Bash card carries the whole
   command in a scrollable block, an Edit card a diff, a Write card its file as
   added lines, and the three buttons name their keys. Any other tool keeps the
   one-line summary. Needs a built renderer: `npx vite build` first. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launch } = require('./lib/launch');

const ROOT = path.join(__dirname, '..');
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
  const card = document.querySelector('[data-perm-card]');
  if (!card) return null;
  const block = card.querySelector('pre, [aria-label="Changes"]');
  return {
    block: block ? block.tagName : null,
    blockText: block ? block.textContent : '',
    scrolls: block ? block.scrollHeight > block.clientHeight : false,
    blockHeight: block ? Math.round(block.getBoundingClientRect().height) : 0,
    added: card.querySelectorAll('[aria-label="Changes"] .text-emerald-700, [aria-label="Changes"] .text-emerald-300').length,
    hints: [...card.querySelectorAll('kbd')].map((k) => k.textContent),
    hintsHidden: [...card.querySelectorAll('kbd')].every((k) => k.getAttribute('aria-hidden') === 'true'),
    names: [...card.querySelectorAll('button')].map((b) => b.getAttribute('aria-label')),
    summary: card.querySelector('.truncate')?.textContent ?? null,
    text: card.textContent,
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

  const { app, inspector, cdp } = await launch(ROOT, { userData: path.join(base, 'userdata'), env: { ...process.env, HOME: home, CONN_CWD: proj } });

  try {
    const main = await connect(inspector);
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

    const page = await connect(await target(cdp, (t) => t.type === 'page' && /index\.html/.test(t.url)));
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

    const LONG = Array.from({ length: 30 }, (_, n) => `echo line ${n}`).join('\n');
    const WRITE = Array.from({ length: 40 }, (_, n) => `export const v${n} = ${n};`).join('\n');
    // An edit asked for with no row of its own here is how a subagent's edit
    // reaches the main transcript; with its row on screen the row shows the diff.
    const cases = [
      ['p1', 'Bash', { command: LONG, description: 'Print thirty lines' }, true],
      ['p2', 'Edit', { file_path: '/p/a.js', old_string: 'one', new_string: 'two' }, false],
      ['p3', 'Write', { file_path: '/p/b.js', content: WRITE }, false],
      ['p4', 'Read', { file_path: '/p/c.js' }, true],
      ['p5', 'Edit', { file_path: '/p/d.js', old_string: 'three', new_string: 'four' }, true],
    ];
    const shown = {};
    for (const [id, tool, input, row] of cases) {
      if (row) await say([call(`t${id}`, tool, input)]);
      await ask({ id, tool, input, forId: `t${id}`, agent: null });
      shown[id] = await until(page, () => window.__view(), null, 3000);
      await click(page, 'Allow');
      await until(page, () => (window.__view() ? null : true), null, 3000);
    }

    check('bash-shows-whole-command', shown.p1?.block === 'PRE' && shown.p1.blockText === LONG, JSON.stringify(shown.p1?.block));
    check('bash-shows-description', /Print thirty lines/.test(shown.p1?.text), 'no description');
    check('long-command-scrolls-in-the-card', shown.p1?.scrolls && shown.p1.blockHeight < 300, `height ${shown.p1?.blockHeight}`);
    check('edit-shows-a-diff', shown.p2?.block === 'DIV' && /one/.test(shown.p2.blockText) && /two/.test(shown.p2.blockText), JSON.stringify(shown.p2?.blockText));
    check('write-shows-added-lines', shown.p3?.added >= 40 && shown.p3.scrolls && shown.p3.blockHeight <= 260, `added ${shown.p3?.added} height ${shown.p3?.blockHeight}`);
    check('edit-with-its-row-on-screen-is-not-previewed-twice', shown.p5 && shown.p5.block === null && /d\.js/.test(shown.p5.summary ?? ''), JSON.stringify(shown.p5));
    check('other-tools-keep-the-summary', shown.p4?.block === null && /c\.js/.test(shown.p4?.summary ?? ''), JSON.stringify(shown.p4));
    check('buttons-name-their-keys', JSON.stringify(shown.p1?.hints) === '["y","a","n"]' && shown.p1.hintsHidden, JSON.stringify(shown.p1?.hints));
    check('buttons-keep-plain-names', JSON.stringify(shown.p1?.names) === '["Allow","Always","Deny"]', JSON.stringify(shown.p1?.names));
    const sent = await main.run('globalThis.__decided');
    check('answers-still-reach-the-agent', sent.length === cases.length && sent.every((d) => d.decision === 'allow'), JSON.stringify(sent));
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
