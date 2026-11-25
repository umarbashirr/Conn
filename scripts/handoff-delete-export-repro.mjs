#!/usr/bin/env node
/* Export and delete of a chat that changed agent, through the real buttons.

   - Export: a Claude -> ChatGPT chat exported with the header's Export chat
     button holds both stretches, typed text only.
   - Delete, follower kept: Claude -> Copilot, and Copilot's history refuses to
     delete (stubbed in main: every ACP session/delete is refused). The row
     goes, the Claude transcript goes, the Copilot part is hidden and the rail
     does not bring it back.
   - Delete, head kept: Copilot -> Claude, same refusal, so the chat's first
     session cannot go. Reports what the app does with the Claude part.

   Same harness and shims as handoff-switch-e2e-repro.mjs. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const drive = await import(path.join(ROOT, '.claude/skills/verify/drive.mjs'));
const { boot, stop, click, hover, key, type, shot, evaluate } = drive;
const SHOTS = process.env.SHOT_DIR || '/tmp/handoff-verify/r2';
fs.mkdirSync(SHOTS, { recursive: true });

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` ${JSON.stringify(detail)?.slice(0, 600)}`}`);
  if (!ok) failures.push(name);
};
const note = (what, v) => console.log(`NOTE ${what}: ${JSON.stringify(v)?.slice(0, 600)}`);
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

const s = await boot({ xvfb: true, claude: true });
console.log(`session ${s.dir}`);
const page = (expr) => evaluate(s, expr);
const main = (expr) => evaluate(s, expr, { main: true });
const conn = (f) => { try { return JSON.parse(fs.readFileSync(path.join(s.home, '.conn', f), 'utf8')); } catch { return {}; } };
const railRows = async () => {
  await page('window.connRail?.refresh()');
  await sleep(1500);
  return JSON.parse(await page("JSON.stringify([...document.querySelectorAll('li[data-sidebar=menu-item]')].map((e) => e.innerText.split('\\n')[0]))")).filter((r) => !['New chat', 'Search', 'Check for updates', 'Customize', 'Usage'].includes(r));
};
const reload = async () => {
  await main("(() => { const w = electron.BrowserWindow.getAllWindows().find((w) => /index\\.html/.test(w.webContents.getURL())); w.webContents.reload(); return 1; })()");
  await sleep(7000);
};
const send = async (text) => {
  await page("document.querySelector('#composer [contenteditable=\"true\"]').focus()");
  await type(s, text, { enter: true });
};
const waitReply = (needle, ms = 30000) => until(() => page(`document.body.innerText.includes(${JSON.stringify(needle)})`), ms);
const openPicker = async () => {
  const at = await page(`(() => { const b = [...document.querySelectorAll('#composer button[data-slot=dropdown-menu-trigger]')].find((e) => /Opus|Sonnet|Haiku|Fable|GPT|Auto|Pick a model/.test(e.innerText)); const r = b.getBoundingClientRect(); return Math.round(r.x + r.width / 2) + ',' + Math.round(r.y + r.height / 2); })()`);
  await click(s, `xy=${at}`);
  await sleep(400);
};
const pick = async (provider) => {
  await openPicker();
  await hover(s, provider === 'codex' ? 'ChatGPT' : provider === 'copilot' ? 'Copilot' : 'Claude');
  await sleep(700);
  if (provider === 'copilot') { await key(s, 'Right'); await sleep(300); await key(s, 'Enter'); }
  else await click(s, provider === 'codex' ? 'Fast, go-to model for coding and everyday work.' : 'Best for everyday, complex tasks');
  await sleep(2500);
};
const claudeFile = (id) => {
  const dir = path.join(s.home, '.claude/projects');
  for (const d of fs.readdirSync(dir)) if (fs.existsSync(path.join(dir, d, `${id}.jsonl`))) return path.join(dir, d, `${id}.jsonl`);
  return null;
};
const newChat = async () => { await click(s, 'New chat'); await sleep(800); };
const deleteRow = async (title) => {
  await hover(s, title);
  await click(s, `Delete ${title}`);
  await sleep(400);
  await click(s, 'Delete');
  // Toasts close after a few seconds; read them while they are up.
  await until(async () => (await toasts()).length > 0, 4000);
  lastToasts = await toasts();
  await sleep(3000);
};
let lastToasts = [];
const toasts = () => page("JSON.stringify([...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.innerText))").then(JSON.parse);

try {
  fs.mkdirSync(path.join(s.home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(s.home, '.codex/config.toml'), [
    'model_provider = "fake"', '', '[model_providers.fake]', 'name = "fake"',
    `base_url = "http://127.0.0.1:${port}/v1"`, 'wire_api = "responses"', 'request_max_retries = 0', 'stream_max_retries = 0', '',
  ].join('\n'));
  await main("(() => { req('./codex-history').close(); const { Driver } = req('./driver'); const orig = Driver.prototype.current; Driver.prototype.current = function (o) { const r = orig.call(this, o); return r.models.length ? r : { ...r, models: [{ value: 'claude-opus-5-5', displayName: 'Opus 5.5 (stand-in)' }] }; }; const { AcpRpc } = req('./providers/acp-rpc'); const request = AcpRpc.prototype.request; AcpRpc.prototype.request = function (method, ...rest) { if (method === 'session/delete') return Promise.reject(new Error('stub: this agent refuses to delete')); return request.call(this, method, ...rest); }; electron.dialog.showSaveDialog = async () => ({ canceled: false, filePath: '/tmp/handoff-verify/r2/export-button.md' }); return 1; })()");
  await click(s, 'Later').catch(() => {});
  fs.rmSync('/tmp/handoff-verify/r2/export-button.md', { force: true });

  // Export through the button.
  await send('exp ALPHA');
  await waitReply('heard: exp ALPHA');
  await pick('codex');
  await send('exp BRAVO');
  await waitReply('codex heard: exp BRAVO');
  await sleep(1500);
  await click(s, 'Export chat');
  const md = await until(async () => (fs.existsSync('/tmp/handoff-verify/r2/export-button.md') ? fs.readFileSync('/tmp/handoff-verify/r2/export-button.md', 'utf8') : null), 20000);
  check('export through the button writes a file', !!md, await toasts());
  check('export holds both stretches in order', !!md && md.indexOf('exp ALPHA') >= 0 && md.indexOf('exp BRAVO') > md.indexOf('exp ALPHA') && md.includes('codex heard: exp BRAVO'), md);
  check('export holds no handoff text', !!md && !md.includes('conn-handoff') && !md.includes('<item'), md);
  note('export', md);

  // Delete, with the Copilot follower refusing.
  await newChat();
  await pick('claude');
  await send('del ALPHA');
  await waitReply('heard: del ALPHA');
  await pick('copilot');
  await send('del BRAVO');
  await waitReply('heard: del BRAVO', 60000);
  await sleep(3000);
  const recs = conn('chat-segments.json');
  const head1 = Object.keys(recs).find((h) => recs[h].some((x) => x.provider === 'copilot'));
  const cop1 = head1 && recs[head1].find((x) => x.provider === 'copilot').session;
  check('the Claude -> Copilot chat was written down', !!cop1, recs);
  await reload();
  await deleteRow('del ALPHA');
  const t1 = lastToasts;
  note('toasts after deleting with a Copilot follower', t1);
  check('the row is gone', !(await railRows()).some((r) => /del (ALPHA|BRAVO)/.test(r)), await railRows());
  check('the Claude transcript is gone', head1 && !claudeFile(head1));
  check('the Copilot part is hidden', !!conn('hidden-sessions.json')[cop1], conn('hidden-sessions.json'));
  check('the person is told a part stayed', t1.some((t) => /except one part/.test(t)), t1);
  await reload();
  check('the Copilot part does not come back after a reload', !(await railRows()).some((r) => /del (ALPHA|BRAVO)/.test(r)), await railRows());
  await shot(s, path.join(SHOTS, 'delete-follower-refused.png'));

  // Delete, with the Copilot head refusing.
  await newChat();
  await pick('copilot');
  const onCopilot = await page("[...document.querySelectorAll('#composer button[data-slot=dropdown-menu-trigger]')].map((e) => e.innerText).join(' ')");
  check('the new chat is on Copilot before its first message', /Auto/.test(onCopilot), onCopilot);
  await send('head ALPHA');
  await waitReply('heard: head ALPHA', 60000);
  await sleep(3000);
  await pick('claude');
  await send('head BRAVO');
  await waitReply('heard: head BRAVO');
  await sleep(2000);
  const recs2 = conn('chat-segments.json');
  const head2 = Object.keys(recs2).find((h) => recs2[h][0].provider === 'copilot');
  const claude2 = head2 && recs2[head2].find((x) => x.provider === 'claude').session;
  check('the Copilot -> Claude chat was written down', !!claude2, recs2);
  await reload();
  const rows = await railRows();
  const title = rows.find((r) => /head (ALPHA|BRAVO)/.test(r)) || rows[0];
  note('rail before deleting the Copilot-headed chat', rows);
  await deleteRow(title);
  const t2 = lastToasts;
  const after = await railRows();
  note('toasts after deleting with a Copilot head', t2);
  note('rail after', after);
  note('Claude follower transcript still on disk', !!claudeFile(claude2));
  note('record still on disk', conn('chat-segments.json')[head2] || null);
  // What should hold: either the whole chat goes, or nothing does.
  const stillListed = after.includes(title);
  check('a refused head delete leaves the chat whole or removes it whole', stillListed ? !!claudeFile(claude2) : !claudeFile(claude2), { stillListed, claudeLeft: !!claudeFile(claude2) });
  if (stillListed) {
    await reload();
    await click(s, title);
    await sleep(6000);
    const txt = await page('document.body.innerText');
    note('reopened after the refused delete shows head BRAVO', txt.includes('head BRAVO'));
    await shot(s, path.join(SHOTS, 'delete-head-refused-reopened.png'));
  }
} catch (e) {
  check('the run finished', false, e.stack);
} finally {
  if (!process.env.KEEP) await stop(s).catch(() => {});
  api.kill();
  fs.rmSync(log, { force: true });
}

console.log(failures.length ? `\n${failures.length} failed: ${failures.join(', ')}` : '\nall passed');
process.exit(failures.length ? 1 : 0);
