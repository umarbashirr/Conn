'use strict';
/* New lines in the composer, in the real app (issue #22). Text typed after a
   Shift+Enter at the end of a draft lands on the new line, a line break that
   arrives inside inserted or pasted text survives, and the value the composer
   reports (the stored draft, and what Send sends) is the string the person
   typed. Reads the composer's value from the stored draft, which is written
   400 ms after each change. Needs a built renderer: `npx vite build` first. */
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

const SHOT = (name) => path.join(os.tmpdir(), `conn-composer-newline-${name}.png`);

async function main() {
  const drive = await import(pathToFileURL(path.join(ROOT, '.claude/skills/verify/drive.mjs')).href);
  const { boot, stop, evaluate, click, key, type, shot } = drive;
  const s = await boot({ root: ROOT, xvfb: true });

  try {
    const inMain = (expr) => evaluate(s, expr, { main: true });
    const until = async (fn, ms = 3000) => {
      const end = Date.now() + ms;
      let got;
      while (Date.now() < end && !(got = await fn())) await sleep(100);
      return got;
    };
    const WC = `electron.BrowserWindow.getAllWindows().find((w) => /index\\.html/.test(w.webContents.getURL())).webContents`;
    const BOX = `document.querySelector('#agent-root [contenteditable="true"]')`;
    const focusBox = () => evaluate(s, `${BOX}.focus()`);
    const stored = () => evaluate(s, `Object.values(JSON.parse(localStorage.getItem('conn.drafts') || '{}'))[0] ?? ''`);
    const value = async (want) => (await until(async () => (await stored()) === want, 1500)) ? want : stored();
    const keys = async (...chords) => { for (const c of chords) await key(s, c); };
    const clearBox = async () => {
      await focusBox();
      await keys('Ctrl+A', 'Backspace', 'Delete');
      await value('');
    };
    // The top of the box a character was drawn at, relative to the top of the
    // first character: 0 on line one, one line height further down on line two.
    const lineOf = (index) => evaluate(s, `(() => {
      const box = ${BOX};
      const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
      const at = (i) => {
        let n; let seen = 0;
        while ((n = walker.nextNode())) {
          if (i < seen + n.nodeValue.length) { const r = document.createRange(); r.setStart(n, i - seen); r.setEnd(n, i - seen + 1); return r.getBoundingClientRect().top; }
          seen += n.nodeValue.length;
        }
        return null;
      };
      const first = at(0);
      walker.currentNode = box;
      const top = at(${index});
      return top == null ? null : Math.round(top - first);
    })()`);

    await click(s, 'Later').catch(() => {});
    await inMain(`(() => {
      const { AgentSession } = req('./agent');
      globalThis.__sent = [];
      AgentSession.prototype.send = function send(text) { globalThis.__sent.push(text); };
      return true;
    })()`);

    await focusBox();
    await type(s, 'draft');
    await key(s, 'Shift+Enter');
    await value('draft\n');
    await sleep(300);
    await evaluate(s, `window.__beforeReload = true`);
    await inMain(`${WC}.reload()`);
    await until(async () => !(await evaluate(s, `window.__beforeReload === true`).catch(() => true)), 15000);
    await until(async () => (await evaluate(s, `${BOX}?.textContent`).catch(() => null)) === 'draft\n', 15000);
    await focusBox();
    await keys('Ctrl+End', 'n', 'e', 'x', 't');
    const restored = await value('draft\nnext');
    await shot(s, SHOT('restored-draft'));
    check('a-draft-ending-in-a-newline-is-redrawn-with-the-caret-able-to-reach-the-new-line', restored === 'draft\nnext', J(restored));

    await clearBox();
    await type(s, 'line one');
    await key(s, 'Shift+Enter');
    const afterBreak = await value('line one\n');
    check('value-after-a-trailing-shift-enter-is-the-text-and-one-newline', afterBreak === 'line one\n', J(afterBreak));
    await keys('t', 'w', 'o');
    const typed = await value('line one\ntwo');
    await shot(s, SHOT('typed-after-break'));
    check('shift-enter-at-the-end-then-typing-gives-two-lines', typed === 'line one\ntwo', J(typed));
    const line = await lineOf('line one\n'.length);
    check('text-typed-after-the-break-is-drawn-on-line-two', line > 0, `"t" drawn ${line}px below "l"`);

    await key(s, 'Enter');
    const sent = await until(() => inMain('globalThis.__sent.at(-1)'));
    check('send-sends-the-two-lines-and-nothing-else', sent === 'line one\ntwo', J(sent));
    await until(async () => (await evaluate(s, `${BOX}.textContent`)) === '');

    await clearBox();
    await type(s, 'a');
    await keys('Shift+Enter', 'Shift+Enter', 'b');
    const twice = await value('a\n\nb');
    check('two-shift-enters-at-the-end-then-typing-gives-a-blank-line-between', twice === 'a\n\nb', J(twice));

    await clearBox();
    await type(s, 'ab');
    await keys('Left', 'Shift+Enter', 'x');
    const middle = await value('a\nxb');
    check('shift-enter-in-the-middle-still-splits-the-line', middle === 'a\nxb', J(middle));

    await clearBox();
    await type(s, 'line one');
    await keys('Shift+Enter', 'Backspace');
    const erased = await value('line one');
    check('backspace-after-a-trailing-shift-enter-removes-the-newline', erased === 'line one', J(erased));
    await key(s, 'x');
    const rejoined = await value('line onex');
    check('typing-after-that-backspace-continues-line-one', rejoined === 'line onex', J(rejoined));

    await clearBox();
    await type(s, 'line one');
    await keys('Shift+Enter', 'Ctrl+A', 'Backspace');
    const emptied = await value('');
    check('select-all-and-delete-after-a-trailing-newline-empties-the-box', emptied === '', J(emptied));

    await clearBox();
    await type(s, 'a\nb');
    const inserted = await value('a\nb');
    check('inserted-text-keeps-its-newline', inserted === 'a\nb', J(inserted));

    await clearBox();
    await inMain(`electron.clipboard.writeText('one\\ntwo\\n')`);
    await key(s, 'Ctrl+V');
    const pasted = await value('one\ntwo\n');
    check('pasted-text-keeps-its-newlines', pasted === 'one\ntwo\n', J(pasted));
    await key(s, 'x');
    const afterPaste = await value('one\ntwo\nx');
    check('typing-after-a-paste-that-ends-in-a-newline-lands-on-the-new-line', afterPaste === 'one\ntwo\nx', J(afterPaste));

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
