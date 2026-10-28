'use strict';
/* A finished turn ends with the files it changed (CUX-13). Two edits to one
   file read as one line with summed counts, a turn without edits has no footer,
   a failed edit is not listed, the footer waits for the turn to end, and a line
   opens that file's diff. Needs a built renderer: `npx vite build` first. */
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

const SHOT = (name) => path.join(os.tmpdir(), `conn-turn-edits-${name}.png`);
const call = (id, name, input) => ({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const back = (id, text, isError) => ({
  type: 'user',
  parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, ...(isError && { is_error: true }) }] },
});

async function main() {
  const drive = await import(pathToFileURL(path.join(ROOT, '.claude/skills/verify/drive.mjs')).href);
  const { boot, stop, evaluate, click, say, key, type, shot } = drive;
  const s = await boot({ root: ROOT, xvfb: true });

  try {
    const emit = (msg) => evaluate(s, `globalThis.__agent.emit('message', ${J(msg)})`, { main: true });
    const until = async (fn, ms = 4000) => {
      const end = Date.now() + ms;
      let got;
      while (Date.now() < end && !(got = await fn())) await sleep(100);
      return got;
    };
    const at = (file) => path.join(s.project, file);
    const run = async (id, name, input, isError = false) => {
      await emit(call(id, name, input));
      await emit(back(id, isError ? 'old_string was not found' : 'The file has been updated', isError));
    };
    const finish = () => emit({ type: 'result', subtype: 'success', duration_ms: 1200 });
    const ask = async (text) => {
      await evaluate(s, `document.querySelector('#agent-root [contenteditable="true"]').focus()`);
      await type(s, text);
      await key(s, 'Enter');
      await until(() => evaluate(s, `document.querySelector('#agent-root')?.innerText.includes(${J(text)})`));
    };
    const footers = () => evaluate(s, `[...document.querySelectorAll('[data-turn-edits]')].map((f) => ({
      lines: [...f.querySelectorAll('[data-turn-file]')].map((l) => l.innerText.replace(/\\s+/g, ' ').trim()),
    }))`);
    const settle = async (n) => until(async () => ((await footers()).length >= n ? footers() : null), 3000);

    const snap = async (name) => {
      await click(s, 'Later', { wait: 300 }).catch(() => {});
      await shot(s, SHOT(name));
    };

    await say(s, 'On it.', { open: true });
    await run('e1', 'Edit', { file_path: at('index.html'), old_string: 'a\nb', new_string: 'c' });
    await run('e2', 'Edit', { file_path: at('index.html'), old_string: 'x', new_string: 'y\nz\nw' });
    await sleep(400);
    check('footer-waits-for-the-turn-to-end', (await footers()).length === 0, J(await footers()));
    await finish();
    const one = await settle(1);
    check('two-edits-to-one-file-are-one-line', !!one && one.length === 1 && one[0].lines.length === 1, J(one));
    check('the-line-sums-the-counts', !!one && /index\.html\s*\+4\s*-3/.test(one[0].lines[0] ?? ''), J(one));
    await snap('one-file');

    await ask('Explain it');
    await say(s, 'It does this.');
    await sleep(400);
    check('a-turn-with-no-edits-has-no-footer', (await footers()).length === 1, J(await footers()));

    await ask('Change three files');
    await say(s, 'Working.', { open: true });
    await run('e3', 'Edit', { file_path: at('src/app.js'), old_string: 'one', new_string: 'two' });
    await run('e4', 'Write', { file_path: at('notes.txt'), content: 'hello\nthere\n' });
    await run('e5', 'Edit', { file_path: at('styles.css'), old_string: 'red', new_string: 'blue\nteal' });
    await run('e6', 'Edit', { file_path: at('broken.js'), old_string: 'q', new_string: 'r' }, true);
    await sleep(400);
    check('footer-waits-for-the-second-turn-too', (await footers()).length === 1, J(await footers()));
    await finish();
    const three = await settle(2);
    const lines = three?.[1]?.lines ?? [];
    check('three-files-are-three-lines', lines.length === 3, J(three));
    check('a-write-counts-its-lines', lines.some((l) => /notes\.txt\s*\+2/.test(l) && !/-\d/.test(l)), J(lines));
    check('a-failed-edit-is-not-listed', lines.length === 3 && !lines.some((l) => l.includes('broken.js')), J(lines));
    check('the-first-turn-keeps-its-line', three?.[0]?.lines.length === 1, J(three));
    await snap('three-files');

    await click(s, 'css=[data-turn-file$="styles.css"]').catch(() => {});
    const dialog = await until(() => evaluate(s, `(() => {
      const d = document.querySelector('[role="dialog"]');
      return d && { title: d.querySelector('[data-slot="dialog-title"]')?.innerText, text: d.innerText };
    })()`));
    check('a-line-opens-a-dialog-titled-with-the-path', !!dialog && /styles\.css/.test(dialog.title ?? ''), J(dialog));
    check('the-dialog-shows-the-diff', !!dialog && dialog.text.includes('blue') && dialog.text.includes('teal') && dialog.text.includes('red'), J(dialog));
    await snap('dialog');
    await key(s, 'Escape');
    check('escape-closes-the-dialog', !!dialog && !!(await until(async () => !(await evaluate(s, `!!document.querySelector('[role="dialog"]')`)))), 'still open');
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
