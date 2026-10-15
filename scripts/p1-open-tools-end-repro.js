'use strict';
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

const SHOT = (name) => path.join(os.tmpdir(), `conn-open-tools-end-${name}.png`);
const INIT = { type: 'system', subtype: 'init', session_id: '7a7a7a7a-0000-4000-8000-000000000001', model: 'claude-haiku-4-5' };
const RESULT = { type: 'result', subtype: 'success', duration_ms: 1200 };
const call = (id, name, input) => ({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const back = (id, text) => ({
  type: 'user',
  parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
});

async function main() {
  const drive = await import(pathToFileURL(path.join(ROOT, '.claude/skills/verify/drive.mjs')).href);
  const { boot, stop, evaluate, click, key, say, shot } = drive;
  const s = await boot({ root: ROOT, xvfb: true });

  try {
    const emit = (msg) => evaluate(s, `globalThis.__agent.emit('message', ${J(msg)})`, { main: true });
    const row = (id) => evaluate(s, `(() => {
      const r = document.querySelector('#row-' + ${J(id)});
      if (!r) return null;
      return {
        shimmer: !!r.querySelector('[class*="bg-clip-text"]'),
        clock: /\\b\\d+:\\d\\d\\b/.test(r.innerText),
        failed: !!r.querySelector('.lucide-circle-alert'),
        text: r.innerText,
      };
    })()`);
    const agentRow = (id) => evaluate(s, `(() => {
      const r = document.querySelector('[data-subagent=' + ${J(J(id))} + ']');
      if (!r) return null;
      return { shimmer: !!r.querySelector('[class*="bg-clip-text"]'), clock: (r.innerText.match(/\\b\\d+:\\d\\d\\b/) || [null])[0], text: r.innerText };
    })()`);
    const until = async (fn, ms = 3000) => {
      const end = Date.now() + ms;
      let last;
      while (Date.now() < end && !(last = await fn())) await sleep(100);
      return last;
    };
    const rail = () => evaluate(s, `(() => {
      const r = [...document.querySelectorAll('[data-sidebar="menu-button"][data-activity]')].find((e) => e.title);
      return r ? { activity: r.dataset.activity, text: r.innerText } : null;
    })()`);

    await click(s, 'Later').catch(() => {});
    await say(s, 'Running the tests.', { open: true });

    await emit(call('toolu_stop', 'Bash', { command: 'npm test' }));
    await sleep(2500);
    const before = await row('toolu_stop');
    check('call-is-open-before-stop', before?.shimmer && before?.clock, J(before));

    await click(s, 'Stop');
    await sleep(3000);
    const stopped = await row('toolu_stop');
    await shot(s, SHOT('after-stop'));
    check('stop-ends-the-row', stopped && !stopped.shimmer && stopped.failed, J(stopped));
    check('stop-freezes-the-clock', stopped && !stopped.clock, J(stopped));
    check('stop-says-interrupted', /interrupted/.test(stopped?.text || ''), J(stopped));
    const r1 = await rail();
    check('rail-not-running-after-stop', r1 && r1.activity !== 'working' && !/Running/.test(r1.text), J(r1));

    await emit(INIT);
    await emit(call('toolu_a', 'Bash', { command: 'git status' }));
    await emit(call('toolu_b', 'Read', { file_path: path.join(s.project, 'index.html') }));
    await sleep(300);
    await emit(RESULT);
    await sleep(2500);
    const a = await row('toolu_a');
    const b = await row('toolu_b');
    await shot(s, SHOT('after-result'));
    for (const [name, r] of [['toolu_a', a], ['toolu_b', b]]) {
      check(`result-ends-${name}`, r && !r.shimmer && !r.clock && /interrupted/.test(r.text), J(r));
    }
    const r2 = await rail();
    check('rail-not-running-after-result', r2 && r2.activity !== 'working' && !/Running/.test(r2.text), J(r2));

    await emit(INIT);
    await emit(call('toolu_bg', 'Bash', { command: 'npm run dev', run_in_background: true }));
    await emit({ type: 'system', subtype: 'task_started', task_id: 'bg1', tool_use_id: 'toolu_bg', is_backgrounded: true });
    await emit(call('toolu_bgagent', 'Agent', { subagent_type: 'Explore', description: 'Survey the repo', run_in_background: true }));
    await emit({ ...back('toolu_bgagent', 'Async agent launched'), tool_use_result: { status: 'async_launched', agentId: 'a1' } });
    await emit({ type: 'system', subtype: 'task_started', task_id: 'agentB', tool_use_id: 'toolu_bgagent', description: 'Survey the repo', is_backgrounded: true });
    await emit({ ...call('toolu_bgchild', 'Grep', { pattern: 'coupon' }), parent_tool_use_id: 'toolu_bgagent' });
    await emit(call('toolu_fg', 'Agent', { subagent_type: 'general-purpose', description: 'Fix the lint' }));
    await emit({ type: 'system', subtype: 'task_started', task_id: 'agentA', tool_use_id: 'toolu_fg', description: 'Fix the lint', is_backgrounded: false });
    await emit({ ...call('toolu_fgchild', 'Bash', { command: 'npm run lint -- --fix' }), parent_tool_use_id: 'toolu_fg' });
    await emit(call('toolu_c', 'Bash', { command: 'npm run lint' }));
    await sleep(2500);
    const fgBefore = await agentRow('toolu_fg');
    check('foreground-agent-runs-before-stop', fgBefore?.shimmer && fgBefore.clock, J(fgBefore));

    await click(s, 'Stop');
    await sleep(1500);
    const bg = await row('toolu_bg');
    const c = await row('toolu_c');
    const fg = await agentRow('toolu_fg');
    await sleep(1500);
    const fgLater = await agentRow('toolu_fg');
    const bgAgent = await agentRow('toolu_bgagent');
    await shot(s, SHOT('background-kept'));
    check('background-command-keeps-its-state', bg?.shimmer && !bg.failed && !/interrupted/.test(bg.text), J(bg));
    check('stop-ends-the-turn-call-beside-it', c && !c.shimmer && /interrupted/.test(c.text), J(c));
    check('background-agent-keeps-running', bgAgent?.shimmer && /background/.test(bgAgent.text), J(bgAgent));
    check('stop-ends-the-foreground-agent', fg && !fg.shimmer && /stopped/.test(fg.text), J(fg));
    check('stop-freezes-the-foreground-agent-clock', fg && fgLater && fg.clock === fgLater.clock, `${J(fg)} then ${J(fgLater)}`);

    const step = async (agent, id) => {
      await click(s, `css=[data-subagent="${agent}"]`);
      const r = await until(() => row(id));
      await shot(s, SHOT(`steps-of-${agent}`));
      await key(s, 'Escape');
      await sleep(300);
      return r;
    };
    const bgStep = await step('toolu_bgagent', 'toolu_bgchild');
    check('background-agent-step-keeps-its-state', bgStep?.shimmer && !/interrupted/.test(bgStep.text), J(bgStep));
    const fgStep = await step('toolu_fg', 'toolu_fgchild');
    check('stop-ends-the-foreground-agent-step', fgStep && !fgStep.shimmer && /interrupted/.test(fgStep.text), J(fgStep));
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
