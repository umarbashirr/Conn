'use strict';
/* Backspace and Delete against a badge in the composer, in the real app
   (issue #32). The box removes the badge itself, so Chromium never deletes it
   and patches the line with a stray <br>. Reads the composer's value from the
   stored draft, which is written 400 ms after each change. Needs a built
   renderer: `npx vite build` first. */
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

const SHOT = (name) => path.join(os.tmpdir(), `conn-composer-badge-${name}.png`);

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
    const BOX = `document.querySelector('#agent-root [contenteditable="true"]')`;
    const stored = () => evaluate(s, `Object.values(JSON.parse(localStorage.getItem('conn.drafts') || '{}'))[0] ?? ''`);
    const value = async (want) => (await until(async () => (await stored()) === want, 1500)) ? want : stored();
    const keys = async (...chords) => { for (const c of chords) await key(s, c); };
    const markup = () => evaluate(s, `${BOX}.innerHTML.replace(/<span[^>]*data-raw[^]*?<\\/span>(<\\/span>)*/g, '[badge]')`);
    const badges = () => evaluate(s, `${BOX}.querySelectorAll('[data-raw]').length`);
    const paste = async (text) => {
      await inMain(`electron.clipboard.writeText(${J(text)})`);
      await key(s, 'Ctrl+V');
      await value(text);
    };
    const clearBox = async () => {
      await evaluate(s, `${BOX}.focus()`);
      await keys('Ctrl+A', 'Backspace', 'Delete');
      await value('');
    };

    await click(s, 'Later').catch(() => {});

    await clearBox();
    await paste('see @index.html');
    check('a-pasted-path-becomes-a-badge', (await badges()) === 1, await markup());
    await key(s, 'Backspace');
    const back = await value('see ');
    await shot(s, SHOT('backspace-after-badge'));
    check('backspace-after-a-trailing-badge-removes-just-the-badge', back === 'see ', J(back));
    check('backspace-after-a-trailing-badge-leaves-no-br', !/<br>/.test(await markup()), await markup());
    await keys('x');
    const afterBack = await value('see x');
    check('typing-after-that-backspace-stays-on-the-line', afterBack === 'see x', J(afterBack));

    await clearBox();
    await paste('a @index.html b');
    await keys('End', 'Left', 'Left', 'Backspace');
    const middle = await value('a  b');
    check('backspace-after-a-badge-mid-line-removes-just-the-badge', middle === 'a  b', J(middle));
    check('backspace-after-a-badge-mid-line-leaves-no-br', !/<br>/.test(await markup()), await markup());

    await clearBox();
    await paste('a @index.html b');
    await keys('Home', 'Right', 'Right', 'Delete');
    const forward = await value('a  b');
    await shot(s, SHOT('delete-before-badge'));
    check('delete-before-a-badge-mid-line-removes-just-the-badge', forward === 'a  b', J(forward));
    check('delete-before-a-badge-mid-line-leaves-no-br', !/<br>/.test(await markup()), await markup());

    await clearBox();
    await paste('@index.html');
    await keys('End', 'Backspace');
    const only = await value('');
    check('backspace-on-a-lone-badge-empties-the-box', only === '' && (await badges()) === 0, `${J(only)} ${await markup()}`);
    await keys('y');
    const afterOnly = await value('y');
    check('typing-after-a-lone-badge-is-deleted-gives-one-line', afterOnly === 'y' && !/<br>|<div>/.test(await markup()), `${J(afterOnly)} ${await markup()}`);

    await clearBox();
    await paste('see @index.html\nnext');
    await keys('Ctrl+Home', 'End', 'Backspace');
    const eol = await value('see \nnext');
    check('backspace-after-a-badge-at-the-end-of-a-line-keeps-one-line-break', eol === 'see \nnext', `${J(eol)} ${await markup()}`);

    await clearBox();
    await paste('a\n@index.html\nb');
    await keys('Ctrl+Home', 'Down', 'End', 'Backspace');
    const alone = await value('a\n\nb');
    check('backspace-after-a-badge-alone-on-a-line-leaves-that-line-empty', alone === 'a\n\nb', `${J(alone)} ${await markup()}`);
    await keys('z');
    const refill = await value('a\nz\nb');
    check('typing-on-that-empty-line-fills-it', refill === 'a\nz\nb', `${J(refill)} ${await markup()}`);

    // No known key builds this markup any more, but Chromium has before: a
    // loose line followed by a <div> per later line.
    await clearBox();
    await evaluate(s, `(() => { const b = ${BOX}; b.innerHTML = 'one<div>two</div><div><br></div>'; b.dispatchEvent(new InputEvent('input', { bubbles: true })); })()`);
    const divs = await value('one\ntwo\n');
    check('loose-text-before-a-div-reads-back-with-a-line-break', divs === 'one\ntwo\n', `${J(divs)} ${await markup()}`);

    await clearBox();
    await paste('see @index.html');
    await keys('Backspace', 'Ctrl+Z');
    const undone = await value('see @index.html');
    check('undo-brings-the-deleted-badge-back', undone === 'see @index.html' && (await badges()) === 1, `${J(undone)} ${await markup()}`);
  } finally {
    await stop(s);
  }
}

main()
  .catch((e) => check('run', false, e.stack || e.message))
  .finally(() => {
    console.log(failures.length ? `\n${failures.length} failed` : '\nall passed');
    process.exit(failures.length ? 1 : 0);
  });
