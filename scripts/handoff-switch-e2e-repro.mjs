#!/usr/bin/env node
/* Switching one chat between Claude and ChatGPT in place, end to end in the
   real app: the real claude CLI against the verify skill's stand-in API, and
   the real codex CLI against scripts/fake-responses-api.mjs. It checks what
   each CLI was actually handed, the delta on the way back, the rail after a
   reload, reopen order, and delete. It then switches a chat that was reopened
   from the rail and checks that the switch was written down (one rail row).

   Needs `npx vite build` first, claude and codex on PATH, Linux with Xvfb.
   Screenshots go to SHOT_DIR (default /tmp/handoff-verify). Exits 1 on any
   FAIL. Two harness shims, both outside the code under test: the claude model
   list is padded when the stand-in API serves none, and the codex history
   server is restarted once the fake provider is configured. */
import { drive, safeBoot, watchNet, cleanupShims, providerAddresses } from './handoff-harness.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { boot, stop, click, hover, key, type, shot, evaluate } = drive;
const SHOTS = process.env.SHOT_DIR || '/tmp/handoff-verify';
fs.mkdirSync(SHOTS, { recursive: true });

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` ${JSON.stringify(detail)?.slice(0, 400)}`}`);
  if (!ok) failures.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000) => {
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
const page = (expr) => evaluate(s, expr);
const main = (expr) => evaluate(s, expr, { main: true });
const codexRequests = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
const lastCodexUser = () => {
  const r = codexRequests().at(-1);
  const users = (r?.body?.input || []).filter((m) => m.role === 'user');
  return users.at(-1)?.content?.map((c) => c.text).join('\n') || '';
};
const claudeUsers = (id) => {
  const dir = path.join(s.home, '.claude/projects');
  for (const d of fs.readdirSync(dir)) {
    const f = path.join(dir, d, `${id}.jsonl`);
    if (!fs.existsSync(f)) continue;
    return fs.readFileSync(f, 'utf8').trim().split('\n').map(JSON.parse).filter((o) => o.type === 'user')
      .map((o) => (typeof o.message.content === 'string' ? o.message.content : o.message.content.map((b) => b.text || '').join('')));
  }
  return [];
};
const segmentsOnDisk = () => {
  try { return JSON.parse(fs.readFileSync(path.join(s.home, '.conn/chat-segments.json'), 'utf8')); } catch { return {}; }
};
const railRows = () => page("JSON.stringify([...document.querySelectorAll('li[data-sidebar=menu-item]')].map((e) => e.innerText.split('\\n')[0]))").then(JSON.parse);
const chatText = () => page("document.querySelector('[data-handoff]')?.closest('main, section, div[role=log]')?.innerText || document.body.innerText");
const handoffRows = () => page("JSON.stringify([...document.querySelectorAll('[data-handoff]')].map((e) => e.getAttribute('aria-label')))").then(JSON.parse);
const reload = async () => {
  await main("(() => { const w = electron.BrowserWindow.getAllWindows().find((w) => /index\\.html/.test(w.webContents.getURL())); w.webContents.reload(); return 1; })()");
  await sleep(6000);
};
const send = async (text) => {
  await page("document.querySelector('#composer [contenteditable=\"true\"]').focus()");
  await type(s, text, { enter: true });
};
const waitReply = (needle) => until(() => page(`document.body.innerText.includes(${JSON.stringify(needle)})`), 30000);
const openPicker = async () => {
  const at = await page(`(() => { const b = [...document.querySelectorAll('#composer button[data-slot=dropdown-menu-trigger]')].find((e) => /Opus|Sonnet|Haiku|Fable|GPT|Auto|Pick a model/.test(e.innerText)); const r = b.getBoundingClientRect(); return Math.round(r.x + r.width / 2) + ',' + Math.round(r.y + r.height / 2); })()`);
  await click(s, `xy=${at}`);
  await sleep(400);
};
const pick = async (provider, description) => {
  await openPicker();
  await hover(s, provider);
  await sleep(700);
  await click(s, description);
  await sleep(2500);
};
const CODEX = 'Fast, go-to model for coding and everyday work.';
const CLAUDE = 'Best for everyday, complex tasks';

try {
  fs.mkdirSync(path.join(s.home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(s.home, '.codex/config.toml'), [
    'model_provider = "fake"', '', '[model_providers.fake]', 'name = "fake"',
    `base_url = "http://127.0.0.1:${port}/v1"`, 'wire_api = "responses"', 'request_max_retries = 0', 'stream_max_retries = 0', '',
  ].join('\n'));
  await main("(() => { req('./codex-history').close(); const { Driver } = req('./driver'); const orig = Driver.prototype.current; Driver.prototype.current = function (o) { const r = orig.call(this, o); return r.models.length ? r : { ...r, models: [{ value: 'claude-opus-5-5', displayName: 'Opus 5.5 (stand-in)' }] }; }; return 1; })()");
  await click(s, 'Later').catch(() => {});

  // Claude, then ChatGPT, then Claude again.
  await send('e2e first ALPHA');
  check('claude answers the first message', await waitReply('heard: e2e first ALPHA'));
  await pick('ChatGPT', CODEX);
  check('the switch draws a pending handoff row', (await handoffRows()).some((l) => /Claude → ChatGPT .* the next message carries/.test(l)), await handoffRows());
  await send('e2e second BRAVO');
  check('codex answers', await waitReply('codex heard: e2e second BRAVO'));
  const toCodex = lastCodexUser();
  check('codex is handed the whole chat ahead of the message', /<conn-handoff [^>]*scope="full"/.test(toCodex) && toCodex.includes('e2e first ALPHA') && toCodex.endsWith('User message:\ne2e second BRAVO'), toCodex.slice(0, 300));
  check('the bubble shows only what was typed', !(await page("document.body.innerText.includes('<conn-handoff')")));
  check('the row says what went across', (await handoffRows()).some((l) => /carried 2 of 2 items/.test(l)), await handoffRows());
  const head = Object.keys(segmentsOnDisk())[0];
  check('the switch is written down under the first session', !!head, segmentsOnDisk());

  await pick('Claude', CLAUDE);
  await send('e2e third CHARLIE');
  check('claude answers after the switch back', await waitReply('heard: e2e third CHARLIE'));
  const back = claudeUsers(head).at(-1) || '';
  check('claude resumes its own session and gets only the delta', /scope="since"/.test(back) && back.includes('e2e second BRAVO') && !back.includes('e2e first ALPHA'), back.slice(0, 300));
  await shot(s, path.join(SHOTS, 'e2e-01-three-segments.png'));

  // Reopen from the rail.
  await reload();
  const rows = await railRows();
  check('the rail shows the switched chat as one row', rows.filter((r) => /ALPHA|BRAVO|CHARLIE/.test(r)).length === 1, rows);
  await click(s, 'e2e first ALPHA');
  await until(() => page("document.body.innerText.includes('e2e third CHARLIE')"));
  const text = await page('document.body.innerText');
  const order = ['e2e first ALPHA', 'e2e second BRAVO', 'e2e third CHARLIE'].map((t) => text.lastIndexOf(t));
  check('reopen puts the segments back in order', order.every((n, i) => n > 0 && (i === 0 || n > order[i - 1])), order);
  check('reopen draws a handoff row between segments', (await handoffRows()).length === 2, await handoffRows());
  await shot(s, path.join(SHOTS, 'e2e-02-reopened.png'));

  // A plain chat opened from the rail and then switched must still fold into one row.
  await click(s, 'New chat');
  await sleep(800);
  await send('e2e plain LIMA');
  await waitReply('heard: e2e plain LIMA');
  await reload();
  await click(s, 'e2e plain LIMA');
  await until(() => page("document.body.innerText.includes('heard: e2e plain LIMA')"));
  await pick('ChatGPT', CODEX);
  await send('e2e plain then codex MIKE');
  await waitReply('codex heard: e2e plain then codex MIKE');
  await sleep(1500);
  const lima = Object.values(segmentsOnDisk()).some((segs) => segs.some((x) => x.provider === 'codex') && segs.length === 2 && segs[0].provider === 'claude' && !segs.some((x) => x.session === head));
  check('a chat reopened from the rail and then switched has its segments written down', lima, segmentsOnDisk());
  await reload();
  const after = await railRows();
  check('and stays one row in the rail', after.filter((r) => /LIMA|MIKE/.test(r)).length === 1, after);
  await shot(s, path.join(SHOTS, 'e2e-03-reopened-then-switched.png'));

  // The same the other way: a ChatGPT chat reopened from the rail, switched to
  // Claude, whose new session reports ready while the send is still settling.
  await click(s, 'New chat');
  await sleep(800);
  await pick('ChatGPT', CODEX);
  await send('e2e codex plain OSCAR');
  await waitReply('codex heard: e2e codex plain OSCAR');
  await reload();
  await click(s, 'e2e codex plain OSCAR');
  await until(() => page("document.body.innerText.includes('codex heard: e2e codex plain OSCAR')"));
  // One more turn on codex first, so a live codex session is parked by the switch.
  await send('e2e codex plain again OSCAR2');
  await waitReply('codex heard: e2e codex plain again OSCAR2');
  await pick('Claude', CLAUDE);
  await send('e2e codex plain then claude PAPA');
  await waitReply('heard: e2e codex plain then claude PAPA');
  await sleep(1500);
  const oscar = Object.values(segmentsOnDisk()).some((segs) => segs.length === 2 && segs[0].provider === 'codex' && segs[1].provider === 'claude');
  check('a ChatGPT chat reopened from the rail and switched to Claude has its segments written down', oscar, segmentsOnDisk());
  await reload();
  const after2 = await railRows();
  check('and stays one row in the rail (Claude target)', after2.filter((r) => /OSCAR|PAPA/.test(r)).length === 1, after2);
  await shot(s, path.join(SHOTS, 'e2e-04-codex-reopened-then-claude.png'));

  // Delete the three-segment chat from the rail.
  const codexId = (segmentsOnDisk()[head] || []).find((x) => x.provider === 'codex')?.session;
  const rollouts = () => {
    const out = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else out.push(f); } };
    try { walk(path.join(s.home, '.codex/sessions')); } catch {}
    return out;
  };
  await click(s, 'Delete e2e first ALPHA').catch(async () => {
    await hover(s, 'e2e first ALPHA');
    await click(s, 'Delete e2e first ALPHA');
  });
  await click(s, 'Delete');
  await sleep(4000);
  const claudeGone = !claudeUsers(head).length;
  check('delete removes the claude transcript', claudeGone);
  check('delete removes the codex thread', !!codexId && !rollouts().some((f) => f.includes(codexId)), { codexId, rollouts: rollouts() });
  check('delete forgets the record', !segmentsOnDisk()[head], segmentsOnDisk());
  check('delete removes the row', !(await railRows()).some((r) => /ALPHA/.test(r)), await railRows());
} catch (e) {
  check('the run finished', false, e.stack);
} finally {
  const off = net.stop();
  check('no agent and no provider API was reached off the machine', !off.bad.length, off.bad);
  console.log(`NOTE the app's own traffic off the machine (update checks, model download): ${JSON.stringify(off.app.map((x) => x.peer))}`);
  await stop(s).catch((e) => console.log(`NOTE stop failed: ${e.message}`));
  api.kill();
  cleanupShims();
  fs.rmSync(log, { force: true });
}

console.log(failures.length ? `\n${failures.length} failed: ${failures.join(', ')}` : '\nall passed');
process.exit(failures.length ? 1 : 0);
