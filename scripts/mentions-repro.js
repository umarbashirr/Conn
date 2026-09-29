'use strict';
/* $browser and $canvas, which tell whatever agent is running that the browser
   or canvas in question is Conn's and not its own.

   First the text itself, for every provider: the renderer modules are bundled
   and asked for each block, and every tool name in it is checked against the
   server Conn actually hands that provider, read out of the main process
   source. Then the real app: a hand typed $canvas or $browser brings its tab on
   screen when sent, $ opens the picker, a pick leaves a badge, $5 and $HOME
   stay text, and the message that goes out carries each block once however
   often it is named.

   The agent is answered from the main process over the Node inspector, so no
   agent runs. Runs on a throwaway HOME. Needs a built renderer: `npx vite
   build` first. */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9337;
const INSPECT = 9338;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
};

const source = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

async function renderer(dir) {
  const { rolldown } = await import('rolldown');
  const entry = path.join(dir, 'entry.js');
  const ui = path.join(ROOT, 'src/renderer/ui/lib');
  fs.writeFileSync(entry, `export * from ${JSON.stringify(path.join(ui, 'tokens.js'))};\nexport * from ${JSON.stringify(path.join(ui, 'conn-mentions.js'))};\n`);
  const bundle = await rolldown({ input: entry, platform: 'node', logLevel: 'silent' });
  const file = path.join(dir, 'mentions.cjs');
  await bundle.write({ file, format: 'cjs' });
  return require(file);
}

async function blocks(dir) {
  const m = await renderer(dir);
  const { PROVIDER_IDS } = require(path.join(ROOT, 'src/main/providers/index.js'));
  const { browserTools } = require(path.join(ROOT, 'src/shared/browser-tools.js'));
  const real = new Set(browserTools(require(path.join(ROOT, 'node_modules/zod'))).map((t) => t.name));

  const claudeServer = /createSdkMcpServer\(\{ name: '(\w+)'/.exec(source('src/main/agent.js'))?.[1];
  const codexServer = /name: '(\w+)'/.exec(source('src/main/codex-driver.js'))?.[1];
  const acpServer = /name: '(\w+)'/.exec(source('src/main/providers/acp-session.js'))?.[1];
  const expected = (p) => {
    if (p === 'claude') return `mcp__${claudeServer}__`;
    if (p === 'codex') return `mcp__${codexServer}__`;
    return '';
  };

  const slot = { x: 1990, y: 0 };
  for (const provider of PROVIDER_IDS) {
    const [browser] = m.mentionBlocks(new Set(['browser']), '', { provider, slot });
    const want = expected(provider);
    const named = browser.match(/\b[\w]*browser_[a-z]+\b/g) || [];
    check(`${provider}-block-uses-its-tool-names`, named.length >= 9 && named.every((n) => n.startsWith(`${want}browser_`) && real.has(n.slice(want.length))), named.join(' '));
    if (!want) check(`${provider}-block-names-the-conn-server`, browser.includes(`${acpServer} MCP server`), browser);
  }

  const [browser, canvas] = m.mentionBlocks(new Set(['browser', 'canvas']), '', { provider: 'claude', slot });
  console.log(`\n--- $browser, claude\n${browser}\n--- $browser, cursor/grok/opencode\n${m.mentionBlocks(new Set(['browser']), '', { provider: 'cursor', slot })[0]}\n--- $browser, codex\n${m.mentionBlocks(new Set(['browser']), '', { provider: 'codex', slot })[0]}\n--- $canvas\n${canvas}\n`);
  check('browser-block-disowns-other-browsers', /Claude in Chrome/.test(browser) && /Playwright/.test(browser) && /computer use/.test(browser) && /Browser pane in Conn/.test(browser), browser);
  check('canvas-block-disowns-other-canvases', /Cursor Canvas/.test(canvas) && /Claude artifact/.test(canvas) && canvas.includes('.conn/canvas/'), canvas.slice(0, 300));
  check('blocks-in-table-order', m.mentionBlocks(new Set(['canvas', 'browser']), '', { provider: 'claude', slot })[0] === browser, 'canvas came first');
  check('block-already-in-text-not-added', m.mentionBlocks(new Set(['browser']), `${browser}\n\nhi`, { provider: 'claude', slot }).length === 0, 'added twice');

  const sent = `${browser}\n\n${canvas}\n\n$browser open it and draw on $canvas`;
  const nodes = m.parse(sent);
  const context = nodes.filter((n) => n.kind === 'context');
  const prose = nodes.filter((n) => n.type === 'text').map((n) => n.text).join('');
  check('sent-blocks-parse-whole', context.length === 2 && !/Conn|conn/.test(prose), JSON.stringify(nodes.map((n) => n.kind || n.text)));
  check('sent-round-trips', m.serialize(nodes) === sent, 'serialize changed the text');
  check('sent-mentions-still-badges', nodes.filter((n) => n.kind === 'conn').map((n) => n.raw).join() === '$browser,$canvas', JSON.stringify(nodes));

  const typed = (s) => m.parse(s).filter((n) => n.kind === 'conn').map((n) => n.raw).join();
  check('hand-typed-recognized', typed('use $browser, then ($canvas).') === '$browser,$canvas', typed('use $browser, then ($canvas).'));
  const loose = ['costs $5', 'cd $HOME', 'echo ${canvas}', 'a$browser', '$browserUrl', '$canvas-2', '`$canvas`', '$Browser'];
  check('no-false-positives', loose.every((s) => typed(s) === ''), loose.filter((s) => typed(s)).join(' | '));
  check('picker-opens-on-dollar', m.pendingToken('hi $', false, false)?.kind === 'conn' && m.pendingToken('hi $ca', false, false)?.query === 'ca', JSON.stringify(m.pendingToken('hi $', false, false)));
  check('picker-quiet-on-dollar-digit', !m.pendingToken('costs $5', false, false) && !m.pendingToken('cd $HOME', false, false) && !m.pendingToken('a$b', false, false), 'opened');
  check('picker-rows-filter', m.mentionRows('').map((r) => r.raw).join() === '$browser,$canvas' && m.mentionRows('c').map((r) => r.raw).join() === '$canvas', JSON.stringify(m.mentionRows('')));
}

// ------------------------------------------------------------------ the app

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

const key = async (page, k, code, vk) => {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
  await sleep(150);
};
async function until(page, fn, ms = 4000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await page.evaluate(fn);
    if (last) return last;
    await sleep(150);
  }
  return last;
}
const type = async (page, text) => { await page.send('Input.insertText', { text }); await sleep(150); };

const box = () => {
  const el = document.querySelector('#agent-root [contenteditable="true"]');
  return {
    badges: [...el.querySelectorAll('.tok-conn')].map((b) => b.dataset.raw),
    menu: [...document.querySelectorAll('#composer-mentions [role="option"]')].map((o) => o.textContent),
  };
};

async function app(base) {
  const home = path.join(base, 'home');
  const proj = path.join(base, 'shop');
  for (const d of [path.join(home, '.conn'), proj]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(home, '.conn', 'open-projects.json'), JSON.stringify([proj]));

  const electron = require(path.join(ROOT, 'node_modules', 'electron'));
  const child = spawn(electron, [
    `--inspect=${INSPECT}`, ROOT, `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(base, 'userdata')}`, '--no-sandbox',
  ], { env: { ...process.env, HOME: home, CONN_CWD: proj }, stdio: 'ignore' });

  try {
    const main = await connect(await target(INSPECT, (t) => t.type === 'node'));
    await main.run(`(() => {
      const req = process.getBuiltinModule('module').createRequire(${JSON.stringify(path.join(ROOT, 'src/main/index.js'))});
      const { ipcMain } = req('electron');
      ipcMain.removeHandler('agent:send');
      ipcMain.handle('agent:send', (_e, a) => { globalThis.__sent = a.text; return { error: 'captured by the mentions repro' }; });
      return true;
    })()`);

    const page = await connect(await target(PORT, (t) => t.type === 'page' && /index\.html/.test(t.url)));
    await page.evaluate(async () => {
      for (let i = 0; i < 60 && !window.connChat; i++) await new Promise((r) => setTimeout(r, 250));
      await new Promise((r) => setTimeout(r, 1000));
    });
    const read = () => page.run(`(${box})()`);
    const sendTyped = async (text) => {
      await main.run('globalThis.__sent = null');
      await page.evaluate(() => document.querySelector('#agent-root [contenteditable="true"]').focus());
      await type(page, text);
      await key(page, 'Enter', 'Enter', 13);
      for (let i = 0; i < 40; i++) {
        const t = await main.run('globalThis.__sent || null');
        if (t) return t;
        await sleep(150);
      }
      return '';
    };
    const showing = () => until(page, () => {
      const active = document.querySelector('section#right [role="tab"][data-state="active"]');
      if (!active || !document.querySelector('section#right')?.offsetParent) return null;
      if (active.title === 'Canvas') return 'canvas';
      if (document.querySelector('#url')?.offsetParent) return 'browser';
      return `other: ${active.title}`;
    }, 3000);

    check('app-nothing-open-at-start', (await showing()) === null, await showing());
    // Ending on the mention would leave the picker up, and Enter would pick instead of send.
    const one = await sendTyped('sketch a login screen on $canvas please');
    check('app-typed-canvas-opens-canvas', one.endsWith('\n\nsketch a login screen on $canvas please') && (await showing()) === 'canvas', `${await showing()} after ${JSON.stringify(one.slice(-60))}`);
    const two = await sendTyped('now check $browser for errors');
    check('app-typed-browser-opens-browser', two.endsWith('\n\nnow check $browser for errors') && (await showing()) === 'browser', `${await showing()} after ${JSON.stringify(two.slice(-60))}`);
    const three = await sendTyped('what does $5 buy in $HOME');
    check('app-no-mention-leaves-pane-alone', three === 'what does $5 buy in $HOME' && (await showing()) === 'browser', `${await showing()} after ${JSON.stringify(three)}`);
    await main.run('globalThis.__sent = null');

    await page.evaluate(() => document.querySelector('#agent-root [contenteditable="true"]').focus());
    await type(page, 'open ');
    await type(page, '$');
    let s = await read();
    check('app-dollar-opens-picker', s.menu.length === 2 && s.menu[0].startsWith('$browser') && s.menu[1].startsWith('$canvas'), JSON.stringify(s.menu));
    await type(page, 'b');
    s = await read();
    check('app-picker-filters', s.menu.length === 1 && s.menu[0].startsWith('$browser'), JSON.stringify(s.menu));
    await key(page, 'Enter', 'Enter', 13);
    s = await read();
    check('app-pick-inserts-badge', s.badges.join() === '$browser' && !s.menu.length, JSON.stringify(s));

    // Typed by hand it stays text until the message is drawn, like a typed @path.
    await type(page, 'and draw it on $canvas ');
    s = await read();
    check('app-hand-typed-closes-picker', !s.menu.length, JSON.stringify(s));

    await type(page, 'for $5 from $');
    s = await read();
    const stillOpen = s.menu.length;
    await type(page, 'HOME, then $browser again');
    s = await read();
    check('app-dollar-caps-closes-picker', stillOpen === 2 && !s.menu.length, `menu ${stillOpen} then ${JSON.stringify(s.menu)}`);

    await key(page, 'Enter', 'Enter', 13);
    let sent = '';
    for (let i = 0; i < 40 && !sent; i++) { sent = (await main.run('globalThis.__sent || null')) || ''; await sleep(150); }
    const count = (head) => sent.split(head).length - 1;
    check('app-sent-browser-block-once', count('[conn browser] $browser') === 1, sent.slice(0, 300));
    check('app-sent-canvas-block-once', count('[conn canvas] $canvas') === 1, sent.slice(0, 300));
    // A fresh chat is a Claude chat.
    check('app-sent-uses-claude-tool-names', sent.includes('mcp__preview__browser_navigate') && !sent.includes('mcp__conn__'), sent.slice(0, 600));
    check('app-sent-ends-with-what-was-typed', sent.endsWith('\n\nopen $browser and draw it on $canvas for $5 from $HOME, then $browser again'), sent.slice(-120));

    const shown = await until(page, () => {
      const msg = [...document.querySelectorAll('#agent-root .tok-conn')].filter((b) => !b.closest('[contenteditable]')).slice(-3);
      return msg.length === 3 ? { badges: msg.map((b) => b.textContent), text: msg[0].parentElement.closest('div').textContent } : null;
    });
    check('app-transcript-shows-badges-not-blocks', shown && shown.badges.join() === 'Browser,Canvas,Browser' && !shown.text.includes('Browser pane in Conn'), JSON.stringify(shown));

    page.ws.close();
    main.ws.close();
  } finally {
    const exited = new Promise((r) => child.once('exit', r));
    child.kill();
    const stuck = setTimeout(() => child.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(stuck);
  }
}

async function main() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-mentions-'));
  try {
    await blocks(base);
    if (!process.env.CONN_NO_APP) await app(base);
  } finally {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
  }
  console.log(failures.length ? `\n${failures.length} failed` : '\nall passed');
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
