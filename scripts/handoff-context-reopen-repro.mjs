#!/usr/bin/env node
/* A Claude chat reopened off disk and then switched records how full Claude's
   window was, read from its transcript, so switching back later sizes the
   handoff against it. Safe harness: stub ACP agents, local stand-ins, Xvfb. */
import { drive, safeBoot, watchNet, cleanupShims, providerAddresses } from './handoff-harness.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { stop, click, hover, type, evaluate } = drive;
const failures = [];
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` ${JSON.stringify(detail)?.slice(0, 600)}`}`); if (!ok) failures.push(name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 30000) => { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v || Date.now() > end) return v; await sleep(250); } };
const log = path.join(os.tmpdir(), `fake-responses-${process.pid}.jsonl`);
const api = spawn(process.execPath, [path.join(ROOT, 'scripts/fake-responses-api.mjs'), log], { stdio: ['ignore', 'pipe', 'inherit'] });
const port = await new Promise((resolve) => api.stdout.on('data', (d) => { const m = /port (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));
const s = await safeBoot({ codexPort: port });
const net = watchNet(s, await providerAddresses());
const page = (e) => evaluate(s, e);
const main = (e) => evaluate(s, e, { main: true });
const has = (t) => page(`document.body.innerText.includes(${JSON.stringify(t)})`);
try {
  await click(s, 'Later').catch(() => {});
  await page("document.querySelector('#composer [contenteditable=\"true\"]').focus()");
  await type(s, 'ctx ALPHA', { enter: true });
  await until(() => has('heard: ctx ALPHA'));
  await sleep(2000);
  const dir = path.join(s.home, '.claude/projects', s.project.replace(/[/.]/g, '-'));
  const file = fs.readdirSync(dir).find((f) => f.endsWith('.jsonl'));
  const usage = fs.readFileSync(path.join(dir, file), 'utf8').trim().split('\n').map(JSON.parse).filter((o) => o.type === 'assistant' && o.message?.usage).at(-1)?.message.usage;
  const size = (usage?.input_tokens || 0) + (usage?.cache_read_input_tokens || 0) + (usage?.cache_creation_input_tokens || 0);
  console.log(`NOTE Claude's last request in the transcript: ${size} tokens ${JSON.stringify(usage)}`);
  await main("(() => { const w = electron.BrowserWindow.getAllWindows().find((w) => /index\\.html/.test(w.webContents.getURL())); w.webContents.reload(); return 1; })()");
  await sleep(7000);
  await click(s, 'ctx ALPHA');
  await until(() => has('heard: ctx ALPHA'));
  await sleep(1000);
  const at = await page(`(() => { const b = [...document.querySelectorAll('#composer button[data-slot=dropdown-menu-trigger]')].find((e) => /Opus|Sonnet|Haiku|Fable|GPT|Auto|Pick a model/.test(e.innerText)); const r = b.getBoundingClientRect(); return Math.round(r.x + r.width / 2) + ',' + Math.round(r.y + r.height / 2); })()`);
  await click(s, `xy=${at}`);
  await sleep(400);
  await hover(s, 'ChatGPT');
  await sleep(700);
  await click(s, 'Fast, go-to model for coding and everyday work.');
  await sleep(3000);
  await page("document.querySelector('#composer [contenteditable=\"true\"]').focus()");
  await type(s, 'ctx BRAVO', { enter: true });
  await until(() => has('codex heard: ctx BRAVO'));
  await sleep(2000);
  const rec = Object.values(JSON.parse(fs.readFileSync(path.join(s.home, '.conn/chat-segments.json'), 'utf8')))[0];
  console.log(`NOTE record: ${JSON.stringify(rec)}`);
  check('the reopened Claude stretch is saved with the window size its transcript reports', rec?.[0]?.context === size && size > 0, { rec, size });
} catch (e) {
  check('the run finished', false, e.stack);
} finally {
  const off = net.stop();
  check('no agent and no provider API was reached off the machine', !off.bad.length, off.bad);
  await stop(s).catch((e) => console.log(`NOTE stop failed: ${e.message}`));
  api.kill();
  fs.rmSync(log, { force: true });
  cleanupShims();
}
console.log(failures.length ? `\n${failures.length} failed: ${failures.join(', ')}` : '\nall passed');
process.exit(failures.length ? 1 : 0);
