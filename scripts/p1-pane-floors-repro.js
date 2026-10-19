'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
};

const FLOOR = 290;

async function main() {
  const drive = await import(pathToFileURL(path.join(ROOT, '.claude/skills/verify/drive.mjs')).href);
  const { boot, stop, evaluate, click, key } = drive;
  const s = await boot({ xvfb: true });

  try {
    const until = async (fn, ms = 5000) => {
      const end = Date.now() + ms;
      let last;
      while (Date.now() < end) {
        last = await fn();
        if (last) return last;
        await sleep(100);
      }
      return last;
    };

    const widths = () => evaluate(s, `(() => {
      const w = (sel) => Math.round(document.querySelector(sel)?.getBoundingClientRect().width ?? -1);
      return { rail: w('[data-panel][id="rail"]'), agent: w('section#agent'), right: w('section#right'), inner: innerWidth };
    })()`);

    const untilWidthsStable = async (width) => {
      let prev = null;
      return until(async () => {
        const cur = await widths();
        const same = prev && J(prev) === J(cur);
        prev = cur;
        return cur.inner === width && same ? cur : null;
      });
    };

    const resize = async (width) => {
      await evaluate(s, `electron.BrowserWindow.getAllWindows()[0].setContentSize(${width}, 900)`, { main: true });
      return untilWidthsStable(width);
    };

    const changesListed = () => until(() => evaluate(s, `document.querySelector('section#right').innerText.includes('index.html') || null`), 10000);

    await click(s, 'Later').catch(() => {});
    const page = path.join(s.project, 'index.html');
    fs.writeFileSync(page, fs.readFileSync(page, 'utf8').replace('<h1>Your cart</h1>', '<h1>Your basket</h1>'));

    await resize(800);
    await key(s, 'Ctrl+Shift+G');
    check('changes-lists-the-edit', !!(await changesListed()), 'Changes never listed index.html');
    const narrow = await untilWidthsStable(800);
    check('chat-has-width-at-800', narrow.agent >= FLOOR, J(narrow));
    check('changes-has-width-at-800', narrow.right >= FLOOR, J(narrow));

    const wide = await resize(1440);
    check('chat-grows-back-at-1440', wide.agent > narrow.agent, `${J(narrow)} -> ${J(wide)}`);
    check('changes-grows-back-at-1440', wide.right > narrow.right, `${J(narrow)} -> ${J(wide)}`);
    check('rail-is-back-at-1440', wide.rail >= 160, J(wide));

    await key(s, 'Ctrl+Shift+G');
    await untilWidthsStable(1440);
    await resize(900);
    const railAt900 = (await untilWidthsStable(900)).rail;
    await key(s, 'Ctrl+Shift+G');
    await changesListed();
    const opened900 = await until(async () => {
      const cur = await widths();
      return cur.rail === 0 ? cur : null;
    }, 3000) || await widths();
    check('rail-yields-when-changes-opens-at-900', opened900.rail === 0, J(opened900));
    check('chat-is-roomy-at-900', opened900.agent >= 400, J(opened900));

    await key(s, 'Ctrl+Shift+G');
    const closed900 = await until(async () => {
      const cur = await widths();
      return cur.rail > 0 && cur.right === 0 ? cur : null;
    }, 3000) || await widths();
    check('rail-returns-when-changes-closes', Math.abs(closed900.rail - railAt900) <= 2, `rail was ${railAt900}, now ${J(closed900)}`);

    await resize(1440);
    await key(s, 'Ctrl+B');
    const userClosed = await until(async () => {
      const cur = await widths();
      return cur.rail === 0 ? cur : null;
    }, 3000);
    check('ctrl-b-collapses-the-rail', !!userClosed, J(await widths()));
    await key(s, 'Ctrl+Shift+G');
    await changesListed();
    await resize(800);
    const regrown = await resize(1440);
    check('rail-the-user-closed-stays-closed', regrown.rail === 0, J(regrown));
    check('chat-is-wide-at-1440', regrown.agent > 600, J(regrown));

    // At zoom 1.5 an 800 px window is 533 CSS px, less than the two floors.
    await key(s, 'Ctrl+Shift+G');
    await until(async () => ((await widths()).right <= 1 ? true : null), 3000);
    await evaluate(s, `(w => { w.webContents.setZoomFactor(1.5); w.setContentSize(800, 900); })(electron.BrowserWindow.getAllWindows()[0])`, { main: true });
    const zoomedInner = await until(async () => {
      const cur = await widths();
      return cur.inner < 540 ? cur.inner : null;
    });
    await key(s, 'Ctrl+Shift+G');
    await changesListed();
    const zoomed = await untilWidthsStable(zoomedInner);
    check('changes-has-width-when-zoomed', zoomed.right >= zoomedInner * 0.4, J(zoomed));
    check('chat-has-width-when-zoomed', zoomed.agent >= zoomedInner * 0.4, J(zoomed));
  } finally {
    await stop(s).catch((e) => console.log(`stop: ${e.message}`));
  }
}

main().then(() => {
  if (failures.length) {
    console.log(`\n${failures.length} failure(s)`);
    process.exit(1);
  }
  console.log('\nall passed');
}, (e) => {
  console.log(`FAIL repro: ${e.stack || e.message}`);
  process.exit(1);
});
