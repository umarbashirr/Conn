'use strict';
/* A Bash row whose output is a test run leads with its summary and opens onto
   suites and the failing test's error, and a stack trace shows app frames as
   links into the Files view with framework frames folded. Fixtures
   are real runner output from scripts/fixtures/test-runs, with the scratch
   paths pointed at the booted project. Needs a built renderer: `npx vite build`
   first. CONN_ROOT picks the checkout to boot. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = process.env.CONN_ROOT || path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures', 'test-runs');
const OUT = process.env.SHOT_DIR || path.join(os.tmpdir(), 'conn-test-results');
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

async function main() {
  const drive = await import(pathToFileURL(path.join(ROOT, '.claude/skills/verify/drive.mjs')).href);
  const { boot, stop, evaluate, click, say, shot } = drive;
  const s = await boot({ root: ROOT, xvfb: true });

  try {
    const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8').replaceAll('/tmp/u7scratch', s.project);
    fs.writeFileSync(path.join(s.project, 'cart.test.js'), [
      "const { describe, it } = require('node:test');",
      "const assert = require('node:assert/strict');",
      'const total = (xs) => xs.reduce((a, b) => a + b, 0);',
      "describe('cart', () => {",
      "  it('adds items', () => { assert.equal(total([1, 2]), 3); });",
      "  it('applies coupon', () => { assert.equal(total([40]) - 4, 35); });",
      '});',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(s.project, 'trace.js'), [
      "const fs = require('fs');",
      "function load(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }",
      "function main() { return load('./missing.json'); }",
      'main();',
      '',
    ].join('\n'));

    const emit = (msg) => evaluate(s, `globalThis.__agent.emit('message', ${J(msg)})`, { main: true });
    const until = async (fn, ms = 4000) => {
      const end = Date.now() + ms;
      let got;
      while (Date.now() < end && !(got = await fn())) await sleep(100);
      return got || null;
    };
    const run = async (id, command, output, isError = false) => {
      await say(s, `Running ${id}.`, { open: true });
      await emit(call(id, 'Bash', { command }));
      await emit(back(id, output, isError));
    };
    const js = (code) => evaluate(s, code);
    const row = (id) => js(`(() => {
      const r = document.querySelector('#row-${id}');
      if (!r) return null;
      const q = (sel) => [...r.querySelectorAll(sel)];
      return {
        text: r.innerText,
        summary: r.querySelector('[data-slot="test-summary"]')?.innerText ?? null,
        summaryRed: !!r.querySelector('[data-slot="test-summary"].text-destructive'),
        suites: q('[data-slot="test-suite"]').map((b) => ({ text: b.innerText, open: b.getAttribute('aria-expanded') })),
        tests: q('[data-slot="test-line"]').map((b) => ({ text: b.innerText, status: b.dataset.status, open: b.getAttribute('aria-expanded') })),
        frames: q('[data-slot="stack-frame"]').map((b) => b.innerText),
        folds: q('[data-slot="stack-fold"]').map((b) => b.innerText),
        raw: r.querySelector('[data-slot="raw-output"]')?.getAttribute('aria-expanded') ?? null,
        pres: q('pre').map((p) => p.textContent),
      };
    })()`);

    const tryClick = (target) => click(s, target).catch(() => {});
    await tryClick('Later');

    await run('t_fail', 'node --test cart.test.js', fixture('node-fail.txt'), true);
    const failed = await until(async () => (await row('t_fail'))?.summary && (await row('t_fail')));
    check('failed-run-leads-with-its-summary', failed?.summary === '5 tests, 1 failed, 1 skipped', J(failed));
    check('failed-run-summary-is-in-error-styling', !!failed?.summaryRed, J(failed));
    check('failing-suite-starts-open', failed?.suites.find((x) => x.text.startsWith('cart'))?.open === 'true', J(failed?.suites));
    check('passing-suite-starts-closed', failed?.suites.find((x) => x.text.startsWith('coupon'))?.open === 'false', J(failed?.suites));
    check('raw-output-is-folded', failed?.raw === 'false' && !failed.pres.some((p) => p.includes('ℹ tests')), J(failed?.pres));
    await shot(s, path.join(OUT, 'failed-run-suites.png'));

    await tryClick('css=#row-t_fail [data-slot="test-line"][data-status="failed"]');
    const opened = await until(async () => (await row('t_fail'))?.tests.some((t) => t.open === 'true') && (await row('t_fail')));
    check('failed-test-expands-to-its-error', !!opened && opened.text.includes('36 !== 35'), J(await row('t_fail')));
    check('error-trace-links-the-app-frame', opened?.frames.some((f) => f.includes('cart.test.js:6')), J(opened?.frames));
    check('error-trace-folds-framework-frames', opened?.folds.some((f) => /\d+ framework frames/.test(f)), J(opened?.folds));
    await shot(s, path.join(OUT, 'failed-test-error-with-trace.png'));

    await tryClick('css=#row-t_fail [data-slot="stack-fold"]');
    const unfolded = await until(async () => (await row('t_fail'))?.folds.length && (await row('t_fail'))?.text.includes('node:internal/test_runner'));
    check('framework-fold-expands', !!unfolded, J((await row('t_fail'))?.folds));

    await tryClick('css=#row-t_fail [data-slot="stack-frame"]');
    const hit = await until(() => js(`document.querySelector('#file-view .line[data-hit]')?.textContent ?? null`));
    check('clicking-a-frame-opens-the-file-at-its-line', !!hit && hit.includes('applies coupon'), J(hit));
    const head = await js(`document.querySelector('#file-view')?.closest('section')?.innerText.slice(0, 200) ?? ''`);
    check('files-view-names-the-file', /cart\.test\.js/.test(head), head);
    await shot(s, path.join(OUT, 'clicked-frame-opens-file-at-line.png'));

    await tryClick('css=#row-t_fail [data-slot="raw-output"]');
    const raw = await until(async () => (await row('t_fail'))?.raw === 'true' && (await row('t_fail'))?.text.includes('ℹ tests 5'));
    check('raw-output-fold-opens-onto-the-original-text', !!raw, J((await row('t_fail'))?.text));

    await run('t_pass', 'node --test cart.test.js', fixture('node-pass.txt'));
    const pass = await until(async () => (await row('t_pass'))?.summary && (await row('t_pass')));
    check('passing-run-summary-names-skips-not-failures', pass?.summary === '5 tests, 1 skipped' && !pass.summaryRed, J(pass));
    check('passing-run-body-starts-closed', pass && pass.suites.length === 0, J(pass));
    await shot(s, path.join(OUT, 'passing-run-collapsed.png'));

    await run('t_trace', 'node trace.js', fixture('node-trace.txt'), true);
    const trace = await until(async () => (await row('t_trace'))?.frames.length && (await row('t_trace')));
    check('failed-command-links-app-frames', trace?.frames.length === 3 && trace.frames.some((f) => f.endsWith('trace.js:2')), J(trace?.frames));
    check('failed-command-folds-framework-runs-into-two-rows', trace?.folds.length === 2, J(trace?.folds));
    check('failed-command-is-not-a-test-run', trace && trace.summary === null, J(trace));
    await shot(s, path.join(OUT, 'failed-command-stack-trace.png'));

    await run('t_outside', 'node /opt/other/a.js', 'Error: boom\n    at run (/opt/other/a.js:3:9)\n    at /opt/other/b.js:1:1', true);
    const outside = await until(async () => (await row('t_outside'))?.text.includes('/opt/other/a.js:3') && (await row('t_outside')));
    check('frame-outside-the-project-is-plain-text', !!outside && outside.frames.length === 0, J(outside));

    await run('t_plain', 'git status', 'On branch main\nnothing to commit, working tree clean');
    await until(() => row('t_plain'));
    await tryClick('css=#row-t_plain button');
    const plain = await until(async () => (await row('t_plain'))?.pres.length === 1 && (await row('t_plain')));
    check('plain-output-renders-as-before', plain?.pres[0] === 'On branch main\nnothing to commit, working tree clean' && plain.summary === null, J(plain));
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
