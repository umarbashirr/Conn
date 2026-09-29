'use strict';
/* Subagents in the chat, driven in the real app. A reply starts three agents,
   one of them an explorer, each with steps of its own. A Working pill above the
   composer counts them; it opens a panel listing each with a live line; a row
   opens the agent in a sheet over the chat with what the parent sent and its
   own stream; back returns to the chat; a finished explorer shows a funnel;
   Stop All stops every running one; and the pill goes once nothing runs.

   The agent and stopTask are answered from the main process over the Node
   inspector with Claude-shaped messages, so no agent runs. Screenshots of the
   panel and the sheet land in the temp directory. Runs on a throwaway HOME.
   Needs a built renderer: `npx vite build` first. */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9341;
const INSPECT = 9342;
const SHOTS = {
  panel: path.join(os.tmpdir(), 'conn-working-panel.png'),
  sheet: path.join(os.tmpdir(), 'conn-subagent-sheet.png'),
};
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
    await sleep(150);
  }
  return last;
}

async function click(page, selector) {
  const p = await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }, selector);
  if (!p) throw new Error(`nothing to click at ${selector}`);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none', buttons: 0 });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(250);
}

async function shoot(page, file) {
  const res = await page.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(file, Buffer.from(res.result.data, 'base64'));
}

const AGENTS = [
  { id: 'toolu_design', task: 'task_design', type: 'general-purpose', description: 'Handover design GPT',
    prompt: 'Design the handover flow for the travel CMS. Read the architect skill first, then the existing signup canvas, and propose the screens a GPT needs to hand a booking over to a human agent. Keep it to three screens. Say which states each screen has and what the agent sees when the customer drops off halfway.' },
  { id: 'toolu_audit', task: 'task_audit', type: 'general-purpose', description: 'Audit the booking API',
    prompt: 'Find every place the booking API writes without a transaction.' },
  { id: 'toolu_explore', task: 'task_explore', type: 'Explore', description: 'Explore the repo layout',
    prompt: 'Map the repo: where the CMS, the API and the shared types live.' },
];

const agentCall = (a) => ({ type: 'tool_use', id: a.id, name: 'Agent', input: { description: a.description, prompt: a.prompt, subagent_type: a.type } });
const read = (parent, id, file) => [
  { type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: file } }] } },
  { type: 'user', parent_tool_use_id: parent, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } },
];
const FIRST = [
  { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Splitting this three ways.' }, ...AGENTS.map(agentCall)] } },
  ...AGENTS.map((a) => ({ type: 'system', subtype: 'task_started', task_id: a.task, tool_use_id: a.id, description: a.description, subagent_type: a.type })),
  { type: 'assistant', parent_tool_use_id: 'toolu_design', message: { content: [{ type: 'text', text: 'Starting with the architect skill so the screens follow the house rules.' }] } },
  ...read('toolu_design', 'd1', '/skills/architect/README.md'),
  ...read('toolu_design', 'd2', '/skills/architect/rules.md'),
  ...read('toolu_design', 'd3', '/skills/architect/examples.md'),
  { type: 'assistant', parent_tool_use_id: 'toolu_design', message: { content: [{ type: 'tool_use', id: 'd4', name: 'Read', input: { file_path: '/skills/architect/SKILL.md' } }] } },
  { type: 'assistant', parent_tool_use_id: 'toolu_audit', message: { content: [{ type: 'tool_use', id: 'a1', name: 'Grep', input: { pattern: 'db.insert' } }] } },
];
const EXPLORED = { type: 'system', subtype: 'task_notification', task_id: 'task_explore', tool_use_id: 'toolu_explore', status: 'completed', summary: 'Three packages' };
const SECOND = [
  { type: 'assistant', parent_tool_use_id: null, message: { content: [agentCall({ id: 'toolu_again', type: 'Explore', description: 'Explore the tests', prompt: 'Where are the tests?' })] } },
  { type: 'system', subtype: 'task_started', task_id: 'task_again', tool_use_id: 'toolu_again', description: 'Explore the tests', subagent_type: 'Explore' },
];
const AGAIN_DONE = [
  { type: 'system', subtype: 'task_notification', task_id: 'task_again', tool_use_id: 'toolu_again', status: 'completed', summary: 'Under test/' },
  { type: 'result', subtype: 'success', result: 'done' },
];

function pill() {
  const p = document.querySelector('[data-slot="working-pill"]');
  return p && { text: p.textContent.trim(), expanded: p.getAttribute('aria-expanded') };
}

function panelRows() {
  const panel = document.querySelector('[data-slot="working-panel"]');
  if (!panel) return null;
  return [...panel.querySelectorAll('[data-subagent]')].map((r) => ({
    id: r.dataset.subagent, text: r.textContent.replace(/\s+/g, ' ').trim(), spinning: !!r.querySelector('.conn-braille'),
  }));
}

function sheetState() {
  const s = document.querySelector('[data-slot="subagent-sheet"]');
  if (!s) return null;
  return {
    label: s.getAttribute('aria-label'),
    full: s.dataset.full,
    sent: s.querySelector('[data-slot="sent-by-parent"]')?.textContent.replace(/\s+/g, ' ').trim() || '',
    body: s.textContent.replace(/\s+/g, ' '),
    activity: s.querySelector('[data-slot="subagent-activity"]')?.textContent.trim() || null,
  };
}

async function main() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-subagents-'));
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
      const turns = [${JSON.stringify(FIRST)}, ${JSON.stringify(SECOND)}];
      globalThis.__stopped = [];
      ipcMain.removeHandler('agent:send');
      ipcMain.handle('agent:send', (e, { chat }) => {
        globalThis.__say = (msgs) => msgs.forEach((msg) => e.sender.send('agent:message', { chat, msg }));
        const turn = turns.shift() || [];
        setTimeout(() => globalThis.__say(turn), 50);
        return { ok: true };
      });
      ipcMain.removeHandler('agent:stopTask');
      ipcMain.handle('agent:stopTask', (_e, { id }) => { globalThis.__stopped.push(id); return { ok: true }; });
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

    const ask = async (text) => {
      await page.evaluate(() => document.querySelector('#agent-root [contenteditable="true"]').focus());
      await page.send('Input.insertText', { text });
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    };

    check('no-pill-before-agents', (await page.evaluate(pill)) === null, JSON.stringify(await page.evaluate(pill)));
    await ask('design the handover flow');

    const counted = await until(page, () => {
      const p = document.querySelector('[data-slot="working-pill"]');
      return p && /3/.test(p.textContent) ? p.textContent.trim() : null;
    }, null, 8000);
    check('pill-counts-running-agents', /Working\s*3/.test(counted || ''), counted);

    const inline = await page.evaluate(() => [...document.querySelectorAll('#agent-root [data-subagent]')]
      .filter((r) => !r.closest('[data-slot="working-panel"]'))
      .map((r) => ({ text: r.textContent, spinning: !!r.querySelector('.conn-braille') })));
    check('inline-links-per-agent', inline.length === 3 && inline.every((r) => r.spinning), JSON.stringify(inline));

    const frames = await page.evaluate(async () => {
      const el = document.querySelector('.conn-braille');
      const seen = new Set();
      for (let i = 0; i < 8; i++) {
        seen.add(getComputedStyle(el, '::before').content);
        await new Promise((r) => setTimeout(r, 90));
      }
      return seen.size;
    });
    check('spinner-animates', frames > 2, `${frames} frames`);

    await click(page, '[data-slot="working-pill"]');
    const rows = await until(page, panelRows, null, 3000);
    const row = (id) => rows?.find((r) => r.id === id)?.text || '';
    check('panel-opens-from-pill', (await page.evaluate(pill))?.expanded === 'true' && rows?.length === 3, JSON.stringify(rows));
    check('panel-row-live-read', /Handover design GPT/.test(row('toolu_design')) && /Reading architect\/SKILL\.md/.test(row('toolu_design')), row('toolu_design'));
    check('panel-row-live-search', /Audit the booking API/.test(row('toolu_audit')) && /db\.insert/.test(row('toolu_audit')), row('toolu_audit'));
    check('panel-row-planning', /Explore the repo layout/.test(row('toolu_explore')) && /Planning next moves/.test(row('toolu_explore')), row('toolu_explore'));
    check('panel-rows-spin', rows?.every((r) => r.spinning), JSON.stringify(rows));
    await shoot(page, SHOTS.panel);

    await click(page, '[data-slot="working-panel"] [data-subagent="toolu_design"]');
    const opened = await until(page, sheetState, null, 3000);
    check('row-opens-sheet', opened?.label === 'Handover design GPT', JSON.stringify(opened?.label));
    check('panel-closes-on-open', (await page.evaluate(panelRows)) === null, 'panel still open');
    check('sheet-shows-parent-prompt', /Sent by parent/.test(opened?.sent) && opened.sent.includes('Design the handover flow'), opened?.sent);
    check('sheet-shows-child-stream', /Starting with the architect skill/.test(opened?.body) && /SKILL\.md/.test(opened?.body), opened?.body.slice(0, 300));
    check('sheet-shows-live-line', opened?.activity === 'Reading architect/SKILL.md', opened?.activity);
    const clamp = () => page.evaluate(() => {
      const b = document.querySelector('[data-slot="sent-by-parent"]');
      return { expanded: b.getAttribute('aria-expanded'), clamped: !!b.querySelector('.line-clamp-3') };
    });
    check('prompt-clamped', JSON.stringify(await clamp()) === JSON.stringify({ expanded: 'false', clamped: true }), JSON.stringify(await clamp()));
    await shoot(page, SHOTS.sheet);
    await click(page, '[data-slot="sent-by-parent"]');
    check('prompt-expands', JSON.stringify(await clamp()) === JSON.stringify({ expanded: 'true', clamped: false }), JSON.stringify(await clamp()));

    await click(page, '[data-slot="subagent-sheet"] [aria-label="Expand"]');
    check('expand-fills-column', (await page.evaluate(sheetState))?.full === 'true', JSON.stringify((await page.evaluate(sheetState))?.full));
    await click(page, '[data-slot="subagent-sheet"] [aria-label="Back to the chat"]');
    check('back-returns-to-chat', (await page.evaluate(sheetState)) === null && await page.evaluate(() => /Splitting this three ways/.test(document.querySelector('#agent-root').textContent)), 'sheet still open');

    await click(page, '#agent-root [data-subagent="toolu_audit"]');
    check('inline-link-opens-sheet', (await until(page, sheetState, null, 3000))?.label === 'Audit the booking API', JSON.stringify((await page.evaluate(sheetState))?.label));
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    check('escape-closes-sheet', (await until(page, (x) => !document.querySelector('[data-slot="subagent-sheet"]') || null, null, 2000)) === true, 'sheet still open');

    await say([EXPLORED]);
    const two = await until(page, () => {
      const p = document.querySelector('[data-slot="working-pill"]');
      return p && /2/.test(p.textContent) ? p.textContent.trim() : null;
    }, null, 3000);
    check('pill-drops-finished-agent', /Working\s*2/.test(two || ''), two);
    const funnel = await page.evaluate(() => {
      const r = document.querySelector('#agent-root [data-subagent="toolu_explore"]');
      return r && { funnel: !!r.querySelector('.lucide-funnel'), spinning: !!r.querySelector('.conn-braille'), text: r.textContent };
    });
    check('finished-explorer-shows-funnel', funnel?.funnel && !funnel.spinning, JSON.stringify(funnel));

    await click(page, '[data-slot="working-pill"]');
    check('panel-lists-remaining', (await until(page, panelRows, null, 3000))?.length === 2, JSON.stringify(await page.evaluate(panelRows)));
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('[data-slot="working-panel"] button')].find((x) => /Stop All/.test(x.textContent));
      b.dataset.probe = 'stop-all';
    });
    await click(page, '[data-probe="stop-all"]');
    const stopped = await until(page, () => !document.querySelector('[data-slot="working-pill"]') || null, null, 3000);
    const calls = await main.run('globalThis.__stopped');
    check('stop-all-stops-each', JSON.stringify([...calls].sort()) === JSON.stringify(['task_audit', 'task_design']), JSON.stringify(calls));
    check('pill-gone-after-stop-all', stopped === true && (await page.evaluate(panelRows)) === null, JSON.stringify(await page.evaluate(pill)));

    await say([{ type: 'result', subtype: 'success', result: 'stopped' }]);
    await sleep(300);
    await ask('where are the tests');
    const back = await until(page, () => {
      const p = document.querySelector('[data-slot="working-pill"]');
      return p && /1/.test(p.textContent) ? p.textContent.trim() : null;
    }, null, 5000);
    check('pill-returns-for-new-agent', /Working\s*1/.test(back || ''), back);
    await say(AGAIN_DONE);
    check('pill-gone-when-all-done', (await until(page, () => !document.querySelector('[data-slot="working-pill"]') || null, null, 3000)) === true, JSON.stringify(await page.evaluate(pill)));

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

  console.log(`\npanel ${SHOTS.panel}\nsheet ${SHOTS.sheet}`);
  console.log(failures.length ? `\n${failures.length} failed` : '\nall passed');
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
