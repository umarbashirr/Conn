'use strict';
/* A half-typed message survives a reload (CUX-09). The window is reloaded from
   the main process, because the page's own location.reload() is cancelled by
   the window's will-navigate handler. Needs a built renderer: `npx vite build`
   first. */
const fs = require('fs');
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

const ONE = { id: '11111111-1111-4111-8111-111111111111', title: 'chat one' };
const TWO = { id: '22222222-2222-4222-8222-222222222222', title: 'chat two' };
const SENT = '33333333-3333-4333-8333-333333333333';
const BIG = 'abcdefghij'.repeat(1000);

function seed(s) {
  const dir = path.join(s.home, '.claude', 'projects', s.project.replace(/[/.]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  for (const { id, title } of [ONE, TWO]) {
    const at = new Date().toISOString();
    const lines = [
      { type: 'user', sessionId: id, cwd: s.project, timestamp: at, uuid: `${id}-u`, message: { role: 'user', content: title } },
      { type: 'assistant', sessionId: id, cwd: s.project, timestamp: at, uuid: `${id}-a`, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
    ];
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), `${lines.map((l) => J(l)).join('\n')}\n`);
  }
}

async function main() {
  const drive = await import(pathToFileURL(path.join(ROOT, '.claude/skills/verify/drive.mjs')).href);
  const { boot, stop, evaluate, click, hover, key, type, shot } = drive;
  const s = await boot({ root: ROOT, xvfb: true });

  try {
    const inMain = (expr, awaitPromise = false) => evaluate(s, expr, { main: true, awaitPromise });
    const until = async (fn, ms = 6000) => {
      const end = Date.now() + ms;
      let got;
      while (Date.now() < end && !(got = await fn())) await sleep(100);
      return got;
    };
    const WC = `electron.BrowserWindow.getAllWindows().find((w) => /index\\.html/.test(w.webContents.getURL())).webContents`;
    const BOX = `document.querySelector('#agent-root [contenteditable="true"]')`;
    const boxText = () => evaluate(s, `${BOX}.textContent`);
    const focusBox = () => evaluate(s, `${BOX}.focus()`);
    const stored = () => evaluate(s, `JSON.parse(localStorage.getItem('conn.drafts') || '{}')`);
    const railHas = (title) => evaluate(s, `document.body.innerText.includes(${J(title)})`);
    const openChat = async ({ title }) => {
      await click(s, title);
      await sleep(600);
    };
    const clearBox = async () => {
      await focusBox();
      await key(s, 'Ctrl+A');
      await key(s, 'Backspace');
    };
    const reloaded = async () => {
      await until(async () => !!(await evaluate(s, `!!window.connChat`)) && (await railHas(ONE.title)), 15000);
      await sleep(300);
    };
    const reload = async () => {
      await evaluate(s, `window.__beforeReload = true`);
      await inMain(`${WC}.reload()`);
      await until(async () => !(await evaluate(s, `window.__beforeReload === true`).catch(() => true)), 15000);
      await reloaded();
    };
    const typeThenReload = async (text, ms) => {
      await evaluate(s, `window.__beforeReload = true`);
      await inMain(`(() => { const wc = ${WC}; wc.insertText(${J(text)}); setTimeout(() => wc.reload(), ${ms}); return true; })()`);
    };

    seed(s);
    await click(s, 'Later').catch(() => {});
    await inMain(`(() => {
      const { AgentSession } = req('./agent');
      AgentSession.prototype.start = async function start() {
        globalThis.__agent = this;
        this.sessionId = ${J(SENT)};
        const ready = () => this.emit('ready', { sessionId: this.sessionId });
        if (globalThis.__holdReady) globalThis.__release = ready;
        else setTimeout(ready, 0);
      };
      return true;
    })()`);
    await evaluate(s, `window.connRail.refresh()`);
    await until(() => railHas(TWO.title));
    await sleep(300);

    await focusBox();
    await type(s, 'unsent draft');
    check('typing-shows-in-the-box', (await boxText()) === 'unsent draft', J(await boxText()));

    await openChat(ONE);
    check('opening-another-chat-shows-its-own-empty-box', (await boxText()) === '', J(await boxText()));
    await focusBox();
    await type(s, 'draft one');
    await openChat(TWO);
    check('a-chat-opened-after-a-draft-starts-empty', (await boxText()) === '', J(await boxText()));
    await focusBox();
    await type(s, 'draft two');
    await openChat(ONE);
    const backOne = await boxText();
    await openChat(TWO);
    const backTwo = await boxText();
    await shot(s, '/tmp/conn-drafts-switch.png');
    check('switching-chats-keeps-each-draft-with-its-chat', backOne === 'draft one' && backTwo === 'draft two', J([backOne, backTwo]));

    await sleep(700);
    await evaluate(s, `window.connChat.newChat()`);
    await sleep(300);
    check('new-chat-returns-to-the-folders-unsent-chat-and-its-draft', (await boxText()) === 'unsent draft', J(await boxText()));
    await openChat(TWO);

    const readAll = async () => {
      const fresh = await until(async () => (await boxText()) === 'unsent draft', 4000) ? 'unsent draft' : await boxText();
      await openChat(ONE);
      const one = await boxText();
      await openChat(TWO);
      const two = await boxText();
      return { fresh, one, two };
    };
    const WANT = { fresh: 'unsent draft', one: 'draft one', two: 'draft two' };

    await reload();
    const first = await readAll();
    await shot(s, '/tmp/conn-drafts-after-reload.png');
    check('draft-in-a-session-chat-survives-a-reload', first.one === WANT.one && first.two === WANT.two, J(first));
    check('draft-in-an-unsent-chat-returns-in-the-new-chat-for-that-folder', first.fresh === WANT.fresh, J(first));
    check('two-chats-keep-their-own-drafts-after-a-reload', first.one !== first.two && first.one === WANT.one && first.two === WANT.two, J(first));

    await reload();
    const second = await readAll();
    check('drafts-survive-a-second-reload', J(second) === J(WANT), J(second));

    await focusBox();
    await key(s, 'Ctrl+End');
    await typeThenReload(' tail', 50);
    await until(async () => !(await evaluate(s, `window.__beforeReload === true`).catch(() => true)), 15000);
    await reloaded();
    await openChat(TWO);
    check('a-reload-inside-the-wait-keeps-the-last-keystrokes', (await boxText()) === 'draft two tail', J(await boxText()));

    await openChat(ONE);
    await clearBox();
    await type(s, BIG);
    await sleep(600);
    await reload();
    await openChat(ONE);
    const big = await boxText();
    await shot(s, '/tmp/conn-drafts-large.png');
    check('a-10000-character-draft-returns-whole', big === BIG, `${big.length} characters, ${big === BIG ? 'equal' : 'different'}`);

    await clearBox();
    await sleep(700);
    await evaluate(s, `(() => {
      window.__sets = 0;
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function setItem(k, v) { window.__sets += 1; return set.call(this, k, v); };
    })()`);
    const until5 = Date.now() + 5000;
    while (Date.now() < until5) await type(s, 'x');
    await sleep(600);
    const sets = await evaluate(s, `window.__sets`);
    check('typing-for-5-seconds-writes-storage-fewer-than-20-times', sets >= 1 && sets < 20, `${sets} writes`);
    check('the-typed-draft-is-in-storage-after-the-pause', Object.values(await stored()).some((t) => /^x+$/.test(t)), J(await stored()));

    await reload();
    const before = await stored();
    check('the-second-chat-is-in-storage-before-it-is-deleted', before[TWO.id] === 'draft two tail', J(before));
    await hover(s, TWO.title);
    await click(s, `Delete ${TWO.title}`);
    await click(s, 'Delete');
    await until(async () => !(await railHas(TWO.title)));
    await until(async () => !(TWO.id in (await stored())), 2000);
    const afterDelete = await stored();
    await shot(s, '/tmp/conn-drafts-deleted.png');
    check('deleting-a-chat-leaves-no-key-in-storage', TWO.id in before && !(TWO.id in afterDelete), J(afterDelete));
    await reload();
    check('the-deleted-chats-key-stays-gone-after-a-reload', TWO.id in before && !(TWO.id in (await stored())), J(await stored()));

    await focusBox();
    await key(s, 'Ctrl+A');
    await key(s, 'Backspace');
    await inMain(`globalThis.__holdReady = true`);
    await type(s, 'first message');
    await sleep(700);
    const unsentKey = Object.keys(await stored()).find((k) => k.startsWith('new:'));
    check('an-unsent-chats-draft-is-stored-under-its-folder', unsentKey && (await stored())[unsentKey] === 'first message', J(await stored()));
    await key(s, 'Enter');
    await until(() => inMain(`!!globalThis.__agent`));
    await sleep(700);
    check('sending-clears-the-stored-draft', !!unsentKey && !Object.values(await stored()).includes('first message') && (await boxText()) === '', J(await stored()));

    await focusBox();
    await type(s, 'follow-up');
    await sleep(700);
    const waiting = await stored();
    await inMain(`globalThis.__release()`);
    await until(async () => SENT in (await stored()), 3000);
    const moved = await stored();
    await shot(s, '/tmp/conn-drafts-key-migration.png');
    check('the-draft-key-moves-to-the-session-id-when-the-session-starts',
      !Object.keys(waiting).includes(SENT) && waiting[unsentKey] === 'follow-up' && moved[SENT] === 'follow-up' && !(unsentKey in moved),
      J({ waiting, moved }));
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
