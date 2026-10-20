'use strict';
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = process.env.CONN_ROOT || path.join(__dirname, '..');
const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
};

const SHOT = (name) => path.join(os.tmpdir(), `conn-notify-${name}.png`);
const TITLE = 'Fix the coupon bug';
const result = (ms) => ({ type: 'result', subtype: 'success', is_error: false, duration_ms: ms });

async function main() {
  const drive = await import(pathToFileURL(path.join(ROOT, '.claude/skills/verify/drive.mjs')).href);
  const { boot, stop, evaluate, click, say, perm, shot } = drive;
  const s = await boot({ root: ROOT, xvfb: true });

  try {
    const inMain = (expr, opts) => evaluate(s, expr, { main: true, ...opts });
    const emit = (msg) => inMain(`globalThis.__agent.emit('message', ${J(msg)})`);
    const focused = (on) => inMain(`(globalThis.__win.isFocused = () => ${on}, true)`);
    const shown = (from) => inMain(`globalThis.__shown.slice(${from}).map((n) => ({ title: n.title, body: n.body }))`);
    const shownCount = () => inMain('globalThis.__shown.length');
    const flashes = (from) => inMain(`globalThis.__flash.slice(${from})`);
    const flashCount = () => inMain('globalThis.__flash.length');
    const activeChat = () => evaluate(s, `document.querySelector('[data-sidebar=menu-button][data-active=true]')?.title || null`);
    const until = async (fn, ms = 3000) => {
      const end = Date.now() + ms;
      let got;
      while (Date.now() < end && !(got = await fn())) await sleep(100);
      return got;
    };
    const quiet = () => sleep(800);

    await click(s, 'Later').catch(() => {});
    await say(s, 'On it.', { prompt: TITLE, open: true });
    await evaluate(s, `(window.__perms = [], window.conn.agent.onPermission((p) => window.__perms.push(p)), true)`);
    await inMain(`(() => {
      const N = electron.Notification;
      N.isSupported = () => true;
      globalThis.__shown = [];
      N.prototype.show = function show() { globalThis.__shown.push(this); };
      const win = electron.BrowserWindow.getAllWindows().find((w) => /index\\.html/.test(w.webContents.getURL())) || electron.BrowserWindow.getAllWindows()[0];
      globalThis.__win = win;
      globalThis.__flash = [];
      const flashFrame = win.flashFrame.bind(win);
      win.flashFrame = (on) => { globalThis.__flash.push(on); return flashFrame(on); };
      globalThis.__raised = 0;
      const show = win.show.bind(win);
      win.show = () => { globalThis.__raised += 1; return show(); };
      win.isFocused = () => false;
      return true;
    })()`);

    let n0 = await shownCount();
    let f0 = await flashCount();
    await emit(result(10000));
    await until(async () => (await shownCount()) > n0);
    await quiet();
    let got = await shown(n0);
    await shot(s, SHOT('long-turn'));
    check('long-turn-notifies-with-the-chat-title', got.length === 1 && got[0].title === TITLE, J(got));
    check('long-turn-flashes-the-frame', (await flashes(f0)).includes(true), J(await flashes(f0)));

    n0 = await shownCount();
    await perm(s, { tool: 'Bash' });
    await until(async () => (await shownCount()) > n0);
    await quiet();
    got = await shown(n0);
    await shot(s, SHOT('permission'));
    check('permission-notifies-naming-the-tool', got.length === 1 && /Bash/.test(got[0].body), J(got));

    const chat = await evaluate(s, 'window.__perms.at(-1)?.chat');
    const info = await evaluate(s, 'window.conn.bridgeInfo()', { awaitPromise: true });
    const abort = new AbortController();
    n0 = await shownCount();
    const called = fetch(`${info.url}/tool/click`, {
      method: 'POST',
      headers: { 'x-conn-token': info.token, 'x-conn-chat': encodeURIComponent(chat) },
      body: J({ target: 'e1' }),
      signal: abort.signal,
    }).catch(() => null);
    await until(async () => (await shownCount()) > n0);
    await quiet();
    got = await shown(n0);
    await shot(s, SHOT('bridge-permission'));
    check('browser-pane-permission-notifies-naming-the-tool', got.length === 1 && /browser_click/.test(got[0].body), J(got));
    abort.abort();
    await called;

    n0 = await shownCount();
    f0 = await flashCount();
    await focused(true);
    await emit(result(10000));
    await quiet();
    check('focused-window-is-not-notified', (await shown(n0)).length === 0, J(await shown(n0)));
    check('focused-window-does-not-flash', !(await flashes(f0)).includes(true), J(await flashes(f0)));
    await focused(false);

    n0 = await shownCount();
    await emit(result(2000));
    await quiet();
    check('short-turn-is-not-notified', (await shown(n0)).length === 0, J(await shown(n0)));

    await evaluate(s, `window.conn.settings.set({ notifications: { enabled: false } })`, { awaitPromise: true });
    n0 = await shownCount();
    f0 = await flashCount();
    await emit(result(10000));
    await perm(s, { tool: 'Bash' });
    await quiet();
    check('setting-off-silences-turns-and-permissions', (await shown(n0)).length === 0, J(await shown(n0)));
    check('setting-off-does-not-flash', !(await flashes(f0)).includes(true), J(await flashes(f0)));
    await evaluate(s, `window.conn.settings.set({ notifications: { enabled: true } })`, { awaitPromise: true });

    await click(s, 'css=[title="New chat in shop"]');
    const other = await until(async () => {
      const t = await activeChat();
      return t !== TITLE ? { t } : null;
    });
    check('another-chat-is-open-before-the-click', !!other, `active chat is ${await activeChat()}`);
    const r0 = await inMain('globalThis.__raised');
    await inMain(`(() => { globalThis.__shown[0]?.emit('click'); return true; })()`);
    const back = await until(async () => (await activeChat()) === TITLE);
    await shot(s, SHOT('click-opens'));
    check('click-opens-that-chat', !!back, `active chat is ${await activeChat()}`);
    check('click-shows-the-window', (await inMain('globalThis.__raised')) > r0, 'win.show was not called');

    f0 = await flashCount();
    await inMain(`globalThis.__win.emit('focus')`);
    await quiet();
    check('focus-stops-the-flash', (await flashes(f0)).includes(false), J(await flashes(f0)));
    await shot(s, SHOT('end'));
  } finally {
    await stop(s);
  }

  if (failures.length) {
    console.log(`\n${failures.length} failure(s)`);
    process.exit(1);
  }
  console.log('\nall passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
