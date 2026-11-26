#!/usr/bin/env node
/* Live checks for the second round of switch fixes, on the safe harness (stub
   ACP agents, local stand-ins for Claude and Codex, Xvfb, throwaway HOME).

   D  A switch refused because a turn started on the old CLI while main was
      answering: the old CLI's next session starts on the model the chat had.
   F  Enter twice while a long chat's earlier transcript is read in ahead of a
      handoff: the handoff goes once, with the chat's first message in it.
   A  Picks name their CLI: from a Copilot chat, ChatGPT's GPT-6.2-Sol moves
      the chat to Codex; in the fork menu, by mouse, ChatGPT's row forks onto
      Codex and Copilot's same-named row onto Copilot.
   R  A true restart: a reopened fork still draws its carried rows, and a
      switched chat's segments come back with a window size.

   STUB_ACP_INIT_MS (default 4000) slows the stub's initialize so a switch to
   it takes seconds. SHOT_DIR names the screenshot folder. */
import { drive, safeBoot, watchNet, cleanupShims, providerAddresses, STUB_LOG, assertSafeEnv } from './handoff-harness.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

process.env.STUB_ACP_INIT_MS ||= '4000';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { stop, click, hover, key, type, shot, evaluate } = drive;
const SHOTS = process.env.SHOT_DIR || '/tmp/handoff-verify/r3';
fs.mkdirSync(SHOTS, { recursive: true });
const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` ${JSON.stringify(detail)?.slice(0, 700)}`}`);
  if (!ok) failures.push(name);
};
const note = (what, v) => console.log(`NOTE ${what}: ${JSON.stringify(v)?.slice(0, 700)}`);
// ONLY=F (or D, A, R, comma separated) runs just those parts.
const only = (part) => !process.env.ONLY || process.env.ONLY.split(',').includes(part);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 30000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v || Date.now() > end) return v;
    await sleep(250);
  }
};

const log = path.join(os.tmpdir(), `fake-responses-${process.pid}.jsonl`);
const api = spawn(process.execPath, [path.join(ROOT, 'scripts/fake-responses-api.mjs'), log], { stdio: ['ignore', 'pipe', 'inherit'] });
const port = await new Promise((resolve) => api.stdout.on('data', (d) => { const m = /port (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));
const s = await safeBoot({ codexPort: port });
const net = watchNet(s, await providerAddresses());
console.log(`session ${s.dir}`);
const page = (e) => evaluate(s, e);
const main = (e) => evaluate(s, e, { main: true });
const codexUsers = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [])
  .map((r) => (r.body?.input || []).filter((m) => m.role === 'user').at(-1)?.content?.map((c) => c.text).join('\n') || '');
const stubPrompts = () => (fs.existsSync(STUB_LOG) ? fs.readFileSync(STUB_LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []).filter((e) => e.method === 'session/prompt');
const segments = () => { try { return JSON.parse(fs.readFileSync(path.join(s.home, '.conn/chat-segments.json'), 'utf8')); } catch { return {}; } };
const rows = async () => {
  await page('window.connRail?.refresh()');
  await sleep(1500);
  return JSON.parse(await page("JSON.stringify([...document.querySelectorAll('li[data-sidebar=menu-item]')].map((e) => e.innerText.split('\\n')[0]))")).filter((r) => !['New chat', 'Search', 'Check for updates', 'Customize', 'Usage'].includes(r));
};
const handoffs = () => page("JSON.stringify([...document.querySelectorAll('[data-handoff]')].map((e) => e.getAttribute('aria-label')))").then(JSON.parse);
const has = (t) => page(`document.body.innerText.includes(${JSON.stringify(t)})`);
const reload = async () => {
  await main("(() => { const w = electron.BrowserWindow.getAllWindows().find((w) => /index\\.html/.test(w.webContents.getURL())); w.webContents.reload(); return 1; })()");
  await sleep(7000);
};
const focus = () => page("document.querySelector('#composer [contenteditable=\"true\"]').focus()");
const send = async (t) => { await focus(); await type(s, t, { enter: true }); };
const trigger = () => page(`(() => { const b = [...document.querySelectorAll('#composer button[data-slot=dropdown-menu-trigger]')].find((e) => /Opus|Sonnet|Haiku|Fable|GPT|Auto|Stub|Pick a model/.test(e.innerText)); const r = b.getBoundingClientRect(); return Math.round(r.x + r.width / 2) + ',' + Math.round(r.y + r.height / 2); })()`);
const openPicker = async () => { await click(s, `xy=${await trigger()}`); await sleep(400); };
const CODEX = 'Fast, go-to model for coding and everyday work.';
const pick = async (provider) => {
  await openPicker();
  await hover(s, provider === 'codex' ? 'ChatGPT' : provider === 'copilot' ? 'Copilot' : 'Claude');
  await sleep(700);
  if (provider === 'copilot') { await key(s, 'Right'); await sleep(300); await key(s, 'Enter'); }
  else if (provider === 'codex') await click(s, CODEX);
  else await click(s, 'Best for everyday, complex tasks', { wait: 1500 }).catch(() => click(s, 'Opus 5.5 (stand-in)'));
};
const newChat = async () => { await click(s, 'New chat'); await sleep(800); };
const openRow = async (title, nth = 0) => {
  const at = await page(`(() => { const li = [...document.querySelectorAll('li[data-sidebar=menu-item]')].filter((e) => e.innerText.split('\\n')[0] === ${JSON.stringify(title)}); const r = li[${nth}].getBoundingClientRect(); return Math.round(r.x + 60) + ',' + Math.round(r.y + r.height / 2); })()`);
  await click(s, `xy=${at}`);
  await sleep(6000);
};
const turnEnded = () => page("document.body.innerText.split('\\n').filter((l) => /^(done in |turn ended)/.test(l)).length");
const idle = () => until(async () => !(await page("!!document.querySelector('#composer button[aria-label=Stop]')")), 60000);

// A Claude transcript of 1000 messages, so opening it reads only its end.
const BIG = '5e551011-0000-4000-8000-0000000b1600';
const FIRST = 'quasar FIRST GOAL of the long chat';
function writeBigTranscript() {
  const dir = path.join(s.home, '.claude', 'projects', s.project.replace(/[/.]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const uuid = (i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
  const lines = Array.from({ length: 1000 }, (_, i) => {
    const typ = i % 2 ? 'assistant' : 'user';
    const content = i === 0 ? FIRST : i % 2 ? [{ type: 'text', text: `answer ${(i - 1) / 2}` }] : `question ${i / 2}`;
    return JSON.stringify({ type: typ, uuid: uuid(i), parentUuid: i ? uuid(i - 1) : null, sessionId: BIG, cwd: s.project, timestamp: new Date(Date.UTC(2026, 9, 1) + i * 60000).toISOString(), message: { role: typ, content } });
  });
  fs.writeFileSync(path.join(dir, `${BIG}.jsonl`), `${lines.join('\n')}\n`);
}

try {
  await main("(() => { const h = electron.ipcMain._invokeHandlers; const send = h.get('agent:send'); globalThis.__sendHandler = send; h.set('agent:send', (e, a) => { globalThis.__lastChat = a.chat; return send(e, a); }); return 1; })()");
  await main("(() => { globalThis.__starts = []; const { AgentSession } = req('./agent'); const start = AgentSession.prototype.start; AgentSession.prototype.start = function () { globalThis.__starts.push({ at: Date.now(), model: this.model, resume: this.resume }); return start.call(this); }; return 1; })()");
  await click(s, 'Later').catch(() => {});
  writeBigTranscript();

  // ---- D: a refused switch puts the chat's model back --------------------
  if (only('D')) {
  await send('dchat ALPHA');
  await until(() => has('heard: dchat ALPHA'));
  await idle();
  const claudeModel = (await main('JSON.stringify(globalThis.__starts)').then(JSON.parse)).at(-1)?.model;
  note('the Claude model the chat started on', claudeModel);
  const projDir = path.join(s.home, '.claude', 'projects', s.project.replace(/[/.]/g, '-'));
  const dSession = fs.readdirSync(projDir).filter((f) => f.endsWith('.jsonl') && !f.startsWith(BIG)).map((f) => f.slice(0, -6))[0];
  const activeKey = await main('globalThis.__lastChat');
  note('chat key for the side turn', activeKey);
  const t0 = Date.now();
  await pick('copilot');
  // While main waits on the slow agent, a turn reaches the old CLI by another
  // road than this window's composer (as the phone or `conn ask` would).
  await sleep(600);
  await main(`(async () => { const send = globalThis.__sendHandler; return JSON.stringify(await send({}, { chat: ${JSON.stringify(activeKey)}, session: ${JSON.stringify(dSession)}, text: 'wait 3 ;; say: side turn done', project: ${JSON.stringify(s.project)}, provider: 'claude' })); })()`).catch((e) => note('side turn', e.message));
  await sleep(9000);
  note('switch took (ms, upper bound)', Date.now() - t0);
  const dRows = await handoffs();
  const toastText = await page("JSON.stringify([...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.innerText))");
  note('toasts', toastText);
  check('D: the switch is refused, the chat stays on Claude', !dRows.some((l) => /→ Copilot/.test(l)), dRows);
  await idle();
  await page(`window.conn.agent.reset(${JSON.stringify(activeKey)})`).catch(() => {});
  await sleep(1000);
  await send('dchat after refusal CHARLIE');
  await until(() => has('heard: dchat after refusal CHARLIE'));
  const starts = await main('JSON.stringify(globalThis.__starts)').then(JSON.parse);
  note('Claude session starts (model)', starts.map((x) => x.model));
  check('D: the next Claude session starts on the model the chat had, not the refused pick', starts.at(-1)?.model === claudeModel && starts.at(-1)?.model !== 'auto', starts.at(-1));
  await shot(s, path.join(SHOTS, 'D-refused-switch.png'));
  }
} catch (e) {
  check('the run finished', false, e.stack);
}

if (only('F')) try {
  // ---- F: Enter twice while the rest of a long chat is read in ----------
  await reload();
  await openRow(FIRST.slice(0, 40).trim(), 0).catch(async () => openRow((await rows()).find((r) => /quasar/.test(r))));
  check('F: the long chat opens on its end only', !(await page(`(document.querySelector('#agent-root [role=log]') || document.querySelector('#agent-root'))?.innerText.includes(${JSON.stringify(FIRST)})`)), 'the first message is already in the transcript');
  await pick('codex');
  await sleep(3000);
  const before = codexUsers().length;
  await focus();
  await type(s, 'fchat ONE', { enter: true });
  await type(s, 'fchat TWO', { enter: true });
  await until(async () => codexUsers().length >= before + 2, 60000);
  await sleep(3000);
  const got = codexUsers().slice(before);
  const wrapped = got.filter((t) => t.includes('<conn-handoff'));
  note('codex received', got.map((t) => t.slice(0, 40) + ' … ' + t.slice(-30)));
  check('F: exactly one message carries the handoff', wrapped.length === 1, got.map((t) => t.slice(-60)));
  check('F: the handoff has the chat\'s first message, read in from outside the window', wrapped[0]?.includes(FIRST), wrapped[0]?.slice(0, 300));
  check('F: both messages reach Codex in order', got.length >= 2 && got[0].endsWith('fchat ONE') && got[1].endsWith('fchat TWO'), got.map((t) => t.slice(-40)));
  await shot(s, path.join(SHOTS, 'F-double-enter.png'));
} catch (e) {
  check('the F run finished', false, e.stack);
}

if (only('A')) try {
  // ---- A: picks name their CLI -------------------------------------------
  await newChat();
  await pick('copilot');
  await sleep(6000);
  await send('achat ALPHA on copilot');
  await until(() => has('acp heard: achat ALPHA on copilot'), 60000);
  await idle();
  await pick('codex');
  await sleep(3000);
  const beforeA = codexUsers().length;
  await send('achat BRAVO to chatgpt');
  await until(async () => codexUsers().length > beforeA || await has('acp heard: achat BRAVO'), 60000);
  await sleep(2000);
  check('A: ChatGPT\'s GPT-6.2-Sol, picked on a Copilot chat, moves it to Codex', codexUsers().slice(beforeA).some((t) => t.endsWith('achat BRAVO to chatgpt') && t.includes('<conn-handoff')), { codex: codexUsers().slice(beforeA).map((t) => t.slice(-40)), rows: await handoffs() });
  await idle();
  // Fork by mouse: ChatGPT's row, then Copilot's row of the same name.
  const forkBy = async (section) => {
    await openPicker();
    await hover(s, 'Fork to a New Chat');
    await sleep(900);
    const at = await page(`(() => { const menus = [...document.querySelectorAll('[role=menu]')]; const sub = menus.at(-1); const labels = [...sub.querySelectorAll('*')].filter((e) => e.children.length === 0 || e.getAttribute('data-slot') === 'dropdown-menu-label'); let inSection = false; for (const el of sub.querySelectorAll('[data-slot=dropdown-menu-label], [role=menuitem]')) { if (el.getAttribute('data-slot') === 'dropdown-menu-label') { const t = el.innerText.trim().toUpperCase(); if (t === 'LATEST' || t === 'LEGACY') continue; inSection = t === ${JSON.stringify(section.toUpperCase())}; continue; } if (inSection && /GPT-6\\.2.Sol/.test(el.innerText)) { el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return Math.round(r.x + r.width / 2) + ',' + Math.round(r.y + r.height / 2); } } void labels; return null; })()`);
    if (!at) throw new Error(`no GPT-6.2-Sol row under ${section} in the fork menu`);
    await hover(s, `xy=${at}`);
    await sleep(300);
    await click(s, `xy=${at}`);
    await sleep(2500);
  };
  await forkBy('ChatGPT');
  const fA = codexUsers().length;
  await send('afork ONE via chatgpt row');
  await until(async () => codexUsers().length > fA, 60000);
  check('A: the fork menu\'s ChatGPT row forks onto Codex', codexUsers().slice(fA).some((t) => t.endsWith('afork ONE via chatgpt row') && /fork="yes"/.test(t)), codexUsers().slice(fA).map((t) => t.slice(0, 80)));
  await idle();
  await shot(s, path.join(SHOTS, 'A-fork-chatgpt-row.png'));
  await forkBy('Copilot');
  const sA = stubPrompts().length;
  await send('afork TWO via copilot row');
  await until(async () => stubPrompts().length > sA, 60000);
  check('A: the fork menu\'s Copilot row of the same name forks onto Copilot', stubPrompts().slice(sA).some((p) => p.name === 'copilot' && p.params.text.endsWith('afork TWO via copilot row')), stubPrompts().slice(sA).map((p) => [p.name, p.params.text.slice(-40)]));
  await idle();
  await shot(s, path.join(SHOTS, 'A-fork-copilot-row.png'));
} catch (e) {
  check('the A run finished', false, e.stack);
}

try {
  // ---- R: true restart ---------------------------------------------------
  if (only('R')) {
  await reload();
  const before = await rows();
  note('rail before restart', before);
  await restart(s);
  const after = await rows();
  check('R: the rail is the same after a restart', JSON.stringify(after) === JSON.stringify(before), { before, after });
  await openRow('achat ALPHA on copilot', 0);
  const forkRows = await handoffs();
  const text = await page('document.body.innerText');
  note('first row titled achat after restart (newest fork): handoff rows', forkRows);
  check('R: a reopened fork draws its carried rows above "Forked from"', /^Forked from/.test(forkRows.find((l) => /Forked/.test(l)) || '') && text.indexOf('achat ALPHA on copilot') < text.indexOf('Forked from') && text.includes('afork TWO via copilot row'), forkRows);
  await shot(s, path.join(SHOTS, 'R-fork-after-restart.png'), { preview: false });
  // The Copilot -> Codex chat: switch it once more so its segments are saved
  // again, with whatever window size reopening found.
  const recBefore = segments();
  note('segments on disk after restart', recBefore);
  const chatRow = (await rows()).filter((r) => r === 'achat ALPHA on copilot');
  await openRow('achat ALPHA on copilot', chatRow.length - 1);
  await pick('claude');
  await sleep(3000);
  await send('achat CHARLIE after restart');
  await until(() => has('heard: achat CHARLIE after restart'));
  await sleep(2000);
  const rec = Object.values(segments()).find((segs) => segs.length >= 3 && segs[0].provider === 'copilot');
  note('the switched chat\'s record after one more switch', rec);
  // Only agents that report usage give a size: the stub and codex do not, so
  // this chat has none to keep. handoff-context-reopen-repro covers a Claude stretch.
  note('R: window sizes kept (none expected for stub and codex stretches)', rec?.map((x) => x.context || 0));
  }
} catch (e) {
  check('the R run finished', false, e.stack);
} finally {
  const off = net.stop();
  check('no agent and no provider API was reached off the machine', !off.bad.length, off.bad);
  console.log(`NOTE the app's own traffic off the machine: ${JSON.stringify(off.app.map((x) => x.peer))}`);
  if (!process.env.KEEP) await stop(s).catch((e) => console.log(`NOTE stop failed: ${e.message}`));
  api.kill();
  fs.rmSync(log, { force: true });
  cleanupShims();
}

async function restart(sess) {
  const pid = Number(await main('process.pid'));
  const env = JSON.parse(await main('JSON.stringify(process.env)'));
  assertSafeEnv(env, 'app');
  await main('setTimeout(() => electron.app.quit(), 100), 1').catch(() => {});
  await until(async () => !fs.existsSync(`/proc/${pid}`), 30000);
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
  const child = spawn('xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24', electron, ...args], { detached: true, stdio: ['ignore', out, out], env });
  child.unref();
  const tail = () => fs.readFileSync(logFile, 'utf8').slice(startLen);
  sess.inspect = Number(await until(async () => /Debugger listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(tail())?.[1], 30000));
  sess.cdp = Number(await until(async () => fs.readFileSync(path.join(sess.userData, 'DevToolsActivePort'), 'utf8').split('\n')[0], 30000));
  sess.pid = child.pid;
  fs.writeFileSync(path.join(sess.dir, 'session.json'), JSON.stringify(sess));
  await until(() => page('!!window.connChat'), 45000);
  await main("(() => { const win = () => electron.BrowserWindow.getAllWindows().find((w) => /index\\.html/.test(w.webContents.getURL())); globalThis.__decided = []; globalThis.__bounds = []; globalThis.__floatBox = () => null; globalThis.__floatFocused = () => false; globalThis.__focusView = () => win()?.webContents.focus(); return 1; })()");
  await main('electron.BrowserWindow.getAllWindows()[0].setContentSize(1440, 900)');
  // Same shims as boot: the codex history server and the padded Claude list.
  await main("(() => { req('./codex-history').close(); const { Driver } = req('./driver'); const orig = Driver.prototype.current; Driver.prototype.current = function (o) { const r = orig.call(this, o); return r.models.length ? r : { ...r, models: [{ value: 'claude-opus-5-5', displayName: 'Opus 5.5 (stand-in)' }] }; }; return 1; })()");
  await sleep(6000);
  console.log(`restarted pid=${child.pid}`);
}

console.log(failures.length ? `\n${failures.length} failed: ${failures.join(', ')}` : '\nall passed');
process.exit(failures.length ? 1 : 0);
