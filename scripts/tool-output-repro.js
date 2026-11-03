'use strict';
/* Tool output and input read as a person would want. Output carries a copy
   button, ANSI colours render as colours, every other escape is stripped, and
   the 4000-character cap and Show all still work. Input for a non-edit call is
   labelled fields, not a JSON blob. Needs a built renderer: `npx vite build`. */
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = process.env.CONN_ROOT || path.join(__dirname, '..');
const OUT = process.env.SHOTS || os.tmpdir();
const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
};

const call = (id, name, input) => ({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const back = (id, text, isError) => ({
  type: 'user',
  parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, ...(isError && { is_error: true }) }] },
});

const E = '\x1b';
const COLOURED = `${E}[2K${E}]0;title\x07${E}[31mFAIL${E}[0m cart.test.js\n${E}[1;32mPASS${E}[0m ${E}[2mcheckout.test.js${E}[22m\n${E}[?25h${E}[44mbg${E}[49m ${E}[96mcyan${E}[0m`;
const PLAIN = 'FAIL cart.test.js\nPASS checkout.test.js\nbg cyan';
const LONG_INPUT = { command: 'npm test', description: 'Run the suite\nthen the linter\nthen exit', pattern: 'x'.repeat(200), opts: { watch: false, files: ['a', 'b'] }, retries: 2 };

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
    const run = async (id, name, input, output, isError = false) => {
      await say(s, `Running ${id}.`, { open: true });
      await emit(call(id, name, input));
      await emit(back(id, output, isError));
    };
    const read = (id) => evaluate(s, `(() => {
      const r = document.querySelector('#row-${id}');
      if (!r) return null;
      const pre = r.querySelector('pre');
      const spans = pre ? [...pre.querySelectorAll('span')].map((e) => ({ text: e.textContent, cls: e.className, color: getComputedStyle(e).color })) : [];
      return {
        pre: pre?.textContent ?? null,
        preColor: pre ? getComputedStyle(pre).color : null,
        spans,
        copy: !!r.querySelector('button[aria-label="Copy output"]'),
        fields: r.querySelector('[data-slot="tool-fields"]')?.innerText ?? '',
        keys: [...r.querySelectorAll('[data-slot="tool-fields"] dt')].map((e) => e.textContent),
        inputPre: [...r.querySelectorAll('pre')].some((p) => p.textContent.includes('"command"')),
      };
    })()`);

    await click(s, 'Later').catch(() => {});

    await run('o1', 'Bash', LONG_INPUT, COLOURED);
    await until(() => read('o1'));
    await click(s, 'css=#row-o1 button');
    const o = await until(async () => (await read('o1'))?.pre && (await read('o1')));
    check('output-has-no-escape-bytes', !!o && !/\x1b|\[\d*m|\]0;/.test(o.pre), J(o?.pre));
    check('output-keeps-its-text-and-newlines', !!o && o.pre === PLAIN, J(o?.pre));
    const red = o?.spans.find((x) => x.text === 'FAIL');
    const green = o?.spans.find((x) => x.text === 'PASS');
    const dim = o?.spans.find((x) => x.text === 'checkout.test.js');
    check('red-sgr-renders-as-a-red-span', !!red && /text-red/.test(red.cls) && red.color !== o.preColor, J(red));
    check('bold-green-renders-bold-and-green', !!green && /text-emerald/.test(green.cls) && /font-semibold/.test(green.cls), J(green));
    check('dim-renders-dimmed', !!dim && /opacity-60/.test(dim.cls), J(dim));
    check('bright-cyan-renders-as-cyan', !!o?.spans.find((x) => x.text === 'cyan' && /text-cyan/.test(x.cls)), J(o?.spans));
    check('output-has-a-copy-button', !!o?.copy, J(o));
    await click(s, 'css=#row-o1 button[aria-label="Copy output"]').catch(() => {});
    const copied = await until(() => evaluate(s, `document.querySelector('#row-o1 button[data-copied]') !== null`));
    check('copy-button-confirms-the-copy', !!copied, 'no data-copied');
    const clip = await evaluate(s, `electron.clipboard.readText()`, { main: true });
    check('copy-puts-the-plain-text-on-the-clipboard', clip === PLAIN, J(clip));

    check('input-is-labelled-fields', !!o && J(o.keys) === J(['command', 'description', 'pattern', 'opts', 'retries']), J(o?.keys));
    check('short-string-is-inline', !!o && /command\s+npm test/.test(o.fields), J(o?.fields));
    check('multi-line-string-keeps-its-lines', !!o && o.fields.includes('Run the suite\nthen the linter\nthen exit'), J(o?.fields));
    check('nested-object-is-compact-json', !!o && o.fields.includes('{"watch":false,"files":["a","b"]}'), J(o?.fields));
    check('input-is-not-a-json-blob', !!o && !o.inputPre, J(o));
    await shot(s, path.join(OUT, 'output-and-input-dark.png'));
    await evaluate(s, `document.documentElement.dataset.theme = 'light'`);
    await sleep(300);
    await shot(s, path.join(OUT, 'output-and-input-light.png'));
    await evaluate(s, `document.documentElement.dataset.theme = 'dark'`);

    const DIGITS = '0123456789'.repeat(900);
    await run('o2', 'Bash', { command: 'cat big' }, `${E}[31m${DIGITS}${E}[0m`);
    await until(() => read('o2'));
    await click(s, 'css=#row-o2 button');
    const cut = await until(async () => (await read('o2'))?.pre?.length === 4000 && (await read('o2')));
    check('coloured-output-keeps-the-4000-cap', !!cut, J((await read('o2'))?.pre?.length));
    check('cap-says-how-much-is-hidden', (await evaluate(s, `document.querySelector('#row-o2').innerText.includes('5,000 more characters')`)), 'no marker');
    await click(s, 'Show all').catch(() => {});
    check('show-all-renders-all-9000', !!(await until(async () => (await read('o2'))?.pre?.length === 9000)), J((await read('o2'))?.pre?.length));
    await click(s, 'css=#row-o2 button[aria-label="Copy output"]').catch(() => {});
    check('copy-takes-the-whole-output-even-when-capped', (await evaluate(s, `electron.clipboard.readText()`, { main: true })) === DIGITS, 'clipboard differs');

    await run('o3', 'Bash', { command: 'npm run build' }, `${E}[31mnpm ERR!${E}[0m boom`, true);
    const f = await until(async () => (await read('o3'))?.pre && (await read('o3')));
    check('failed-output-strips-escapes', !!f && f.pre === 'npm ERR! boom', J(f?.pre));
    check('failed-row-input-still-waits-in-a-closed-fold', !!f && f.fields === '', J(f?.fields));
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
