'use strict';
/* A failed tool row leads with what went wrong (CUX-11). The raw input waits in
   a closed Input fold, output past 4000 characters says how much is hidden and
   offers Show all, and a short successful row reads as it always did. A failed
   Edit keeps its diff. Needs a built renderer: `npx vite build` first. */
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

const SHOT = (name) => path.join(os.tmpdir(), `conn-failed-tool-${name}.png`);
const call = (id, name, input) => ({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const back = (id, text, isError) => ({
  type: 'user',
  parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, ...(isError && { is_error: true }) }] },
});

const DIGITS = '0123456789'.repeat(900);
const ERROR = 'npm ERR! 3 tests failed in cart.test.js';

async function main() {
  const drive = await import(pathToFileURL(path.join(ROOT, '.claude/skills/verify/drive.mjs')).href);
  const { boot, stop, evaluate, click, say, shot } = drive;
  const s = await boot({ root: ROOT, xvfb: true });

  try {
    const emit = (msg) => evaluate(s, `globalThis.__agent.emit('message', ${J(msg)})`, { main: true });
    const until = async (fn, ms = 4000) => {
      const end = Date.now() + ms;
      let got;
      while (Date.now() < end && !(got = await fn())) await sleep(100);
      return got;
    };
    const breakRun = (id) => say(s, `Running ${id}.`, { open: true });
    const run = async (id, name, input, output, isError = false) => {
      await breakRun(id);
      await emit(call(id, name, input));
      await emit(back(id, output, isError));
    };
    const read = (id) => evaluate(s, `(() => {
      const r = document.querySelector('#row-${id}');
      if (!r) return null;
      const toggle = r.querySelector('[data-slot="tool-input"]');
      return {
        text: r.innerText,
        pres: [...r.querySelectorAll('pre')].map((p) => p.textContent),
        input: !!toggle,
        expanded: toggle?.getAttribute('aria-expanded') ?? null,
        showAll: [...r.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Show all'),
      };
    })()`);
    const lengths = (r) => r && r.pres.map((p) => p.length);

    await click(s, 'Later').catch(() => {});

    await run('toolu_fail', 'Bash', { command: 'npm test' }, ERROR, true);
    const failed = await until(async () => (await read('toolu_fail'))?.text.includes(ERROR) && (await read('toolu_fail')));
    const errAt = failed ? failed.text.indexOf(ERROR) : -1;
    const jsonAt = failed ? failed.text.indexOf('"command"') : -1;
    check('failed-row-shows-the-error-before-the-input', errAt >= 0 && (jsonAt === -1 || errAt < jsonAt), J(failed));
    check('failed-row-input-fold-is-closed', !!failed && failed.input && failed.expanded === 'false' && jsonAt === -1, J(failed));
    await shot(s, SHOT('failed'));
    await click(s, 'css=#row-toolu_fail [data-slot="tool-input"]').catch(() => {});
    const opened = await until(async () => (await read('toolu_fail'))?.text.includes('"command"') && (await read('toolu_fail')));
    check('opening-the-input-fold-shows-the-json', !!opened && opened.pres.some((p) => p.includes('"command": "npm test"')) && opened.expanded === 'true', J(opened));
    check('error-stays-above-the-opened-input', !!opened && opened.text.indexOf(ERROR) < opened.text.indexOf('"command"'), J(opened));
    await shot(s, SHOT('input-fold'));

    await run('toolu_long', 'Bash', { command: 'npm run build' }, DIGITS, true);
    const cut = await until(async () => (await read('toolu_long'))?.text.includes('more characters') && (await read('toolu_long')));
    check('long-output-says-how-much-is-hidden', !!cut && cut.text.includes('5,000 more characters'), J(lengths(cut)));
    check('long-output-shows-the-first-4000', !!cut && cut.pres.some((p) => p === DIGITS.slice(0, 4000)), J(lengths(cut)));
    check('long-output-offers-show-all', !!cut?.showAll, J(cut));
    await shot(s, SHOT('cut-marker'));
    await click(s, 'Show all').catch(() => {});
    const all = await until(async () => (await read('toolu_long'))?.pres.some((p) => p === DIGITS) && (await read('toolu_long')));
    check('show-all-renders-all-9000', !!all, J(lengths(await read('toolu_long'))));
    check('show-all-drops-the-marker', !!all && !all.text.includes('more characters') && !all.showAll, J(all));
    await shot(s, SHOT('show-all'));

    await run('toolu_edge', 'Bash', { command: 'cat edge.txt' }, DIGITS.slice(0, 4000), true);
    const edge = await until(async () => (await read('toolu_edge'))?.pres.some((p) => p.length === 4000) && (await read('toolu_edge')));
    check('exactly-4000-characters-shows-all-without-a-marker', !!edge && !edge.text.includes('more characters') && !edge.showAll, J(lengths(edge)));

    await run('toolu_one', 'Bash', { command: 'cat one.txt' }, DIGITS.slice(0, 4001), true);
    const one = await until(async () => (await read('toolu_one'))?.showAll && (await read('toolu_one')));
    check('one-character-over-says-one-more-character', !!one && /\b1 more character\b(?!s)/.test(one.text), J(one?.text?.slice(-60)));

    await run('toolu_ok', 'Bash', { command: 'git status' }, 'On branch main');
    await until(() => read('toolu_ok'));
    await click(s, 'css=#row-toolu_ok button').catch(() => {});
    const ok = await until(async () => (await read('toolu_ok'))?.text.includes('On branch main') && (await read('toolu_ok')));
    check('successful-row-keeps-the-input-before-the-output', !!ok && ok.pres[0]?.includes('"command": "git status"') && ok.pres[1] === 'On branch main', J(ok));
    check('successful-row-has-no-input-fold', !!ok && !ok.input, J(ok));
    await shot(s, SHOT('success'));

    await run('toolu_okLong', 'Bash', { command: 'cat big.log' }, DIGITS);
    await until(() => read('toolu_okLong'));
    await click(s, 'css=#row-toolu_okLong button').catch(() => {});
    const okLong = await until(async () => (await read('toolu_okLong'))?.text.includes('more characters') && (await read('toolu_okLong')));
    check('long-successful-output-says-how-much-is-hidden',
      !!okLong && okLong.text.includes('5,000 more characters') && okLong.pres[0]?.includes('"command"') && okLong.pres[1]?.length === 4000, J(lengths(okLong)));

    const edit = { file_path: path.join(s.project, 'index.html'), old_string: 'Your cart', new_string: 'Your basket' };
    await run('toolu_edit', 'Edit', edit, 'old_string was not found in index.html', true);
    const editRow = () => evaluate(s, `(() => {
      const pre = [...document.querySelectorAll('#agent-root pre')].find((p) => p.textContent.includes('old_string was not found'));
      const r = pre?.closest('.bg-destructive\\\\/5');
      return r && { text: r.innerText, input: !!r.querySelector('[data-slot="tool-input"]') };
    })()`);
    const edited = await until(editRow);
    check('failed-edit-keeps-its-diff-and-shows-the-error', !!edited && edited.text.includes('Your basket') && edited.text.includes('old_string was not found'), J(edited));
    check('failed-edit-has-no-input-fold', !!edited && !edited.input, J(edited));
    await shot(s, SHOT('failed-edit'));

    await run('toolu_editLong', 'Edit', edit, DIGITS, true);
    const editCut = await until(() => evaluate(s, `document.querySelector('#agent-root')?.innerText.includes('5,000 more characters')`));
    check('long-edit-error-says-how-much-is-hidden', !!editCut, J(editCut));
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
