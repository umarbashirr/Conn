#!/usr/bin/env node
/* A message sent while a switch to a slow agent is still in flight. Copilot
   takes seconds to come up, so picking it and typing straight away puts the
   message inside the switch. It must either wait and go to Copilot with the
   handoff, or the switch must be refused; it must never go to the agent being
   left while the chat ends up on the new one. Each round: a new Claude chat,
   one answered message, pick Copilot, wait GAP ms, send. Main logs every send
   (which CLI, whether it carried a handoff). Same harness as the other
   handoff repros. ROUNDS (default 4) and GAPS (default 0,300,800,1500). */
import { drive, safeBoot, watchNet, cleanupShims, providerAddresses } from './handoff-harness.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
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

const s = await safeBoot({ codexPort: port });
const net = watchNet(s, await providerAddresses());
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
  else if (provider === 'codex') await click(s, 'Fast, go-to model for coding and everyday work.');
  // Claude lists its real rows once a session has taught it them; before
  // that, only the stand-in row the harness pads the list with.
  // The first row of Claude's list, by keyboard: its names change once a
  // session has taught the app the real list.
  else { await key(s, 'Right'); await sleep(300); await key(s, 'Enter'); }
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
  await sleep(5000);
};
const toasts = () => page("JSON.stringify([...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.innerText))").then(JSON.parse);

try {
  fs.mkdirSync(path.join(s.home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(s.home, '.codex/config.toml'), [
    'model_provider = "fake"', '', '[model_providers.fake]', 'name = "fake"',
    `base_url = "http://127.0.0.1:${port}/v1"`, 'wire_api = "responses"', 'request_max_retries = 0', 'stream_max_retries = 0', '',
    '[features]', 'plugins = false', '', // codex's plugin sync would reach github.com and chatgpt.com: see handoff-harness.mjs
  ].join('\n'));
  await main("(() => { req('./codex-history').close(); const { Driver } = req('./driver'); const orig = Driver.prototype.current; Driver.prototype.current = function (o) { const r = orig.call(this, o); return r.models.length ? r : { ...r, models: [{ value: 'claude-opus-5-5', displayName: 'Opus 5.5 (stand-in)' }] }; }; const { AcpRpc } = req('./providers/acp-rpc'); const request = AcpRpc.prototype.request; AcpRpc.prototype.request = function (method, ...rest) { if (method === 'session/delete') return Promise.reject(new Error('stub: this agent refuses to delete')); return request.call(this, method, ...rest); }; return 1; })()");
  await click(s, 'Later').catch(() => {});
  fs.rmSync('/tmp/handoff-verify/r2/export-button.md', { force: true });

  await main("(() => { globalThis.__sends = []; for (const [mod, cls] of [['./agent', 'AgentSession'], ['./codex', 'CodexSession'], ['./providers/acp-session', 'AcpSession']]) { const C = req(mod)[cls]; const send = C.prototype.send; C.prototype.send = function (text, images) { globalThis.__sends.push({ cls, provider: this.provider, text: String(text) }); return send.call(this, text, images); }; } return 1; })()");
  await main("(() => { const h = electron.ipcMain._invokeHandlers; const sm = h.get('agent:setModel'); globalThis.__sm = []; h.set('agent:setModel', async (e, a) => { const t = Date.now(); const r = await sm(e, a); globalThis.__sm.push({ model: a.model, provider: a.provider, ms: Date.now() - t }); return r; }); return 1; })()");
  const gaps = (process.env.GAPS || '0,300,800,1500').split(',').map(Number);
  const rounds = Number(process.env.ROUNDS || gaps.length);
  for (let r = 0; r < rounds; r++) {
    const gap = gaps[r % gaps.length];
    const tag = `r${r}g${gap}`;
    await newChat();
    // A new chat follows the last pick; put it on Claude unless it already is.
    const on = await page("[...document.querySelectorAll('#composer button[data-slot=dropdown-menu-trigger]')].map((e) => e.innerText).join(' ')");
    // "Pick a model" on a fresh boot is Claude with no pick made yet.
    if (!/Opus|Sonnet|Haiku|Fable|Pick a model/.test(on)) await pick('claude');
    await send(`${tag} ALPHA`);
    await waitReply(`heard: ${tag} ALPHA`);
    await sleep(1000);
    await openPicker();
    await hover(s, 'Copilot');
    await sleep(700);
    await key(s, 'Right');
    await sleep(300);
    await key(s, 'Enter');
    await sleep(gap);
    await send(`${tag} BRAVO`);
    await until(async () => (await main('JSON.stringify(globalThis.__sends)').then(JSON.parse)).some((x) => x.text.endsWith(`${tag} BRAVO`)), 40000);
    await sleep(4000);
    const sent = (await main('JSON.stringify(globalThis.__sends)').then(JSON.parse)).filter((x) => x.text.endsWith(`${tag} BRAVO`));
    const rows = JSON.parse(await page("JSON.stringify([...document.querySelectorAll('[data-handoff]')].map((e) => e.getAttribute('aria-label')))"));
    const onCopilot = rows.some((l) => /→ Copilot/.test(l));
    const got = sent.map((x) => `${x.provider}${x.text.includes('<conn-handoff') ? '+handoff' : ''}`);
    const ok = onCopilot ? got.length === 1 && got[0] === 'copilot+handoff' : got.every((g) => g === 'claude');
    const took = (await main('JSON.stringify(globalThis.__sm)').then(JSON.parse)).filter((x) => x.provider === 'copilot').at(-1);
    console.log(`NOTE ${tag}: the switch to Copilot took ${took?.ms}ms in main; the message went ${gap}ms after the pick`);
    check(`gap ${gap}ms: the message goes with the switch, or the switch is refused`, ok, { sentTo: got, rows });
    await shot(s, path.join(SHOTS, `race-${tag}.png`));
  }
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

console.log(failures.length ? `\n${failures.length} failed: ${failures.join(', ')}` : '\nall passed');
process.exit(failures.length ? 1 : 0);
