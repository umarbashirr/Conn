'use strict';
/* Fenced code in a reply, in the real app. A bash fence is a wrapping block
   with Copy and Run. Run stays disabled while the fence streams, then opens a
   new terminal tab, types the line there and shows the pane, never into a
   terminal that is already open. A console fence gets Copy only. A ts fence
   keeps shiki, mermaid still draws, and a backticked URL is a link into the
   Browser pane.

   The agent is answered from the main process over the Node inspector, so no
   agent runs. Runs on a throwaway HOME. Needs a built renderer: `npx vite
   build` first. */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9501;
const INSPECT = 9502;
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
    } catch {}
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

async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(150);
  }
  return last;
}

const until = (page, fn, arg, ms) => waitFor(() => page.evaluate(fn, arg), ms);

async function click(page, p) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none', buttons: 0 });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(250);
}

function center(selector) {
  const el = document.querySelector(selector);
  if (!el) return null;
  el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + Math.min(r.width / 2, 20)), y: Math.round(r.top + r.height / 2) };
}

function browserShowing() {
  const url = document.querySelector('#url');
  return url?.offsetParent ? url.value : null;
}

const SHELL = '#agent-root [data-slot="shell-block"]';
const BASH = `${SHELL}[data-language="bash"]`;
const CONSOLE = `${SHELL}[data-language="console"]`;
const RUN = `${BASH} button[aria-label="Run in terminal"]`;

function runState(selector) {
  const b = document.querySelector(selector);
  return b && { text: b.textContent.trim(), disabled: b.disabled, check: !!b.querySelector('.lucide-check') };
}

function terminals() {
  const box = document.querySelector('#terms');
  const hosts = [...document.querySelectorAll('#terms .term-host')];
  return {
    shown: !!box && !box.hidden && !!box.offsetParent,
    hosts: hosts.length,
    activeIsNewest: hosts.length > 0 && hosts.at(-1).classList.contains('active') && hosts.filter((h) => h.classList.contains('active')).length === 1,
  };
}

const plain = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\r/g, '');

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'build', 'renderer', 'index.html'))) throw new Error('no renderer build: run `npx vite build` first');
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>Docs</title><h1>Docs</h1>'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const web = `http://127.0.0.1:${server.address().port}/docs`;
  const chunks = [
    'Try it:\n\n```bash\necho fences-ok',
    '\n```\n\nThen the types:\n\n',
    [
      '```ts\nconst ok: boolean = true;\n```',
      '```mermaid\ngraph TD; A-->B\n```',
      '```console\n$ echo fences-ok\nfences-ok\n```',
      `The docs are at \`${web}\` and the tests run with \`npm test\`.`,
    ].join('\n\n'),
  ];

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-fences-'));
  const home = path.join(base, 'home');
  const proj = path.join(base, 'shop');
  for (const d of [path.join(home, '.conn'), proj]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(home, '.conn', 'open-projects.json'), JSON.stringify([proj]));
  // An empty HOME sends zsh into its first-run menu, which would eat the line Run types.
  fs.writeFileSync(path.join(home, '.zshrc'), '');

  const electron = require(path.join(ROOT, 'node_modules', 'electron'));
  const app = spawn(electron, [
    `--inspect=${INSPECT}`, ROOT, `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(base, 'userdata')}`, '--no-sandbox',
  ], { env: { ...process.env, HOME: home, CONN_CWD: proj }, stdio: 'ignore' });

  try {
    const main = await connect(await target(INSPECT, (t) => t.type === 'node'));
    await main.run(`(() => {
      const req = process.getBuiltinModule('module').createRequire(${JSON.stringify(path.join(ROOT, 'src/main/index.js'))});
      const { ipcMain } = req('electron');
      globalThis.__typed = [];
      ipcMain.on('term:input', (_e, { id, data }) => globalThis.__typed.push({ id, data }));
      ipcMain.removeHandler('agent:send');
      ipcMain.handle('agent:send', (e, { chat }) => {
        const say = (event) => e.sender.send('agent:message', { chat, msg: { type: 'stream_event', event } });
        const left = ${JSON.stringify(chunks)};
        globalThis.__next = () => {
          say({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: left.shift() } });
          if (!left.length) say({ type: 'content_block_stop', index: 0 });
          return left.length;
        };
        setTimeout(() => {
          say({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
          globalThis.__next();
        }, 50);
        return { ok: true };
      });
      return true;
    })()`);

    const page = await connect(await target(PORT, (t) => t.type === 'page' && /index\.html/.test(t.url)));
    const watching = await waitFor(() => main.run(`(() => {
      const req = process.getBuiltinModule('module').createRequire(${JSON.stringify(path.join(ROOT, 'src/main/index.js'))});
      const { webContents } = req('electron');
      const wc = webContents.getAllWebContents().find((w) => /index\\.html/.test(w.getURL()));
      if (!wc) return false;
      globalThis.__wc = wc;
      globalThis.__out = {};
      const send = wc.send.bind(wc);
      wc.send = (channel, payload) => {
        if (channel === 'term:data') (globalThis.__out[payload.id] ||= []).push(payload.data);
        return send(channel, payload);
      };
      return true;
    })()`));
    if (!watching) throw new Error('no window to watch');
    const ptys = () => main.run('Object.keys(globalThis.__out)');
    const printed = (id) => main.run(`(globalThis.__out[${JSON.stringify(id)}] || []).join('')`);
    const command = (name, open) => main.run(`globalThis.__wc.send('app:command', ${JSON.stringify({ name, open })}), true`);

    await page.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 950, deviceScaleFactor: 1, mobile: false });
    await page.evaluate(async () => {
      for (let i = 0; i < 60 && !window.connChat; i++) await new Promise((r) => setTimeout(r, 250));
      await new Promise((r) => setTimeout(r, 1000));
      window.__copied = [];
      navigator.clipboard.writeText = async (t) => { window.__copied.push(t); };
    });

    await page.evaluate(() => document.querySelector('#agent-root [contenteditable="true"]').focus());
    await page.send('Input.insertText', { text: 'how do I check it works' });
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });

    const open = await until(page, (s) => !!document.querySelector(s) || null, BASH, 8000);
    check('bash-fence-is-a-shell-block', open === true, `no ${BASH}: ${await page.evaluate(() => document.querySelector('#agent-root .conn-streaming')?.innerHTML.slice(0, 300))}`);
    check('run-disabled-while-fence-streams', (await page.evaluate(runState, RUN))?.disabled === true, JSON.stringify(await page.evaluate(runState, RUN)));

    await main.run('globalThis.__next()');
    const closed = await until(page, (s) => document.querySelector(s)?.disabled === false || null, RUN, 3000);
    check('run-enabled-once-fence-closes', closed === true, JSON.stringify(await page.evaluate(runState, RUN)));
    await page.evaluate((s) => { const el = document.querySelector(s); if (el) el.__seen = true; }, BASH);

    await main.run('globalThis.__next()');
    await until(page, () => !document.querySelector('#agent-root .conn-streaming') && !!document.querySelector('#agent-root code[data-streamdown="inline-code"]') || null, null, 5000);
    check('shell-block-survives-later-chunks', await page.evaluate((s) => document.querySelector(s)?.__seen === true, BASH), 'the shell block was remounted while the reply streamed');

    const bash = await page.evaluate((s) => {
      const el = document.querySelector(s);
      const pre = el?.querySelector('pre');
      return el && {
        copy: !!el.querySelector('button[aria-label="Copy"]'),
        run: !!el.querySelector('button[aria-label="Run in terminal"]'),
        text: pre?.textContent,
        wrap: pre && getComputedStyle(pre).whiteSpace,
      };
    }, BASH);
    check('bash-block-has-copy-and-run', bash?.copy && bash?.run, JSON.stringify(bash));
    check('shell-block-wraps', bash?.wrap === 'pre-wrap', JSON.stringify(bash));
    check('shell-block-drops-trailing-newline', bash?.text === 'echo fences-ok', JSON.stringify(bash?.text));

    const consoleBlock = await page.evaluate((s) => {
      const el = document.querySelector(s);
      return el && { copy: !!el.querySelector('button[aria-label="Copy"]'), run: !!el.querySelector('button[aria-label="Run in terminal"]') };
    }, CONSOLE);
    check('console-fence-is-a-shell-block-without-run', consoleBlock?.copy === true && consoleBlock.run === false, JSON.stringify(consoleBlock));

    const colours = () => {
      const el = document.querySelector('#agent-root [data-streamdown="code-block"][data-language="ts"]');
      const set = new Set([...el?.querySelectorAll('pre code span') || []].map((sp) => sp.style.getPropertyValue('--sdm-c')).filter(Boolean));
      return set.size > 1 ? [...set] : null;
    };
    const highlighted = await until(page, colours, null, 5000);
    const ts = await page.evaluate((s) => ({
      block: !!document.querySelector('#agent-root [data-streamdown="code-block"][data-language="ts"]'),
      shellBlocks: [...document.querySelectorAll(s)].map((b) => b.dataset.language),
    }), SHELL);
    check('ts-fence-keeps-shiki', ts.block && !!highlighted, JSON.stringify({ ...ts, highlighted }));
    check('only-shell-fences-are-shell-blocks', JSON.stringify(ts.shellBlocks) === '["bash","console"]', JSON.stringify(ts.shellBlocks));

    const drawn = await until(page, () => !!document.querySelector('#agent-root [data-streamdown="mermaid"] svg g') || null, null, 15000);
    check('mermaid-fence-draws', drawn === true, await page.evaluate(() => document.querySelector('#agent-root [data-streamdown="mermaid-block"]')?.outerHTML.slice(0, 200) || 'no mermaid block'));

    const word = await page.evaluate(() => {
      const el = [...document.querySelectorAll('#agent-root code')].find((c) => c.textContent === 'npm test');
      return el && { slot: el.dataset.streamdown, cls: el.className };
    });
    check('plain-inline-code-unchanged', word?.slot === 'inline-code' && word.cls === 'rounded bg-muted px-1.5 py-0.5 font-mono text-sm', JSON.stringify(word));

    const urlLink = `#agent-root a[href="${web}"]`;
    const link = await page.evaluate((s) => {
      const a = document.querySelector(s);
      if (!a) return null;
      const st = getComputedStyle(a);
      return { text: a.textContent, mono: /mono/i.test(st.fontFamily), bg: st.backgroundColor };
    }, urlLink);
    check('backticked-url-is-a-link-in-code-styling', link?.text === web && link.mono && link.bg !== 'rgba(0, 0, 0, 0)', JSON.stringify(link));

    check('nothing-open-at-start', (await page.evaluate(browserShowing)) === null, 'browser already open');
    if (link) await click(page, await page.evaluate(center, urlLink));
    const opened = await until(page, browserShowing, null, 5000);
    check('backticked-url-opens-browser-pane', opened === web, `url ${opened}`);
    check('no-dialog', await page.evaluate(() => !document.querySelector('[role="dialog"], [role="alertdialog"]')), 'a dialog is in the DOM');

    await command('newTerminal');
    const first = await until(page, () => document.querySelectorAll('#terms .term-host').length === 1 || null, null, 5000);
    const prompt = await waitFor(async () => (await ptys()).length === 1 || null, 10000);
    await command('terminal', false);
    await until(page, () => document.querySelector('#terms')?.hidden || null, null, 3000);
    const before = await page.evaluate(terminals);
    const existing = await ptys();
    check('one-terminal-open-and-hidden-before-run', first === true && prompt === true && before.hosts === 1 && !before.shown, JSON.stringify({ before, existing }));

    const typedBefore = (await main.run('globalThis.__typed')).length;
    const run = await page.evaluate(center, RUN);
    if (run) await click(page, run);
    const sent = await page.evaluate(runState, RUN);
    check('run-reads-sent', sent?.text === 'Sent' && sent.check, JSON.stringify(sent));

    await waitFor(async () => {
      const t = await page.evaluate(terminals);
      return t.hosts === 2 && t.shown && t.activeIsNewest;
    });
    const shown = await page.evaluate(terminals);
    check('run-opens-a-new-terminal-tab', shown.hosts === 2, JSON.stringify(shown));
    check('run-shows-the-new-terminal', shown.shown && shown.activeIsNewest, JSON.stringify(shown));

    const typed = await waitFor(async () => {
      const lines = (await main.run('globalThis.__typed')).slice(typedBefore).filter((t) => t.data.includes('fences-ok'));
      return lines.length ? lines : null;
    }, 10000);
    check('run-types-the-line-into-the-new-shell', typed?.length === 1 && typed[0].data === 'echo fences-ok\n' && !existing.includes(typed[0].id), JSON.stringify({ typed, existing }));
    check('run-leaves-the-open-terminal-alone', (await main.run('globalThis.__typed')).slice(typedBefore).every((t) => !existing.includes(t.id)), JSON.stringify(await main.run('globalThis.__typed')));
    const ran = typed?.[0] && await waitFor(async () => /\nfences-ok\n/.test(plain(await printed(typed[0].id))) || null, 10000);
    check('new-shell-runs-the-line', ran === true, JSON.stringify(typed?.[0] && plain(await printed(typed[0].id)).slice(-300)));

    await sleep(1700);
    const reverted = await page.evaluate(runState, RUN);
    check('run-reverts', reverted?.text === 'Run' && !reverted.check, JSON.stringify(reverted));

    page.ws.close();
    main.ws.close();
  } finally {
    const exited = new Promise((r) => app.once('exit', r));
    app.kill();
    const stuck = setTimeout(() => app.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(stuck);
    server.close();
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
  }

  console.log(failures.length ? `\n${failures.length} failed` : '\nall passed');
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
