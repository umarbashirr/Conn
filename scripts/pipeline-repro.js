'use strict';
/* Pipelines, driven in a real window with the agent played by the verify
   stand-in. One run goes the whole way: launched from the palette, a plan
   that stops at its gate, a reply in the plan's chat before Continue (the
   next stage has to get the plan as it stood after that), a build, a fix that
   continues the build's chat, a failed turn and Retry. A second pipeline runs
   in a new worktree and is stopped. Then the window reloads and the runs are
   still there. A file with a mistake is listed with its reason.

   Needs a built renderer: `npx vite build` first. Screenshots go to
   PIPELINE_SHOTS (default the temp dir). */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = process.env.CONN_ROOT || path.join(__dirname, '..');
const SHOTS = process.env.PIPELINE_SHOTS || os.tmpdir();
const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
};

const FEATURE = `name: Feature
description: Plan, build and fix
input: What should be built?
stages:
  - id: plan
    prompt: |
      Plan this: {{input}}
    mode: plan
    gate: true
  - id: build
    prompt: |
      Implement this plan:
      {{plan}}
    mode: auto
  - id: fix
    prompt: "Fix whatever this left: {{build}}"
    same: build
`;

const SPIKE = `name: Spike
worktree: true
stages:
  - id: try
    prompt: Try the idea in a throwaway branch.
`;

const GATEKEEP = `name: Gatekeep
stages:
  - id: draft
    prompt: Draft it.
    gate: true
  - id: ship
    prompt: "Ship this: {{draft}}"
`;

const BROKEN = `name: Broken
stages:
  - id: a
    prompt: "Uses {{nothing}}"
`;

async function main() {
  const drive = await import(pathToFileURL(path.join(ROOT, '.claude/skills/verify/drive.mjs')).href);
  const { boot, stop, evaluate, click, key, type, say, shot } = drive;
  const s = await boot({ root: ROOT, xvfb: true });

  try {
    const js = (code) => evaluate(s, code);
    const until = async (fn, ms = 6000) => {
      const end = Date.now() + ms;
      let got;
      while (Date.now() < end && !(got = await fn())) await sleep(150);
      return got;
    };
    const runCard = (name) => js(`(() => {
      const c = [...document.querySelectorAll('[data-slot="pipeline-run"]')].find((x) => x.getAttribute('aria-label') === ${J(`${name} run`)});
      return c && { status: c.dataset.status, text: c.innerText, stages: Object.fromEntries([...c.querySelectorAll('[data-slot="pipeline-stage"]')].map((b) => [b.dataset.stage, b.dataset.status])) };
    })()`);
    const laneOf = (title) => js(`(() => {
      const c = [...document.querySelectorAll('[data-slot="board-card"]')].find((x) => x.getAttribute('aria-label') === ${J(title)});
      return c ? c.dataset.lane : null;
    })()`);
    const transcript = () => js(`document.querySelector('[role="log"]')?.innerText || ''`);
    const fail = () => evaluate(s, `globalThis.__agent.emit('message', { type: 'result', subtype: 'error_during_execution', is_error: true, duration_ms: 10 })`, { main: true });

    await click(s, 'Later').catch(() => {});
    const dir = path.join(s.home, '.conn', 'pipelines');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'feature.yml'), FEATURE);
    fs.writeFileSync(path.join(dir, 'spike.yml'), SPIKE);
    fs.writeFileSync(path.join(dir, 'broken.yml'), BROKEN);
    fs.writeFileSync(path.join(dir, 'gatekeep.yml'), GATEKEEP);

    // ---------------------------------------------------------- launching

    await key(s, 'Ctrl+K');
    await type(s, 'Run pipeline');
    await key(s, 'Enter');
    const dialog = await until(() => js(`!!document.querySelector('[data-slot="pipeline-dialog"]') && [...document.querySelectorAll('[data-slot="pipeline-option"]')].map((o) => ({ name: o.getAttribute('aria-label'), disabled: o.disabled, text: o.innerText }))`));
    check('the-palette-opens-run-pipeline', !!dialog, 'no dialog');
    check('every-file-is-listed', J((dialog || []).map((o) => o.name).sort()) === J(['Feature', 'Gatekeep', 'Spike', 'broken']), J(dialog));
    const broken = (dialog || []).find((o) => o.name === 'broken');
    check('a-broken-file-says-why-and-cannot-be-picked', !!broken && broken.disabled && /\{\{nothing\}\}/.test(broken.text), J(broken));
    check('stages-and-gates-are-listed', /Plan \(gate\) → Build → Fix/.test((dialog || []).find((o) => o.name === 'Feature')?.text || ''), J(dialog));

    await click(s, 'css=[data-slot="pipeline-option"][aria-label="Feature"]');
    check('start-waits-for-the-input', await js(`[...document.querySelectorAll('[data-slot="pipeline-dialog"] button')].find((b) => b.innerText === 'Start').disabled`), 'Start enabled with no input');
    await click(s, 'css=[aria-label="What should be built?"]');
    await type(s, 'Coupon stacking');
    await shot(s, path.join(SHOTS, 'pipeline-dialog.png'));
    await click(s, 'Start');

    const started = await until(async () => { const r = await runCard('Feature'); return r?.stages.plan === 'running' && r; });
    check('start-opens-the-board-with-the-run', !!started && await js(`!!document.querySelector('[data-slot="board-page"]')`), J(started));
    check('the-first-stage-runs-in-its-own-chat', (await laneOf('Feature · Plan')) === 'working', J(await laneOf('Feature · Plan')));
    check('the-stage-chat-is-in-the-rail-by-name', await js(`[...document.querySelectorAll('[data-sidebar="menu-button"]')].some((b) => b.innerText.includes('Feature · Plan'))`), 'not in rail');

    // ---------------------------------------------------------- the gate

    await say(s, '1. Add a stack flag\n2. Apply coupons in order');
    const gated = await until(async () => { const r = await runCard('Feature'); return r?.status === 'waiting' && r; });
    check('a-gate-stops-the-run', !!gated && gated.stages.plan === 'gated' && gated.stages.build === 'pending', J(gated || await runCard('Feature')));
    check('the-gated-chat-is-in-needs-you', !!(await until(async () => (await laneOf('Feature · Plan')) === 'needs')), J(await laneOf('Feature · Plan')));
    check('the-rail-badge-counts-the-gate', (await js(`document.querySelector('[data-slot="board-needs"]')?.innerText`)) === '1', 'badge');
    await shot(s, path.join(SHOTS, 'pipeline-gate.png'));

    // Talk the plan over before letting it go on.
    await click(s, 'css=[data-slot="pipeline-stage"][data-stage="plan"]');
    await until(async () => (await transcript()).includes('Add a stack flag'));
    await js('window.connChat.focusComposer()');
    await type(s, 'Keep it to one step');
    await key(s, 'Enter');
    await say(s, '1. Apply coupons in order, one flag');
    await key(s, 'Ctrl+Shift+M');
    await until(async () => (await runCard('Feature'))?.status === 'waiting');
    await click(s, 'css=[data-slot="pipeline-run"] [data-action="continue"]');
    const building = await until(async () => { const r = await runCard('Feature'); return r?.stages.build === 'running' && r; });
    check('continue-starts-the-next-stage', !!building && building.stages.plan === 'done', J(await runCard('Feature')));

    await click(s, 'css=[data-slot="pipeline-stage"][data-stage="build"]');
    const buildPrompt = await until(async () => { const t = await transcript(); return t.includes('Implement this plan') && t; });
    check('the-next-stage-gets-the-plan-as-it-stood-at-continue', !!buildPrompt && buildPrompt.includes('1. Apply coupons in order, one flag') && !buildPrompt.includes('Add a stack flag'), J(buildPrompt));

    // ---------------------------------------------------------- same: and failure

    await say(s, 'Built the stacking.');
    const fixing = await until(async () => (await transcript()).includes('Fix whatever this left: Built the stacking.'));
    check('a-same-stage-continues-the-earlier-chat', !!fixing, J(await transcript()));
    check('no-new-chat-for-a-same-stage', !(await js(`[...document.querySelectorAll('[data-sidebar="menu-button"]')].some((b) => b.innerText.includes('Feature · Fix'))`)), 'a Fix chat appeared');

    await fail();
    await key(s, 'Ctrl+Shift+M');
    const failed = await until(async () => { const r = await runCard('Feature'); return r?.status === 'failed' && r; });
    check('a-failed-turn-fails-the-run', !!failed && failed.stages.fix === 'failed' && /Failed/.test(failed.text), J(await runCard('Feature')));
    check('a-failed-run-offers-retry', /Retry/.test(failed?.text || ''), J(failed));
    await shot(s, path.join(SHOTS, 'pipeline-failed.png'));
    await click(s, 'css=[data-slot="pipeline-run"][data-status="failed"] [data-action="retry"]');
    const retried = await until(async () => { const r = await runCard('Feature'); return r?.stages.fix === 'running' && r; });
    check('retry-sends-the-stage-again', !!retried, J(await runCard('Feature')));
    await say(s, 'Fixed the edge case.');
    const done = await until(async () => { const r = await runCard('Feature'); return r?.status === 'done' && r; });
    check('the-last-stage-finishes-the-run', !!done && Object.values(done.stages).every((x) => x === 'done'), J(await runCard('Feature')));

    const runsDir = path.join(s.home, '.conn', 'runs');
    const onDisk = fs.readdirSync(runsDir).map((n) => JSON.parse(fs.readFileSync(path.join(runsDir, n), 'utf8')));
    check('the-run-is-written-to-disk', onDisk.length === 1 && onDisk[0].status === 'done' && onDisk[0].stages[0].output.includes('one flag'), J(onDisk.map((r) => r.status)));

    // ---------------------------------------------------------- a worktree, and Stop

    await click(s, 'Run pipeline');
    await until(() => js(`!!document.querySelector('[data-slot="pipeline-option"][aria-label="Spike"]')`));
    await click(s, 'css=[data-slot="pipeline-option"][aria-label="Spike"]');
    await click(s, 'Start');
    const spike = await until(async () => { const r = await runCard('Spike'); return r?.stages.try === 'running' && r; }, 15000);
    check('a-worktree-pipeline-starts', !!spike, J(await runCard('Spike')));
    const trees = fs.existsSync(path.join(s.project, '.claude', 'worktrees')) ? fs.readdirSync(path.join(s.project, '.claude', 'worktrees')) : [];
    check('it-runs-in-a-new-worktree', trees.length === 1 && /^spike-[a-z0-9]{4}$/.test(trees[0]), J(trees));
    check('its-card-names-the-worktree', (await js(`[...document.querySelectorAll('[data-slot="board-card"]')].find((c) => c.getAttribute('aria-label') === 'Spike · Try')?.innerText || ''`)).includes(trees[0] || '?'), 'no worktree on the card');
    await click(s, 'css=[data-slot="pipeline-run"][data-status="running"] [data-action="stop"]');
    const stopped = await until(async () => { const r = await runCard('Spike'); return r?.status === 'stopped' && r; });
    check('stop-stops-the-run', !!stopped && /Retry/.test(stopped.text), J(await runCard('Spike')));
    await shot(s, path.join(SHOTS, 'pipeline-runs.png'));

    // ---------------------------------------------------------- after a worktree run

    // The window is on the Spike worktree now. The next run still defaults to
    // the checkout it was cut from.
    await click(s, 'Run pipeline');
    await until(() => js(`!!document.querySelector('[data-slot="pipeline-dialog"] select')`));
    const folderPicked = await js(`document.querySelector('[data-slot="pipeline-dialog"] select').value`);
    check('the-dialog-defaults-to-the-checkout-not-a-runs-worktree', folderPicked === s.project, J(folderPicked));
    await click(s, 'css=[data-slot="pipeline-option"][aria-label="Gatekeep"]');
    await key(s, 'Ctrl+Enter');
    check('ctrl-enter-starts-a-pipeline-with-no-question', !!(await until(async () => (await runCard('Gatekeep'))?.stages.draft === 'running')), J(await runCard('Gatekeep')));

    // Stop at a gate, then Retry: back at the gate, the stage not asked again.
    await say(s, 'Draft one.');
    await until(async () => (await runCard('Gatekeep'))?.status === 'waiting');
    await click(s, 'css=[data-slot="pipeline-run"][aria-label="Gatekeep run"] [data-action="stop"]');
    await until(async () => (await runCard('Gatekeep'))?.status === 'stopped');
    await click(s, 'css=[data-slot="pipeline-run"][aria-label="Gatekeep run"] [data-action="retry"]');
    const regated = await until(async () => { const r = await runCard('Gatekeep'); return r?.status === 'waiting' && r; });
    check('retry-after-a-stop-at-a-gate-goes-back-to-the-gate', !!regated && regated.stages.draft === 'gated', J(await runCard('Gatekeep')));

    // Delete the chat a stage is running in, from the rail's own menu: the
    // run fails there rather than spinning on a turn that can never end.
    await click(s, 'css=[data-slot="pipeline-run"][aria-label="Gatekeep run"] [data-action="continue"]');
    await until(async () => (await runCard('Gatekeep'))?.stages.ship === 'running');
    await key(s, 'Escape');
    await until(() => js(`!document.querySelector('[data-slot="board-page"]')`));
    const menu = await js(`(() => {
      const row = [...document.querySelectorAll('[data-sidebar="menu-button"]')].find((b) => b.innerText.includes('Gatekeep · Ship'));
      if (!row) return false;
      const r = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 8, button: 2 }));
      return true;
    })()`);
    check('the-stage-chat-is-in-the-rail', menu, 'no Gatekeep · Ship row');
    await click(s, 'css=[role="menuitem"][data-variant="destructive"]');
    await click(s, 'css=[role="dialog"] [data-slot="dialog-footer"] button:last-child');
    await key(s, 'Ctrl+Shift+M');
    const closedUnder = await until(async () => { const r = await runCard('Gatekeep'); return r?.status === 'failed' && r; });
    check('deleting-a-running-stages-chat-fails-the-run', !!closedUnder && /chat was closed/.test(closedUnder.text), J(await runCard('Gatekeep')));

    // ---------------------------------------------------------- after a reload

    // Two run files no run could have written: cut short, and hand-edited.
    fs.writeFileSync(path.join(runsDir, 'run-garbage2.json'), J({ id: 'run-garbage2', stages: [null, 5], pipeline: {}, status: 'running' }));
    const one = JSON.parse(fs.readFileSync(path.join(runsDir, fs.readdirSync(runsDir)[0]), 'utf8'));
    fs.writeFileSync(path.join(runsDir, 'run-notime1.json'), J({ ...one, id: 'run-notime1', at: undefined, startedAt: undefined }));

    // The page itself refuses location.reload(), so main reloads it, which
    // throws away everything the renderer held. What comes back is from disk.
    await evaluate(s, `electron.BrowserWindow.getAllWindows().find((w) => /index\\.html/.test(w.webContents.getURL())).webContents.reload()`, { main: true });
    await sleep(1500);
    await until(() => js('!!window.connChat && !!window.connPipelines').catch(() => false), 10000);
    await key(s, 'Ctrl+Shift+M');
    const after = await until(async () => {
      const f = await runCard('Feature');
      const k = await runCard('Spike');
      return f && k && { f, k };
    }, 10000);
    check('runs-survive-a-reload', !!after && after.f.status === 'done' && after.k.status === 'stopped', J(after));
    check('bad-run-files-are-skipped-not-fatal', (await js(`document.querySelectorAll('[data-slot="pipeline-run"]').length`)) === 3
      && await js(`!!document.querySelector('[data-slot="board-lanes"]')`), J(await js(`document.querySelectorAll('[data-slot="pipeline-run"]').length`)));
    await click(s, 'css=[aria-label="Put away the Feature run"]');
    const featureFile = onDisk[0].id;
    check('a-finished-run-can-be-put-away', !!(await until(async () => !(await runCard('Feature'))))
      && !fs.existsSync(path.join(runsDir, `${featureFile}.json`)), J(fs.readdirSync(runsDir)));
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
