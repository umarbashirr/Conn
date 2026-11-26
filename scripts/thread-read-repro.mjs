#!/usr/bin/env node
/* conn_thread_read end to end, through handoff-harness.mjs: the real claude CLI
   against the stand-in API, the real codex CLI against fake-responses-api.mjs,
   Xvfb, a throwaway HOME, and no account.

   A. Into ChatGPT, the main case. A Claude chat is filled past the handoff's
      budget and switched to ChatGPT; what codex is handed names what it left
      out and names the tool. Codex is not made to call the tool itself: the
      fake Responses API gets no tools from codex for this provider (its
      requests carry none, its own shell tool included), and codex keeps MCP
      tools behind a client-side tool_search the fake cannot drive. So the
      proof is the live session's own: the conn server and chat key are read
      off the codex app-server's command line, that same server is started
      over stdio with that environment, and conn_thread_read with a left-out
      id returns that item. After a reload, the chat's next codex session
      reads the same id the same way.
   B. Into Claude. A ChatGPT chat is filled and switched to Claude, which calls
      conn_thread_read itself (the stand-in API scripts the call), gets the
      left-out item, and the transcript draws a "Read 1 earlier item" row;
      again after a reload.
   Screenshots go to SHOT_DIR (default /tmp/handoff-verify/thread). */
import { drive, safeBoot, watchNet, cleanupShims, providerAddresses, requireRoot } from './handoff-harness.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { stop, click, hover, type, shot, evaluate } = drive;
const { Client } = requireRoot('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = requireRoot('@modelcontextprotocol/sdk/client/stdio.js');
const SHOTS = process.env.SHOT_DIR || '/tmp/handoff-verify/thread';
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
const openPicker = async () => {
  const at = await page(`(() => { const b = [...document.querySelectorAll('#composer button[data-slot=dropdown-menu-trigger]')].find((e) => /Opus|Sonnet|Haiku|Fable|GPT|Auto|Pick a model/.test(e.innerText)); const r = b.getBoundingClientRect(); return Math.round(r.x + r.width / 2) + ',' + Math.round(r.y + r.height / 2); })()`);
  await click(s, `xy=${at}`);
  await sleep(400);
};
// `row` is the model's line in the provider's submenu; without one, the first
// line, since Claude's list is the harness's stand-in row until a session has
// taught it the real ones and the real ones after.
const pick = async (provider, row) => {
  await openPicker();
  await hover(s, provider);
  await sleep(700);
  if (row) await click(s, row);
  else {
    const at = await page(`(() => { const r = document.querySelector('[data-slot=dropdown-menu-sub-content] [role=menuitem]').getBoundingClientRect(); return Math.round(r.x + r.width / 2) + ',' + Math.round(r.y + r.height / 2); })()`);
    await click(s, `xy=${at}`);
  }
  await sleep(2500);
};
const reload = async () => {
  await main("(() => { const w = electron.BrowserWindow.getAllWindows().find((w) => /index\\.html/.test(w.webContents.getURL())); w.webContents.reload(); return 1; })()");
  await sleep(7000);
};
const startChat = async (provider, title) => {
  const key = await evaluate(s, `window.connChat.spawn({ provider: ${J(provider)}, title: ${J(title)} })`, { awaitPromise: true });
  await page(`window.connChat.open({ key: ${J(key)}, title: ${J(title)} }), 1`);
  await sleep(800);
  return key;
};
// Six long asks, about 6k tokens each, so a 16k budget leaves some out.
const filler = (n) => `MARK-${n} ${'lorem ipsum dolor sit amet '.repeat(900)}`;
const fill = async (key, tag, heard) => {
  for (let n = 0; n < 6; n++) {
    await page(`window.connChat.sendTo(${J(key)}, ${J(`${filler(n)}\n${tag} ASK${n}`)}), 1`);
    if (!(await waitText(`${heard}${tag} ASK${n}`))) return false;
    await sleep(400);
  }
  return true;
};
const leftOut = (handoff) => {
  const m = /Left out to fit your context window \(\d+ of \d+ items\): ([^\n]+)\./.exec(handoff || '');
  return m ? m[1].split(/[ ,]/)[0] : null;
};
const markOf = (text) => /MARK-(\d+)/.exec(text || '')?.[0] || null;

// What codex was handed: the user text of its requests.
const codexUserTexts = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [])
  .flatMap((r) => (Array.isArray(r?.body?.input) ? r.body.input : []).filter((x) => x.role === 'user'))
  .map((x) => (x.content || []).map((c) => c.text || '').join('\n'));
// The codex app-server processes this app started, oldest first, each as its argv.
const codexLaunches = () => {
  const out = [];
  for (const pid of fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
    try {
      const env = `\0${fs.readFileSync(`/proc/${pid}/environ`, 'utf8')}`;
      if (!env.includes(`\0HOME=${s.home}\0`)) continue;
      const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
      if (argv.includes('app-server') && argv.some((x) => x.startsWith('mcp_servers.conn.'))) out.push({ pid: Number(pid), argv });
    } catch {}
  }
  return out.sort((a, b) => a.pid - b.pid);
};
const connOf = (argv) => {
  const conf = Object.fromEntries(argv.filter((a) => a.startsWith('mcp_servers.conn.')).map((a) => { const at = a.indexOf('='); return [a.slice('mcp_servers.conn.'.length, at), JSON.parse(a.slice(at + 1))]; }));
  if (!conf.command) return null;
  return { command: conf.command, args: conf.args, env: Object.fromEntries(Object.entries(conf).filter(([k]) => k.startsWith('env.')).map(([k, v]) => [k.slice(4), v])) };
};
const callAsGiven = async (server, id) => {
  const client = new Client({ name: 'thread-read-repro', version: '0' });
  await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env: { PATH: process.env.PATH, HOME: s.home, ...server.env } }));
  try {
    const { tools } = await client.listTools();
    const res = await client.callTool({ name: 'conn_thread_read', arguments: { ids: [id] } });
    return { listed: tools.some((t) => t.name === 'conn_thread_read'), text: res.content.map((c) => c.text).join('') };
  } finally {
    await client.close();
  }
};
// What the claude CLI wrote down: its prompts and the tool results it got.
const claudeLines = () => {
  const root = path.join(s.home, '.claude/projects');
  const out = [];
  for (const d of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    for (const f of fs.readdirSync(path.join(root, d)).filter((x) => x.endsWith('.jsonl'))) {
      for (const l of fs.readFileSync(path.join(root, d, f), 'utf8').split('\n').filter(Boolean)) { try { out.push(JSON.parse(l)); } catch {} }
    }
  }
  return out;
};
const claudeUserTexts = () => claudeLines().filter((o) => o.type === 'user').map((o) => (typeof o.message.content === 'string' ? o.message.content : o.message.content.map((b) => b.text || '').join('')));
const claudeToolResults = () => claudeLines().filter((o) => o.type === 'user' && Array.isArray(o.message.content))
  .flatMap((o) => o.message.content.filter((b) => b.type === 'tool_result'))
  .map((b) => (typeof b.content === 'string' ? b.content : (b.content || []).map((x) => x.text || '').join('')))
  .filter((t) => /of this chat's/.test(t));
const rows = () => page("JSON.stringify([...document.querySelectorAll('button')].map((b) => b.innerText).filter((t) => /earlier item/.test(t)))").then(JSON.parse);
const CODEX_ROW = 'Fast, go-to model for coding and everyday work.';

try {
  await click(s, 'Later').catch(() => {});

  // ---------------------------------------------------------------- A. into ChatGPT
  const a = await startChat('claude', 'Into codex');
  check('A: claude answers six long asks', await fill(a, 'thrA', 'heard: '));
  await pick('ChatGPT', CODEX_ROW);
  await send('thrA SWITCHED');
  check('A: codex answers after the switch', !!(await waitText('codex heard: thrA SWITCHED')));
  const handedA = codexUserTexts().find((t) => t.includes('<conn-handoff')) || '';
  const idA = leftOut(handedA);
  check('A: what codex is handed leaves items out and says which', !!idA, handedA.slice(0, 400));
  check('A: and names conn_thread_read', /Read any of them with conn_thread_read/.test(handedA), handedA.slice(0, 400));
  const launchA = codexLaunches().at(-1);
  const serverA = launchA && connOf(launchA.argv);
  check('A: the codex session is launched with the conn server and a chat key', !!serverA?.env?.CONN_CHAT, launchA?.argv?.filter((x) => /mcp_servers\.conn/.test(x)));
  const readA = serverA ? await callAsGiven(serverA, idA) : null;
  check('A: that server lists conn_thread_read and returns the left-out item', !!readA?.listed && readA.text.includes(`id="${idA}"`) && !!markOf(readA.text), (readA?.text || '').slice(0, 300));
  console.log(`NOTE A: ${idA} is ${markOf(readA?.text)}, chat ${serverA?.env?.CONN_CHAT}`);
  await click(s, 'Later').catch(() => {});
  await shot(s, path.join(SHOTS, 'thread-read-into-codex.png'));

  await reload();
  await click(s, 'Into codex');
  await waitText('thrA SWITCHED', 20000);
  await sleep(1500);
  await send('thrA AGAIN');
  check('A: after a reload codex answers in the reopened chat', !!(await waitText('codex heard: thrA AGAIN')));
  const relaunchA = codexLaunches().at(-1);
  const serverA2 = relaunchA && connOf(relaunchA.argv);
  const readA2 = serverA2 ? await callAsGiven(serverA2, idA) : null;
  check('A: its new session reads the same id as the same item', !!readA2 && readA2.text.includes(`id="${idA}"`) && markOf(readA2.text) === markOf(readA?.text),
    { before: markOf(readA?.text), after: markOf(readA2?.text), chat: serverA2?.env?.CONN_CHAT });

  // ---------------------------------------------------------------- B. into Claude
  await click(s, 'New chat');
  await sleep(800);
  const b = await startChat('codex', 'Into claude');
  check('B: codex answers six long asks', await fill(b, 'thrB', 'codex heard: '));
  await pick('Claude');
  await send('thrB SWITCHED');
  check('B: claude answers after the switch', !!(await waitText('heard: thrB SWITCHED')));
  const handedB = claudeUserTexts().find((t) => t.includes('<conn-handoff') && t.includes('thrB')) || '';
  const idB = leftOut(handedB);
  check('B: what claude is handed leaves items out and names the tool', !!idB && /Read any of them with conn_thread_read/.test(handedB), handedB.slice(0, 400));
  await send(`tool mcp__preview__conn_thread_read {"ids":["${idB}"]}`);
  const readB = await until(async () => claudeToolResults()[0], 60000);
  check('B: claude calls conn_thread_read itself and gets the left-out item', !!readB && readB.includes(`id="${idB}"`) && !!markOf(readB), (readB || '').slice(0, 300));
  check('B: the transcript draws the call as a compact row', !!(await until(async () => (await rows()).some((t) => /Read 1 earlier item/.test(t)), 15000)), await rows());
  await click(s, 'Later').catch(() => {});
  await shot(s, path.join(SHOTS, 'thread-read-row.png'));

  await reload();
  await click(s, 'Into claude');
  await waitText('thrB SWITCHED', 20000);
  await sleep(1500);
  await send(`tool mcp__preview__conn_thread_read {"ids":["${idB}"]}`);
  const readB2 = await until(async () => claudeToolResults()[1], 60000);
  check('B: after a reload the same id gives the same item', !!readB2 && readB2.includes(`id="${idB}"`) && markOf(readB2) === markOf(readB), { before: markOf(readB), after: markOf(readB2) });
  await shot(s, path.join(SHOTS, 'thread-read-after-reload.png'));
} catch (e) {
  check('the run finished', false, e.stack);
} finally {
  const traffic = net.stop();
  check('no agent process reached the network, and nothing reached a provider', traffic.bad.length === 0, traffic.bad);
  if (!process.env.KEEP) await stop(s).catch(() => {});
  api.kill();
  if (fs.existsSync(log)) fs.copyFileSync(log, path.join(SHOTS, 'codex-requests.jsonl'));
  fs.rmSync(log, { force: true });
  cleanupShims();
}

console.log(failures.length ? `\n${failures.length} failed: ${failures.join(', ')}` : '\nall passed');
process.exit(failures.length ? 1 : 0);
