#!/usr/bin/env node
/* Settings › Chat › Hidden chats, end to end through handoff-harness.mjs. The
   ACP agent is the stub, which refuses to delete a chat from outside itself.

   - A Claude -> Copilot chat is deleted: the toast names the part that went
     and the agent that kept its part, and that part is listed as hidden.
   - A chat wholly on Copilot is deleted: the toast says it was removed from
     Conn and Copilot kept its copy, and it is listed as hidden.
   - Show again brings that chat back to the rail, on its own.
   - Try deleting again, with the stub still refusing, keeps it listed and
     says why. Screenshots go to SHOT_DIR (default /tmp/handoff-verify/r3). */
import { drive, safeBoot, watchNet, cleanupShims, providerAddresses } from './handoff-harness.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { stop, click, hover, key, type, shot, evaluate } = drive;
const SHOTS = process.env.SHOT_DIR || '/tmp/handoff-verify/r3';
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

const log = path.join(os.tmpdir(), `fake-responses-${process.pid}.jsonl`);
const api = spawn(process.execPath, [path.join(ROOT, 'scripts/fake-responses-api.mjs'), log], { stdio: ['ignore', 'pipe', 'inherit'] });
const port = await new Promise((resolve) => api.stdout.on('data', (d) => { const m = /port (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));

const s = await safeBoot({ codexPort: port });
const net = watchNet(s, await providerAddresses());
console.log(`session ${s.dir}`);
const page = (expr) => evaluate(s, expr);
const hidden = () => { try { return JSON.parse(fs.readFileSync(path.join(s.home, '.conn/hidden-sessions.json'), 'utf8')); } catch { return {}; } };
const railRows = async () => {
  await page('window.connRail?.refresh()');
  await sleep(1500);
  return JSON.parse(await page("JSON.stringify([...document.querySelectorAll('li[data-sidebar=menu-item]')].map((e) => e.innerText.split('\\n')[0]))"));
};
const send = async (text) => {
  await page("document.querySelector('#composer [contenteditable=\"true\"]').focus()");
  await type(s, text, { enter: true });
};
const waitReply = (needle, ms = 30000) => until(() => page(`document.body.innerText.includes(${JSON.stringify(needle)})`), ms);
const pick = async (provider) => {
  const at = await page(`(() => { const b = [...document.querySelectorAll('#composer button[data-slot=dropdown-menu-trigger]')].find((e) => /Opus|Sonnet|Haiku|Fable|GPT|Auto|Pick a model/.test(e.innerText)); const r = b.getBoundingClientRect(); return Math.round(r.x + r.width / 2) + ',' + Math.round(r.y + r.height / 2); })()`);
  await click(s, `xy=${at}`);
  await sleep(400);
  await hover(s, provider === 'copilot' ? 'Copilot' : 'Claude');
  await sleep(700);
  await key(s, 'Right');
  await sleep(300);
  await key(s, 'Enter');
  await sleep(2500);
};
const toasts = () => page("JSON.stringify([...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.innerText))").then(JSON.parse);
const deleteRow = async (title) => {
  await hover(s, title);
  await click(s, `Delete ${title}`);
  await sleep(400);
  await click(s, 'Delete');
  await until(async () => (await toasts()).some((t) => /on disk/.test(t)), 6000);
  const seen = await toasts();
  await sleep(4000);
  return seen;
};
const newChat = async () => { await click(s, 'New chat'); await sleep(800); };
const hiddenRows = () => page("JSON.stringify([...document.querySelectorAll('h3')].find((h) => h.innerText === 'Hidden chats')?.parentElement.innerText.split('\\n') || null)").then(JSON.parse);

try {
  await click(s, 'Later').catch(() => {});

  // Claude, then Copilot: deleting it leaves Copilot's part.
  await send('hid ALPHA');
  await waitReply('heard: hid ALPHA');
  await pick('copilot');
  await send('hid BRAVO');
  await waitReply('acp heard: hid BRAVO', 60000);
  await sleep(2000);
  const t1 = await deleteRow('hid ALPHA');
  check('a part kept: the toast names what went and what stayed', t1.some((t) => /Deleted the Claude part\./.test(t) && /Copilot kept its part on disk/.test(t)), t1);

  // Wholly on Copilot: deleting it leaves the whole chat.
  await newChat();
  await pick('copilot');
  await send('solo ALPHA');
  await waitReply('acp heard: solo ALPHA', 60000);
  await sleep(2000);
  const t2 = await deleteRow('solo ALPHA');
  check('the whole chat kept: the toast says it was only removed from Conn', t2.some((t) => /Removed from Conn\./.test(t) && /Copilot kept its copy on disk/.test(t) && !/except one part/.test(t)), t2);
  check('both are hidden, with what Settings lists', Object.values(hidden()).filter((h) => h.provider === 'copilot' && h.title).length === 2, hidden());
  check('neither is in the rail', !(await railRows()).some((r) => /hid |solo /.test(r)), await railRows());

  // Settings › Chat.
  await page("window.connChat?.settings('chat'), 1");
  await until(() => hiddenRows(), 8000);
  await page("[...document.querySelectorAll('h3')].find((h) => h.innerText === 'Hidden chats')?.scrollIntoView({ block: 'start' }), 1");
  await sleep(600);
  // An update toast can turn up over the top right at any point; not in the shot.
  await click(s, 'Later').catch(() => {});
  await sleep(400);
  const listed = await hiddenRows();
  check('Settings lists both hidden chats with agent and folder', listed && listed.filter((l) => /^Copilot · shop/.test(l)).length === 2 && listed.includes('hid ALPHA') && listed.includes('solo ALPHA'), listed);
  await shot(s, path.join(SHOTS, 'hidden-chats-listed.png'));

  // Try deleting again while the agent still refuses.
  const soloRow = "[...document.querySelectorAll('[data-slot=field]')].find((f) => f.innerText.startsWith('solo ALPHA'))";
  const at = (label) => page(`(() => { const b = [...${soloRow}.querySelectorAll('button')].find((x) => x.innerText === ${JSON.stringify(label)}); const r = b.getBoundingClientRect(); return Math.round(r.x + r.width / 2) + ',' + Math.round(r.y + r.height / 2); })()`);
  await click(s, `xy=${await at('Try deleting again')}`);
  await until(async () => (await toasts()).some((t) => /Could not do that/.test(t)), 6000);
  check('a refused retry says why and keeps it listed', (await toasts()).some((t) => /Could not do that/.test(t)) && (await hiddenRows()).includes('solo ALPHA'), await toasts());

  // Show again.
  await click(s, `xy=${await at('Show again')}`);
  await sleep(1500);
  check('Show again takes it off the list', !(await hiddenRows()).includes('solo ALPHA'), await hiddenRows());
  await shot(s, path.join(SHOTS, 'hidden-chats-after-show-again.png'));
  check('and it is back in the rail, on its own', (await railRows()).filter((r) => /solo ALPHA/.test(r)).length === 1, await railRows());
  check('and hidden-sessions.json no longer has it', Object.values(hidden()).filter((h) => h.title === 'solo ALPHA').length === 0, hidden());
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
