#!/usr/bin/env node
/* Many switches in mixed orders, each checked the same way: the switch reaches
   main as an agent:setSegments write with every session in it, and the rail
   still shows one row per chat. Covers a fresh chat, a chat reopened from the
   rail, a fork, a fork reopened and switched, and Copilot (which, in this
   harness, answers through the verify skill's stand-in API). Ends with a true
   restart: the app quits and is launched again on the same HOME, on a private
   Xvfb display, and the rail, the order and the handoff rows must match.

   Needs `npx vite build`, claude, codex and copilot on PATH, Xvfb. Same shims
   as handoff-switch-e2e-repro.mjs. SHOT_DIR names the screenshot folder. */
import { drive, safeBoot, watchNet, cleanupShims, providerAddresses } from './handoff-harness.mjs';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { boot, stop, click, hover, key, type, shot, evaluate } = drive;
const SHOTS = process.env.SHOT_DIR || '/tmp/handoff-verify/r2';
fs.mkdirSync(SHOTS, { recursive: true });

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` ${JSON.stringify(detail)?.slice(0, 500)}`}`);
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

const log = path.join(os.tmpdir(), `fake-responses-${process.pid}.jsonl`);
const api = spawn(process.execPath, [path.join(ROOT, 'scripts/fake-responses-api.mjs'), log], { stdio: ['ignore', 'pipe', 'inherit'] });
const port = await new Promise((resolve) => api.stdout.on('data', (d) => { const m = /port (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));

const s = await safeBoot({ codexPort: port });
const net = watchNet(s, await providerAddresses());
console.log(`session ${s.dir}`);
const page = (expr) => evaluate(s, expr);
const main = (expr) => evaluate(s, expr, { main: true });
const segmentsOnDisk = () => {
  try { return JSON.parse(fs.readFileSync(path.join(s.home, '.conn/chat-segments.json'), 'utf8')); } catch { return {}; }
};
const railRows = async () => {
  await page('window.connRail?.refresh()');
  await sleep(1500);
  return JSON.parse(await page("JSON.stringify([...document.querySelectorAll('li[data-sidebar=menu-item]')].map((e) => e.innerText.split('\\n')[0]))")).filter((r) => !['New chat', 'Search', 'Board', 'Check for updates', 'Customize', 'Usage'].includes(r));
};
const handoffRows = () => page("JSON.stringify([...document.querySelectorAll('[data-handoff]')].map((e) => e.getAttribute('aria-label')))").then(JSON.parse);
const reload = async () => {
  await main("(() => { const w = electron.BrowserWindow.getAllWindows().find((w) => /index\\.html/.test(w.webContents.getURL())); w.webContents.reload(); return 1; })()");
  await sleep(7000);
};
const send = async (text) => {
  await page("document.querySelector('#composer [contenteditable=\"true\"]').focus()");
  await type(s, text, { enter: true });
};
const has = (needle) => page(`document.body.innerText.includes(${JSON.stringify(needle)})`);
const waitReply = (needle, ms) => until(() => has(needle), ms);
const openPicker = async () => {
  const at = await page(`(() => { const b = [...document.querySelectorAll('#composer button[data-slot=dropdown-menu-trigger]')].find((e) => /Opus|Sonnet|Haiku|Fable|GPT|Auto|Pick a model/.test(e.innerText)); const r = b.getBoundingClientRect(); return Math.round(r.x + r.width / 2) + ',' + Math.round(r.y + r.height / 2); })()`);
  await click(s, `xy=${at}`);
  await sleep(400);
};
const CODEX = 'Fast, go-to model for coding and everyday work.';
const CLAUDE = 'Best for everyday, complex tasks';
const pick = async (provider) => {
  await openPicker();
  await hover(s, provider === 'codex' ? 'ChatGPT' : provider === 'copilot' ? 'Copilot' : 'Claude');
  await sleep(700);
  if (provider === 'copilot') {
    // The first row of Copilot's list, "Auto", by keyboard: its label also names the effort pill.
    await key(s, 'Right');
    await sleep(300);
    await key(s, 'Enter');
  } else {
    if (provider === 'codex') await click(s, CODEX);
    else { await key(s, 'Right'); await sleep(300); await key(s, 'Enter'); }
  }
  await sleep(2500);
};
const reply = (provider, text) => (provider === 'codex' ? `codex heard: ${text}` : `heard: ${text}`);
const openRow = async (title, nth = 0) => {
  const at = await page(`(() => { const li = [...document.querySelectorAll('li[data-sidebar=menu-item]')].filter((e) => e.innerText.split('\\n')[0] === ${JSON.stringify(title)}); const r = li[${nth}].getBoundingClientRect(); return Math.round(r.x + 60) + ',' + Math.round(r.y + r.height / 2); })()`);
  await click(s, `xy=${at}`);
  await sleep(6000);
};
const writes = () => main('JSON.stringify(globalThis.__segWrites || [])').then(JSON.parse);

let expectedRows = 0;
let n = 0;
// One switch: pick, send, wait for the answer, then confirm the write and the rail.
async function sw(provider, text, label) {
  n += 1;
  const before = (await writes()).length;
  await pick(provider);
  const pending = (await handoffRows()).at(-1) || '';
  await send(text);
  const answered = await waitReply(reply(provider, text), provider === 'copilot' ? 60000 : 30000);
  await sleep(1500);
  const after = await writes();
  const last = after.at(-1);
  const rows = await railRows();
  check(`switch ${n} (${label}): answered`, !!answered, { text, pending });
  check(`switch ${n} (${label}): agent:setSegments arrived with every session`, after.length > before && last?.segments?.every((x) => x.session) && last.segments.at(-1).provider === provider, { before, after: after.slice(before) });
  check(`switch ${n} (${label}): rail has one row per chat`, rows.length === expectedRows, { expectedRows, rows });
  await shot(s, path.join(SHOTS, `switch-${String(n).padStart(2, '0')}.png`));
}

let restarted = null;
try {
  fs.mkdirSync(path.join(s.home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(s.home, '.codex/config.toml'), [
    'model_provider = "fake"', '', '[model_providers.fake]', 'name = "fake"',
    `base_url = "http://127.0.0.1:${port}/v1"`, 'wire_api = "responses"', 'request_max_retries = 0', 'stream_max_retries = 0', '',
    '[features]', 'plugins = false', '', // codex's plugin sync would reach github.com and chatgpt.com: see handoff-harness.mjs
  ].join('\n'));
  const shim = "(() => { req('./codex-history').close(); const { Driver } = req('./driver'); const orig = Driver.prototype.current; Driver.prototype.current = function (o) { const r = orig.call(this, o); return r.models.length ? r : { ...r, models: [{ value: 'claude-opus-5-5', displayName: 'Opus 5.5 (stand-in)' }] }; }; const store = req('./chat-segments'); const set = store.set; globalThis.__segWrites = []; store.set = function (head, segments) { globalThis.__segWrites.push({ at: Date.now(), head, segments }); return set.call(this, head, segments); }; return 1; })()";
  await main(shim);
  await click(s, 'Later').catch(() => {});

  const only = !!process.env.ONLY_RESTART;
  if (only) {
    // Just enough for the restart: Claude, ChatGPT, Claude.
    await send('one ALPHA');
    await waitReply('heard: one ALPHA');
    expectedRows = 1;
    await sw('codex', 'one BRAVO', 'fresh, Claude to ChatGPT');
    await sw('claude', 'one CHARLIE', 'fresh, back to Claude');
  } else {
  // Chat one: a fresh chat through four agents.
  await send('one ALPHA');
  await waitReply('heard: one ALPHA');
  expectedRows = 1;
  await sw('codex', 'one BRAVO', 'fresh, Claude to ChatGPT');
  await sw('claude', 'one CHARLIE', 'fresh, back to Claude');
  await sw('copilot', 'one DELTA', 'fresh, Claude to Copilot');
  await sw('codex', 'one ECHO', 'fresh, Copilot to ChatGPT');

  // Reopened from the rail, then switched.
  await reload();
  await openRow('one ALPHA');
  await sw('claude', 'one FOXTROT', 'reopened, ChatGPT to Claude');

  // Chat two: starts on ChatGPT, switched, reopened, switched to Copilot.
  await click(s, 'New chat');
  await sleep(800);
  await openPicker();
  await hover(s, 'ChatGPT');
  await sleep(700);
  await click(s, CODEX);
  await sleep(1500);
  await send('two GOLF');
  await waitReply('codex heard: two GOLF');
  expectedRows = 2;
  await sw('claude', 'two HOTEL', 'fresh, ChatGPT to Claude');
  await reload();
  await openRow('two GOLF');
  await sw('copilot', 'two INDIA', 'reopened, Claude to Copilot');

  // A fork of chat one onto Claude, then switched twice.
  await reload();
  await openRow('one ALPHA');
  await openPicker();
  await hover(s, 'Fork to a New Chat');
  await sleep(800);
  await click(s, CLAUDE);
  await sleep(2000);
  await send('fork JULIET');
  await waitReply('fork JULIET');
  // The stand-in runs carried script lines too, so wait on the row instead of a reply text.
  await until(async () => !(await page("!!document.querySelector('#composer button[aria-label=Stop]')")), 60000);
  await sleep(2000);
  expectedRows = 3;
  check('the fork is its own row', (await railRows()).length === 3, await railRows());
  await sw('codex', 'fork KILO', 'fork, Claude to ChatGPT');
  await sw('claude', 'fork LIMA', 'fork, back to Claude');
  await reload();
  // The fork has chat one's title and is the newer of the two.
  await openRow('one ALPHA', 0);
  await shot(s, path.join(SHOTS, 'fork-reopened.png'));
  const forkText = await page('document.body.innerText');
  const forkOrder = ['one ALPHA', 'fork JULIET', 'fork KILO', 'fork LIMA'].map((t) => forkText.indexOf(t));
  check('a reopened fork, switched twice, shows its carried rows and every stretch in order', forkOrder.every((x, i) => x >= 0 && (i === 0 || x > forkOrder[i - 1])), forkOrder);
  check('a reopened fork still reads as a fork', (await handoffRows()).some((l) => /^Forked from/.test(l)), await handoffRows());
  await sw('codex', 'fork MIKE', 'reopened fork, Claude to ChatGPT');

  // A plain Claude chat, reopened, switched; then a fresh Copilot chat to Claude.
  await click(s, 'New chat');
  await sleep(800);
  await openPicker();
  await hover(s, 'Claude');
  await sleep(700);
  await click(s, CLAUDE);
  await sleep(1500);
  await send('three NOVEMBER');
  await waitReply('heard: three NOVEMBER');
  expectedRows = 4;
  await reload();
  await openRow('three NOVEMBER');
  await sw('codex', 'three OSCAR', 'reopened plain, Claude to ChatGPT');

  await click(s, 'New chat');
  await sleep(800);
  await pick('copilot');
  await send('four PAPA');
  await waitReply('heard: four PAPA', 60000);
  await sleep(2000);
  expectedRows = 5;
  await sw('claude', 'four QUEBEC', 'fresh, Copilot to Claude');

  }

  // True restart: quit, launch again on the same HOME and user data.
  await reload();
  const beforeRows = await railRows();
  await openRow('one ALPHA', only ? 0 : 1);
  const beforeHandoffs = await handoffRows();
  const beforeText = await page('document.body.innerText');
  await shot(s, path.join(SHOTS, 'before-restart.png'));
  restarted = await restart(s);
  const afterRows = await railRows();
  check('after a restart the rail has the same rows', JSON.stringify(afterRows) === JSON.stringify(beforeRows), { beforeRows, afterRows });
  await openRow('one ALPHA', only ? 0 : 1);
  const afterHandoffs = await handoffRows();
  const afterText = await page('document.body.innerText');
  const order = (t) => (only ? ['one ALPHA', 'one BRAVO', 'one CHARLIE'] : ['one ALPHA', 'one BRAVO', 'one CHARLIE', 'one DELTA', 'one ECHO', 'one FOXTROT']).map((w) => t.lastIndexOf(w));
  check('after a restart the switched chat is in order', order(afterText).every((x, i, a) => x > 0 && (i === 0 || x > a[i - 1])), order(afterText));
  check('after a restart the handoff rows read the same', JSON.stringify(afterHandoffs) === JSON.stringify(beforeHandoffs), { beforeHandoffs, afterHandoffs });
  void beforeText;
  console.log(`NOTE handoff rows after restart: ${JSON.stringify(afterHandoffs)}`);
  // The relaunched process lacks boot's preview helper, so the pane is left out.
  await shot(s, path.join(SHOTS, 'after-restart.png'), { preview: false });
} catch (e) {
  check('the run finished', false, e.stack);
} finally {
  const off = net.stop();
  check('no agent and no provider API was reached off the machine', !off.bad.length, off.bad);
  console.log(`NOTE the app's own traffic off the machine (update checks, model download): ${JSON.stringify(off.app.map((x) => x.peer))}`);
  if (!process.env.KEEP) await stop(s).catch((e) => console.log(`NOTE stop failed: ${e.message}`));
  api.kill();
  cleanupShims();
  fs.rmSync(log, { force: true });
}

/* Quit the app the way a person does and launch it again with the same
   command line and environment, on an Xvfb display of our own (the one boot
   started dies with the first process). The session file is pointed at the new
   process so the driver keeps working and `stop` still finds it. */
async function restart(sess) {
  const electronPid = Number(await main('process.pid'));
  // The live environment, from inside the process: /proc/<pid>/environ is
  // clobbered by Chromium's process title and reads back empty.
  const env = JSON.parse(await main('JSON.stringify(process.env)'));
  // Never launch against anything but this session's own HOME.
  if (!String(env.HOME || '').startsWith(sess.dir) || !String(env.CONN_CWD || '').startsWith(sess.dir)) {
    throw new Error(`refusing to relaunch: HOME=${env.HOME} CONN_CWD=${env.CONN_CWD} is not under ${sess.dir}`);
  }
  await main('setTimeout(() => electron.app.quit(), 100), 1').catch(() => {});
  await until(async () => !fs.existsSync(`/proc/${electronPid}`), 30000);
  await sleep(1500);
  const electron = createRequire(path.join(ROOT, 'package.json'))('electron');
  const args = ['--inspect=0', ROOT, '--remote-debugging-port=0', `--user-data-dir=${sess.userData}`, '--no-sandbox',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling'];
  const logFile = path.join(sess.dir, 'app.log');
  fs.rmSync(path.join(sess.userData, 'DevToolsActivePort'), { force: true });
  const out = fs.openSync(logFile, 'a');
  const startLen = fs.statSync(logFile).size;
  delete env.XAUTHORITY;
  delete env.DISPLAY;
  // On a hidden display of its own, the way boot launches it; the harness
  // checks HOME, CONN_CWD and PATH again before this spawn.
  const child = spawn('xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24', electron, ...args], { detached: true, stdio: ['ignore', out, out], env });
  child.unref();
  const tail = () => fs.readFileSync(logFile, 'utf8').slice(startLen);
  sess.inspect = Number(await until(async () => /Debugger listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(tail())?.[1], 30000));
  sess.cdp = Number(await until(async () => fs.readFileSync(path.join(sess.userData, 'DevToolsActivePort'), 'utf8').split('\n')[0], 30000));
  sess.pid = child.pid;
  fs.writeFileSync(path.join(sess.dir, 'session.json'), JSON.stringify(sess));
  await until(() => page('!!window.connChat'), 45000);
  // boot installs these helpers for click/type; a relaunched process has none.
  await main("(() => { const win = () => electron.BrowserWindow.getAllWindows().find((w) => /index\\.html/.test(w.webContents.getURL())); globalThis.__decided = []; globalThis.__bounds = []; globalThis.__floatBox = () => null; globalThis.__floatFocused = () => false; globalThis.__focusView = () => win()?.webContents.focus(); return 1; })()");
  await main('electron.BrowserWindow.getAllWindows()[0].setContentSize(1440, 900)');
  await sleep(6000);
  console.log(`restarted pid=${child.pid}`);
  void execFileSync;
  return {};
}

console.log(failures.length ? `\n${failures.length} failed: ${failures.join(', ')}` : '\nall passed');
process.exit(failures.length ? 1 : 0);
