'use strict';
/* Finished tool rows keep what they did. A call that ran 2s or more keeps its
   duration, the label turns past tense once it lands, a folded run shows its
   total and opens once on a failure, a finished plan folds to its header, and
   a web search shows its query. Needs a built renderer: `npx vite build`. */
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
    const text = (sel) => evaluate(s, `document.querySelector(${J(sel)})?.innerText ?? null`);
    const snap = (name) => shot(s, path.join(OUT, name));
    const run = async (id, name, input, output, { isError = false, ms = 0 } = {}) => {
      await emit(call(id, name, input));
      if (ms) await sleep(ms);
      await emit(back(id, output, isError));
    };

    await click(s, 'Later').catch(() => {});

    await say(s, 'Starting.', { open: true });
    await emit(call('t_live', 'Bash', { command: 'sleep 9' }));
    const live = await until(async () => (await text('#row-t_live'))?.includes('sleep 9') && (await text('#row-t_live')));
    check('running-bash-reads-present-tense', /^Running\b/.test(live || ''), J(live));
    await emit(back('t_live', 'ok'));

    await say(s, 'Slow one.', { open: true });
    await run('t_slow', 'Bash', { command: 'npm test' }, 'ok', { ms: 2400 });
    const slow = await until(async () => (await text('#row-t_slow'))?.startsWith('R') && (await text('#row-t_slow')));
    check('finished-bash-reads-past-tense', /^Ran\b/.test(slow || ''), J(slow));
    check('slow-call-keeps-its-duration', /0:0[2-3]/.test(slow || ''), J(slow));
    await snap('slow-call-keeps-duration.png');

    await say(s, 'Fast one.', { open: true });
    await run('t_fast', 'Read', { file_path: '/p/src/a.js' }, 'x');
    const fast = await until(async () => (await text('#row-t_fast')) && (await text('#row-t_fast')));
    check('finished-read-reads-past-tense', /^Read\b/.test(fast || ''), J(fast));
    check('fast-call-shows-no-duration', !/\d:\d\d/.test(fast || ''), J(fast));

    await say(s, 'Search.', { open: true });
    await run('t_web', 'WebSearch', { query: 'electron asar format' }, 'results');
    const web = await until(async () => (await text('#row-t_web')) && (await text('#row-t_web')));
    check('web-search-shows-its-query', /^Searched\s+electron asar format/.test(web || ''), J(web));

    await say(s, 'A run.', { open: true });
    await run('r1', 'Read', { file_path: '/p/a.js' }, 'a', { ms: 700 });
    await run('r2', 'Read', { file_path: '/p/b.js' }, 'b', { ms: 700 });
    await run('r3', 'Bash', { command: 'npm run lint' }, 'ERR lint failed', { isError: true, ms: 700 });
    await run('r4', 'Read', { file_path: '/p/c.js' }, 'c', { ms: 700 });
    await run('r5', 'Read', { file_path: '/p/d.js' }, 'd');
    const strip = '[title="Fold these back into one line"], [title="Show each call"]';
    const opened = await until(async () => (await text('#agent-root'))?.includes('ERR lint failed'));
    check('run-with-a-failure-opens-once', !!opened, 'failed row not visible');
    const header = await evaluate(s, `document.querySelector(${J(strip)})?.innerText ?? null`);
    check('open-run-shows-its-total', /0:0[2-4]/.test(header || ''), J(header));
    check('open-run-keeps-the-failed-badge', /1 failed/.test(header || ''), J(header));
    await snap('failed-run-opens.png');
    await click(s, `css=${strip}`);
    const shut = await until(async () => !(await text('#agent-root')).includes('ERR lint failed'));
    check('toggling-the-run-closed-sticks', !!shut, 'still open');
    await run('r6', 'Bash', { command: 'npm run lint' }, 'ERR again', { isError: true });
    await sleep(600);
    check('a-later-failure-does-not-reopen-it', !(await text('#agent-root')).includes('ERR lint failed'), 'reopened');
    await snap('failed-run-stays-closed.png');

    await say(s, 'Plan.', { open: true });
    const todos = (...st) => ({ todos: st.map((status, i) => ({ content: `Step number ${i + 1}`, status, activeForm: `Doing ${i + 1}` })) });
    await emit(call('p1', 'TodoWrite', todos('completed', 'in_progress', 'pending')));
    const planHeight = () => evaluate(s, `document.querySelector('[data-plan-row]')?.getBoundingClientRect().height ?? 0`);
    const openH = await until(async () => (await planHeight()) > 60 && (await planHeight()));
    check('plan-with-work-left-is-open', !!openH, J(await planHeight()));
    await emit(call('p2', 'TodoWrite', todos('completed', 'completed', 'completed')));
    const folded = await until(async () => (await planHeight()) > 0 && (await planHeight()) < 40 && (await planHeight()));
    check('finished-plan-folds-to-its-header', !!folded, J(await planHeight()));
    check('finished-plan-header-counts', /3 of 3 done/.test(await text('[data-plan-row]')), J(await text('[data-plan-row]')));
    await snap('finished-plan-folded.png');
    await click(s, 'css=[data-plan-row] button');
    check('clicking-reopens-a-finished-plan', !!(await until(async () => (await planHeight()) > 60)), J(await planHeight()));
    await emit(call('p3', 'TodoWrite', todos('completed', 'completed', 'completed')));
    await sleep(500);
    check('a-manual-plan-toggle-sticks', (await planHeight()) > 60, J(await planHeight()));
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
