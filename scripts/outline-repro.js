'use strict';
/* The turn outline sits in the gutter left of the chat column: one row per
   message you sent, marked with what that turn did, the turn you are reading
   highlighted. Ticks on the scrollbar track carry the same marks at any width.
   Clicking a turn the transcript has not drawn yet draws back to it and
   scrolls there. Needs a built renderer: `npx vite build` first. Screenshots
   go to OUTLINE_SHOTS (default the temp dir), named with OUTLINE_TAG. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = process.env.CONN_ROOT || path.join(__dirname, '..');
const SHOTS = process.env.OUTLINE_SHOTS || os.tmpdir();
const TAG = process.env.OUTLINE_TAG || 'outline';
const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TURNS = 14;

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
};

const SHOT = (name) => path.join(SHOTS, `${TAG}-${name}.png`);
const call = (id, name, input) => ({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const back = (id, text, isError = false) => ({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] } });

const ASKS = [
  'run the application with .env.production',
  'check the analytics API answers',
  'add the engagement KPI row',
  'now run the tests',
  'fix the failing test',
  'compare the two candidates',
  'tidy the column widths',
  'write the design notes',
  'rename the heading',
  'update AGENTS.md',
  'restart the analytics frontend',
  'verify the October numbers',
  'open a PR for this',
  'deploy it to staging',
];

async function main() {
  const drive = await import(pathToFileURL(path.join(ROOT, '.claude/skills/verify/drive.mjs')).href);
  const { boot, stop, evaluate, click, key, type, say, perm, shot } = drive;
  const s = await boot({ root: ROOT, xvfb: true });

  try {
    const emit = (msg) => evaluate(s, `globalThis.__agent.emit('message', ${J(msg)})`, { main: true });
    const js = (code) => evaluate(s, code);
    const until = async (fn, ms = 5000) => {
      const end = Date.now() + ms;
      let got;
      while (Date.now() < end && !(got = await fn())) await sleep(150);
      return got;
    };
    const resize = (w, h) => evaluate(s, `electron.BrowserWindow.getAllWindows()[0].setContentSize(${w}, ${h})`, { main: true });
    const state = () => js(`(() => {
      const box = (el) => el && (({ left, right, top, bottom }) => ({ left, right, top, bottom }))(el.getBoundingClientRect());
      const outline = document.querySelector('[data-slot="chat-outline"]');
      const rows = [...(outline?.querySelectorAll('[data-outline-turn]') ?? [])];
      return {
        outline: box(outline),
        column: box(document.querySelector('[data-chat-column]')),
        rows: rows.map((r) => ({ id: r.dataset.outlineTurn, text: r.innerText, here: r.getAttribute('aria-current') })),
        ticks: [...document.querySelectorAll('[data-slot="chat-ticks"] [data-tick]')].map((t) => t.dataset.tick),
        drawn: [...document.querySelectorAll('[data-turn]')].map((r) => r.dataset.turn),
        firstTurnTop: (() => {
          const first = document.querySelector('[data-outline-turn]')?.dataset.outlineTurn;
          const row = first && document.querySelector('[data-turn="' + CSS.escape(first) + '"]');
          const view = document.querySelector('[role="log"]');
          return row && view ? row.getBoundingClientRect().top - view.getBoundingClientRect().top : null;
        })(),
      };
    })()`);

    await click(s, 'Later').catch(() => {});

    for (let i = 0; i < TURNS; i++) {
      const ask = ASKS[i];
      if (i === 0) await say(s, 'On it.', { prompt: ask, open: true });
      else {
        await key(s, 'Ctrl+Shift+K');
        await type(s, ask, { enter: true });
        await say(s, 'On it.', { open: true });
      }
      if (i % 3 === 0) {
        const file = path.join(s.project, `step-${i}.txt`);
        await emit(call(`w${i}`, 'Write', { file_path: file, content: `step ${i}\n` }));
        await emit(back(`w${i}`, 'File created.'));
      }
      if (i === 4) {
        await emit(call('fail', 'Bash', { command: 'npm test' }));
        await emit(back('fail', '1 failing', true));
      }
      for (let k = 0; k < 2; k++) {
        await emit(call(`r${i}-${k}`, 'Read', { file_path: path.join(s.project, 'index.html') }));
        await emit(back(`r${i}-${k}`, 'ok'));
        await say(s, `Read step ${k + 1} of turn ${i + 1}.`, { open: true });
      }
      if (i === TURNS - 1) await perm(s, 'Bash', { input: { command: 'npm run deploy:staging' }, id: 'wait' });
      else await say(s, `Done with turn ${i + 1}.`);
    }

    const full = await until(async () => { const st = await state(); return st.rows.length === TURNS && st; }, 8000);
    const st = full || await state();
    check('outline-lists-every-turn', st.rows.length === TURNS, J(st.rows.length));
    check('outline-rows-are-named-by-the-message', st.rows[0]?.text.includes('.env.production') && st.rows[13]?.text.includes('staging'), J(st.rows.map((r) => r.text)));
    check('outline-sits-left-of-the-column', !!st.outline && !!st.column && st.outline.right <= st.column.left, J({ outline: st.outline, column: st.column }));
    check('latest-turn-is-marked-as-read', st.rows[TURNS - 1]?.here === 'location', J(st.rows.map((r) => r.here)));
    check('ticks-carry-error-edit-and-waiting', ['error', 'edit', 'waiting'].every((t) => st.ticks.includes(t)), J(st.ticks));
    await shot(s, SHOT('1440-outline-beside-the-chat'));

    // A chat opened again draws only its latest rows, so its first turns are
    // not on the page until asked for.
    await click(s, 'New chat');
    await say(s, 'Short one.', { prompt: 'a short chat' });
    const short = await until(async () => { const now = await state(); return now.rows.length === 0 && now.ticks.length === 0 && now; }, 4000);
    check('a-short-chat-has-no-outline-or-ticks', !!short, J(await state()));
    await click(s, ASKS[0]);
    const reopened = await until(async () => { const now = await state(); return now.rows.length === TURNS && now; }, 6000);
    check('a-reopened-long-chat-starts-with-its-first-turns-undrawn', !!reopened && !reopened.drawn.includes(reopened.rows[0]?.id), J(reopened?.drawn));

    await click(s, 'css=[data-outline-turn]');
    const jumped = await until(async () => {
      const now = await state();
      return now.drawn.includes(now.rows[0]?.id) && now.firstTurnTop !== null && Math.abs(now.firstTurnTop) < 80 && now.rows[0]?.here === 'location' && now;
    }, 6000);
    check('clicking-an-undrawn-turn-draws-back-and-scrolls-to-it', !!jumped, J(await state()));
    await shot(s, SHOT('jumped-to-the-first-turn'));

    await sleep(1200);
    const held = await state();
    check('the-jump-is-not-pulled-back-to-the-bottom', held.rows[0]?.here === 'location', J(held.rows.map((r) => r.here)));

    await click(s, 'xy=1322,15');
    await shot(s, SHOT('1440-light-theme'));

    await resize(1000, 800);
    const narrow = await until(async () => { const now = await state(); return !now.outline && now; }, 4000);
    check('narrow-window-drops-the-outline', !!narrow, J(await state()));
    check('narrow-window-keeps-the-ticks', !!narrow && narrow.ticks.length > 0, J(narrow?.ticks));
    await shot(s, SHOT('narrow-1000-ticks-only'));
  } finally {
    await stop(s);
  }
  console.log(failures.length ? `\n${failures.length} failed` : '\nall passed');
  process.exitCode = failures.length ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
