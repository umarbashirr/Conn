'use strict';
/* New chat starts in the folder you are in (CUX-19). The rail button, the
   palette command and the menu command all go straight to an empty composer
   in the folder the chat on screen runs in, not in whichever folder the window
   is focused on. A window with no folder opens the folder picker instead, and
   words typed into the picker that name no folder start a chat with them.
   Needs a built renderer: `npx vite build` first. */
const fs = require('fs');
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

async function main() {
  const drive = await import(pathToFileURL(path.join(ROOT, '.claude/skills/verify/drive.mjs')).href);
  const { boot, stop, evaluate, click, key, type } = drive;
  const s = await boot({ root: ROOT, xvfb: true });
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-new-chat-other-'));

  try {
    const until = async (fn, ms = 4000) => {
      const end = Date.now() + ms;
      let got;
      while (Date.now() < end && !(got = await fn())) await sleep(100);
      return got;
    };
    const inMain = (expr) => evaluate(s, expr, { main: true });
    const BOX = `document.querySelector('#agent-root [contenteditable="true"]')`;
    const dialog = () => evaluate(s, `!!document.querySelector('[role="dialog"]')`);
    const boxFocused = () => evaluate(s, `document.activeElement === ${BOX}`);
    const startedIn = async () => (await inMain('globalThis.__starts')).map((d) => d.cwd);

    await click(s, 'Later').catch(() => {});
    await inMain(`(() => {
      const { AgentSession } = req('./agent');
      globalThis.__starts = [];
      const start = AgentSession.prototype.start;
      AgentSession.prototype.start = function recordStart() { globalThis.__starts.push({ cwd: this.cwd }); return start.call(this); };
    })()`);

    await click(s, 'New chat');
    await sleep(500);
    check('new-chat-opens-no-picker-with-a-folder-open', !(await dialog()), 'a dialog is open');
    check('new-chat-leaves-the-composer-focused', !!(await until(boxFocused)), 'focus is elsewhere');

    await type(s, 'first prompt', { enter: true });
    const first = await until(async () => (await startedIn()).length === 1 && (await startedIn()));
    check('typing-and-enter-starts-a-chat-in-shop', !!first && first[0] === path.resolve(s.project), J(await startedIn()));

    await evaluate(s, `window.conn.project.open({ dir: ${J(other)} }).then(() => true)`, { awaitPromise: true });
    await until(() => evaluate(s, `!!document.querySelector('button[aria-label="New chat in ${path.basename(other)}"]')`));
    await evaluate(s, `document.querySelector('button[aria-label="New chat in ${path.basename(other)}"]').click()`);
    await type(s, 'second prompt', { enter: true });
    await until(async () => (await startedIn()).length === 2);
    await evaluate(s, `window.conn.project.focus(${J(s.project)}).then(() => true)`, { awaitPromise: true });
    const focused = await evaluate(s, `window.conn.project.info().then((i) => i.focused)`, { awaitPromise: true });
    check('window-is-focused-on-shop-while-the-chat-runs-in-the-other-folder', focused === path.resolve(s.project), J(focused));

    await click(s, 'New chat');
    await type(s, 'third prompt', { enter: true });
    const third = await until(async () => (await startedIn()).length === 3 && (await startedIn()));
    check('new-chat-follows-the-chat-on-screen-not-the-focused-folder', !!third && third[2] === path.resolve(other), J(await startedIn()));

    await key(s, 'Ctrl+K');
    await type(s, 'New chat');
    await sleep(300);
    await key(s, 'Enter');
    await sleep(500);
    check('palette-new-chat-opens-no-picker', !(await dialog()), 'a dialog is open');
    check('palette-new-chat-leaves-the-composer-focused', !!(await until(boxFocused)), 'focus is elsewhere');
    await type(s, 'fourth prompt', { enter: true });
    const fourth = await until(async () => (await startedIn()).length === 4 && (await startedIn()));
    check('palette-new-chat-starts-in-the-chat-on-screen-folder', !!fourth && fourth[3] === path.resolve(other), J(await startedIn()));

    await click(s, 'New chat in…');
    check('new-chat-in-opens-the-folder-picker', !!(await until(dialog)), 'no dialog');
    await type(s, 'zzqq no such folder');
    const offer = await until(() => evaluate(s, `[...document.querySelectorAll('[cmdk-item]')].filter((e) => e.getBoundingClientRect().height > 0).map((e) => e.textContent).find((t) => t.startsWith('Start a chat with'))`));
    check('picker-shows-an-offer-to-chat-with-text-matching-no-folder', !!offer && offer.includes('zzqq no such folder'), J(offer));
    await key(s, 'Enter');
    const fifth = await until(async () => (await startedIn()).length === 5 && (await startedIn()));
    check('picking-the-offer-starts-a-chat-in-the-current-folder', !!fifth && fifth[4] === path.resolve(other), J(await startedIn()));
    const said = await until(() => evaluate(s, `document.querySelector('#agent-root').innerText.includes('zzqq no such folder')`));
    check('picking-the-offer-sends-the-text', !!said, 'the text is not in the chat');
  } finally {
    fs.rmSync(other, { recursive: true, force: true });
    await stop(s);
  }

  if (failures.length) {
    console.log(`\n${failures.length} failed: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('\nall passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
