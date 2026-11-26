#!/usr/bin/env node
/* A chat that changed agent, on the Board, end to end through
   handoff-harness.mjs: the real claude CLI against the stand-in API, the stub
   ACP agent as Copilot, Xvfb, a throwaway HOME.

   - A Claude -> Copilot chat is one card on the Board, drawn as Copilot, with
     no outside card for its Claude session; still so after a reload; and
     opening the card shows both stretches and the handoff row between them.
   - A pipeline whose gated first stage's chat is switched to Copilot while the
     run waits still advances: Continue sends the next stage into that chat,
     on Copilot, with the handoff, and the run finishes.
   Screenshots go to SHOT_DIR (default /tmp/handoff-verify/board). */
import { drive, safeBoot, watchNet, cleanupShims, providerAddresses, STUB_LOG } from './handoff-harness.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { stop, click, hover, key, type, shot, evaluate } = drive;
const SHOTS = process.env.SHOT_DIR || '/tmp/handoff-verify/board';
fs.mkdirSync(SHOTS, { recursive: true });

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` ${JSON.stringify(detail)?.slice(0, 600)}`}`);
  if (!ok) failures.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 30000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v || Date.now() > end) return v;
    await sleep(300);
  }
};
const J = JSON.stringify;

const log = path.join(os.tmpdir(), `fake-responses-${process.pid}.jsonl`);
const api = spawn(process.execPath, [path.join(ROOT, 'scripts/fake-responses-api.mjs'), log], { stdio: ['ignore', 'pipe', 'inherit'] });
const port = await new Promise((resolve) => api.stdout.on('data', (d) => { const m = /port (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));

const s = await safeBoot({ codexPort: port });
const net = watchNet(s, await providerAddresses());
console.log(`session ${s.dir}`);
const page = (expr) => evaluate(s, expr);
const main = (expr) => evaluate(s, expr, { main: true });
const send = async (text) => {
  await page("document.querySelector('#composer [contenteditable=\"true\"]').focus()");
  await type(s, text, { enter: true });
};
const waitText = (needle, ms = 60000) => until(() => page(`document.body.innerText.includes(${J(needle)})`), ms);
const pickCopilot = async () => {
  const at = await page(`(() => { const b = [...document.querySelectorAll('#composer button[data-slot=dropdown-menu-trigger]')].find((e) => /Opus|Sonnet|Haiku|Fable|GPT|Auto|Pick a model/.test(e.innerText)); const r = b.getBoundingClientRect(); return Math.round(r.x + r.width / 2) + ',' + Math.round(r.y + r.height / 2); })()`);
  await click(s, `xy=${at}`);
  await sleep(400);
  await hover(s, 'Copilot');
  await sleep(700);
  await key(s, 'Right');
  await sleep(300);
  await key(s, 'Enter');
  await sleep(2500);
};
const reload = async () => {
  await main("(() => { const w = electron.BrowserWindow.getAllWindows().find((w) => /index\\.html/.test(w.webContents.getURL())); w.webContents.reload(); return 1; })()");
  await sleep(7000);
};
const cards = () => page(`JSON.stringify([...document.querySelectorAll('[data-slot="board-card"]')].map((c) => ({ title: c.getAttribute('aria-label'), provider: c.dataset.provider || null, where: c.dataset.where, lane: c.dataset.lane })))`).then(JSON.parse);
const handoffRows = () => page("JSON.stringify([...document.querySelectorAll('[data-handoff]')].map((e) => e.getAttribute('aria-label')))").then(JSON.parse);
const stubSaid = () => (fs.existsSync(STUB_LOG) ? fs.readFileSync(STUB_LOG, 'utf8') : '');

try {
  await click(s, 'Later').catch(() => {});

  // A Claude chat moved to Copilot.
  await send('brd ALPHA');
  check('claude answers', !!(await waitText('heard: brd ALPHA')));
  await pickCopilot();
  await send('brd BRAVO');
  check('copilot answers', !!(await waitText('acp heard: brd BRAVO')));
  await sleep(2000);

  await page('window.connChat.board(true), 1');
  await until(async () => (await cards()).some((c) => c.title === 'brd ALPHA'), 15000);
  await sleep(2500); // a round of outside sessions from the CLI
  let all = await cards();
  let mine = all.filter((c) => c.title === 'brd ALPHA');
  check('the switched chat is one card, drawn as Copilot', mine.length === 1 && mine[0].provider === 'copilot', all);
  check('its Claude session is no outside card', !all.some((c) => c.where === 'outside' && /brd/.test(c.title || '')), all);
  await click(s, 'Later').catch(() => {});
  await shot(s, path.join(SHOTS, 'board-switched-card.png'));

  await reload();
  await page('window.connChat.board(true), 1');
  await until(async () => (await cards()).some((c) => c.title === 'brd ALPHA'), 15000);
  await sleep(2500);
  all = await cards();
  mine = all.filter((c) => c.title === 'brd ALPHA');
  check('after a reload it is still one card, drawn as Copilot', mine.length === 1 && mine[0].provider === 'copilot' && !all.some((c) => c.where === 'outside' && /brd/.test(c.title || '')), all);

  await click(s, 'css=[data-slot="board-card"][aria-label="brd ALPHA"]');
  await until(() => page("document.body.innerText.includes('brd BRAVO') && !document.querySelector('[data-slot=\"board-page\"]')"), 20000);
  await sleep(1500);
  const text = await page('document.body.innerText');
  check('opening the card shows every stretch, in order', text.indexOf('brd ALPHA') >= 0 && text.indexOf('brd ALPHA') < text.indexOf('brd BRAVO') && text.includes('acp heard: brd BRAVO'), text.slice(0, 400));
  check('with the handoff row between them', (await handoffRows()).some((l) => /Claude → Copilot/.test(l)), await handoffRows());
  await shot(s, path.join(SHOTS, 'board-switched-opened.png'));

  // A pipeline whose gated stage's chat is switched while the run waits.
  const dir = path.join(s.home, '.conn', 'pipelines');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'relay.yml'), [
    // Pinned to Claude: a new chat would otherwise follow the last pick, Copilot.
    'name: Relay', 'stages:', '  - id: draft', '    prompt: relay DRAFT', '    provider: claude', '    gate: true',
    '  - id: ship', '    prompt: "relay SHIP after {{draft}}"', '    same: draft', '',
  ].join('\n'));
  await page('window.connPipelines.open(), 1');
  await until(() => page(`!!document.querySelector('[data-slot="pipeline-option"][aria-label="Relay"]')`), 10000);
  await click(s, 'css=[data-slot="pipeline-option"][aria-label="Relay"]');
  await click(s, 'Start');
  const runCard = () => page(`(() => {
    const c = [...document.querySelectorAll('[data-slot="pipeline-run"]')].find((x) => x.getAttribute('aria-label') === 'Relay run');
    return c && JSON.stringify({ status: c.dataset.status, stages: Object.fromEntries([...c.querySelectorAll('[data-slot="pipeline-stage"]')].map((b) => [b.dataset.stage, b.dataset.status])) });
  })()`).then((v) => (v ? JSON.parse(v) : null));
  const gated = await until(async () => { const r = await runCard(); return r?.status === 'waiting' && r; }, 60000);
  check('the first stage runs on Claude and stops at its gate', !!gated && gated.stages.draft === 'gated', gated || await runCard());

  // Open the stage's chat and move it to Copilot while the run waits.
  await page('window.connChat.board(false), 1');
  await click(s, 'Relay · Draft');
  await waitText('heard: relay DRAFT', 20000);
  check('the stage ran on Claude', !(await page("document.body.innerText.includes('acp heard: relay DRAFT')")), 'it ran on Copilot');
  await pickCopilot();
  check('the stage chat switched to Copilot', (await handoffRows()).some((l) => /Claude → Copilot/.test(l)), await handoffRows());

  await page('window.connChat.board(true), 1');
  await until(() => page(`[...document.querySelectorAll('[data-slot="pipeline-run"][aria-label="Relay run"] button')].some((b) => b.innerText === 'Continue')`), 10000);
  // The run card's own Continue, by its label: the card has other buttons.
  await click(s, 'Continue');
  console.log(`NOTE after Continue: ${J(await runCard())}`);
  const done = await until(async () => { const r = await runCard(); return r?.status === 'done' && r; }, 90000);
  check('Continue still advances: the next stage runs in the switched chat and the run finishes', !!done && done.stages.ship === 'done', done || await runCard());
  const said = stubSaid();
  check('the next stage went to Copilot, with the handoff', /relay SHIP after/.test(said) && /conn-handoff/.test(said), said.slice(-400));
  await click(s, 'Later').catch(() => {});
  await shot(s, path.join(SHOTS, 'board-pipeline-advanced.png'));
} catch (e) {
  check('the run finished', false, e.stack);
} finally {
  const traffic = net.stop();
  check('no agent process reached the network, and nothing reached a provider', traffic.bad.length === 0, traffic.bad);
  if (!process.env.KEEP) await stop(s).catch(() => {});
  api.kill();
  fs.rmSync(log, { force: true });
  cleanupShims();
}

console.log(failures.length ? `\n${failures.length} failed: ${failures.join(', ')}` : '\nall passed');
process.exit(failures.length ? 1 : 0);
