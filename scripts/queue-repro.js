'use strict';
/* The follow-up queue, driven in the real app. While a turn runs, Enter on a
   box with something in it parks the message. Enter on an empty box, with
   something parked, stops the turn and sends the message at the front once
   the stop has settled: exactly once, never before the turn's result, with
   the rest still parked. Enter on an empty box with nothing parked does
   nothing, and the placeholder says which of the two Enter will do. Parked
   messages still drain one per turn, and the Send now button on the front row
   does what Enter does.

   The agent is answered from the main process over the Node inspector. A turn
   runs until the test ends it or an interrupt arrives, and an interrupt
   settles 400ms later with the result the SDK sends for a stopped turn. Runs
   on a throwaway HOME. Needs a built renderer: `npx vite build` first. */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9343;
const INSPECT = 9344;
const SETTLE_MS = 400;
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

function composer() {
  const box = document.querySelector('#agent-root [contenteditable="true"]');
  const rows = [...document.querySelectorAll('#agent-root .border-dashed')].filter((r) => r.querySelector('.font-mono'));
  const header = rows[0]?.parentElement?.previousElementSibling;
  return {
    placeholder: box?.dataset.placeholder || '',
    text: box?.textContent || '',
    note: header?.children[1]?.textContent || '',
    queued: rows.map((r) => r.querySelector('button[title="Edit this message"]')?.textContent.trim()),
    sendNow: rows.map((r) => !!r.querySelector('button[aria-label="Send now"]')),
    busy: !!document.querySelector('#agent-root button[type="submit"] .lucide-square'),
  };
}

async function main() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-queue-'));
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
      globalThis.__sent = [];
      globalThis.__interrupts = [];
      ipcMain.removeHandler('agent:send');
      ipcMain.handle('agent:send', (e, { chat, text }) => {
        globalThis.__sent.push({ text, at: Date.now() });
        globalThis.__end = (subtype) => {
          globalThis.__ended = Date.now();
          e.sender.send('agent:message', { chat, msg: { type: 'result', subtype, duration_ms: 10 } });
        };
        e.sender.send('agent:message', { chat, msg: { type: 'assistant', message: { content: [{ type: 'text', text: 'on it: ' + text }] } } });
        return { ok: true };
      });
      ipcMain.removeHandler('agent:interrupt');
      ipcMain.handle('agent:interrupt', () => {
        globalThis.__interrupts.push(Date.now());
        setTimeout(() => globalThis.__end('error_during_execution'), ${SETTLE_MS});
        return { ok: true };
      });
      return true;
    })()`);
    const sent = async () => (await main.run('globalThis.__sent')).map((s) => s.text);
    const interrupts = async () => (await main.run('globalThis.__interrupts')).length;
    const end = (subtype = 'success') => main.run(`globalThis.__end(${JSON.stringify(subtype)})`);

    const page = await connect(await target(PORT, (t) => t.type === 'page' && /index\.html/.test(t.url)));
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 950, deviceScaleFactor: 1, mobile: false });
    await page.evaluate(async () => {
      for (let i = 0; i < 60 && !window.connChat; i++) await new Promise((r) => setTimeout(r, 250));
      await new Promise((r) => setTimeout(r, 1000));
      [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Later')?.click();
    });

    const type = async (text) => {
      await page.evaluate(() => document.querySelector('#agent-root [contenteditable="true"]').focus());
      if (text) await page.send('Input.insertText', { text });
    };
    const enter = async () => {
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await sleep(200);
    };
    const state = () => page.evaluate(composer);

    await type('first task');
    await enter();
    const running = await until(page, () => document.querySelector('#agent-root button[type="submit"] .lucide-square') && true, null, 5000);
    check('turn-running', running === true && JSON.stringify(await sent()) === '["first task"]', JSON.stringify(await sent()));
    check('hint-with-empty-queue', (await state()).placeholder === 'Working. Enter adds this to the queue', (await state()).placeholder);

    await type('');
    await enter();
    await sleep(SETTLE_MS + 200);
    const idleEnter = await state();
    check('empty-box-empty-queue-does-nothing', (await interrupts()) === 0 && idleEnter.busy && JSON.stringify(await sent()) === '["first task"]',
      `interrupts ${await interrupts()}, busy ${idleEnter.busy}, sent ${JSON.stringify(await sent())}`);

    await type('second');
    await enter();
    await type('third');
    await enter();
    const parked = await state();
    check('non-empty-box-queues', JSON.stringify(parked.queued) === '["second","third"]' && (await interrupts()) === 0 && JSON.stringify(await sent()) === '["first task"]',
      `queued ${JSON.stringify(parked.queued)}, sent ${JSON.stringify(await sent())}`);
    check('hint-with-queue', parked.placeholder === 'Working. Enter sends the queued message now', parked.placeholder);
    check('queue-note-waiting', parked.note === 'sends after this turn', parked.note);
    check('send-now-on-front-row-only', JSON.stringify(parked.sendNow) === '[true,false]', JSON.stringify(parked.sendNow));

    await type('   ');
    await enter();
    const stopping = await state();
    check('whitespace-counts-as-empty', (await interrupts()) === 1, `${await interrupts()} interrupts`);
    check('waits-for-stop-to-settle', JSON.stringify(await sent()) === '["first task"]' && stopping.busy, `sent ${JSON.stringify(await sent())}`);
    check('hint-while-stopping', stopping.placeholder === 'Stopping. The queued message goes next' && stopping.note === 'stopping this turn to send it',
      `${stopping.placeholder} / ${stopping.note}`);
    await enter();
    check('second-enter-does-not-stop-again', (await interrupts()) === 1, `${await interrupts()} interrupts`);

    await until(page, (n) => document.querySelectorAll('#agent-root .border-dashed .font-mono').length === n || null, 1, SETTLE_MS + 3000);
    await sleep(600);
    const log = await main.run('globalThis.__sent');
    const settledAt = await main.run('globalThis.__ended');
    const afterStop = await state();
    check('front-message-sent-once', JSON.stringify(log.map((s) => s.text)) === '["first task","second"]', JSON.stringify(log.map((s) => s.text)));
    check('sent-after-the-result', log[1]?.at >= settledAt, `sent ${log[1]?.at}, result ${settledAt}`);
    check('rest-stays-queued', JSON.stringify(afterStop.queued) === '["third"]' && afterStop.busy && afterStop.note === 'sends after this turn',
      `${JSON.stringify(afterStop.queued)} busy ${afterStop.busy} ${afterStop.note}`);
    check('box-left-empty', afterStop.text.trim() === '', JSON.stringify(afterStop.text));

    await type('fourth');
    await enter();
    await end();
    await until(page, () => document.querySelectorAll('#agent-root .border-dashed .font-mono').length === 1 || null, null, 3000);
    await sleep(500);
    check('drains-one-per-turn', JSON.stringify(await sent()) === '["first task","second","third"]' && JSON.stringify((await state()).queued) === '["fourth"]',
      `sent ${JSON.stringify(await sent())}, queued ${JSON.stringify((await state()).queued)}`);

    await page.evaluate(() => document.querySelector('#agent-root button[aria-label="Send now"]').click());
    await until(page, () => !document.querySelector('#agent-root .border-dashed .font-mono') || null, null, SETTLE_MS + 3000);
    await sleep(500);
    check('send-now-button', (await interrupts()) === 2 && JSON.stringify(await sent()) === '["first task","second","third","fourth"]',
      `interrupts ${await interrupts()}, sent ${JSON.stringify(await sent())}`);

    await end();
    await until(page, () => !document.querySelector('#agent-root button[type="submit"] .lucide-square') || null, null, 3000);
    await type('');
    await enter();
    await sleep(SETTLE_MS + 200);
    check('idle-empty-enter-does-nothing', (await interrupts()) === 2 && (await sent()).length === 4 && !(await state()).busy,
      `interrupts ${await interrupts()}, sent ${(await sent()).length}`);

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
