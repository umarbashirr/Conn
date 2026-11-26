#!/usr/bin/env node
/* conn_thread_read, verified on handoff-harness.mjs (stub ACP agents, the real
   claude CLI against the stand-in API, the real codex CLI against
   fake-responses-api.mjs, Xvfb, a throwaway HOME, no account).

   X  Codex calls the tool itself. With a model codex knows (gpt-6.2-sol) it
      runs in code mode, MCP tools deferred behind `exec`; the fake API answers
      `codex-read <json>` with an exec call to tools.mcp__conn__conn_thread_read,
      so the real codex loop, Conn's approval of the call and the conn server
      are all in the path. The chat is a 1000-message Claude transcript opened
      from the rail (only its end read in), switched to ChatGPT.
   Q  Query, cursor, and scope: a query finds this chat's words and never
      another chat's; ids or a chat key passed as arguments change nothing.
   U  The conn server started with the live session's own environment but
      another CONN_CHAT, or none.
   S  The same ids after a reload, a reopen from the rail and a true restart,
      plain (h<n>) and from the ChatGPT stretch (s1:...), the latter read by
      Claude itself after a switch back, drawn as "Read N earlier items".
   F  A fork's handoff names no tool; one into the stub Copilot names it, and
      the stub really was given the conn server for that chat.
   SHOT_DIR names the screenshot folder (default /tmp/handoff-verify/pr2). */
import { drive, safeBoot, watchNet, cleanupShims, providerAddresses, requireRoot, assertSafeEnv, STUB_LOG } from './handoff-harness.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { stop, click, hover, key, type, shot, evaluate } = drive;
const { Client } = requireRoot('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = requireRoot('@modelcontextprotocol/sdk/client/stdio.js');
const SHOTS = process.env.SHOT_DIR || '/tmp/handoff-verify/pr2';
fs.mkdirSync(SHOTS, { recursive: true });
const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` ${JSON.stringify(detail)?.slice(0, 700)}`}`);
  if (!ok) failures.push(name);
};
const note = (what, v) => console.log(`NOTE ${what}: ${JSON.stringify(v)?.slice(0, 900)}`);
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
const page = (e) => evaluate(s, e);
const main = (e) => evaluate(s, e, { main: true });
const has = (t) => page(`document.body.innerText.includes(${J(t)})`);
const send = async (t) => { await page("document.querySelector('#composer [contenteditable=\"true\"]').focus()"); await type(s, t, { enter: true }); };
const reload = async () => {
  await main("(() => { const w = electron.BrowserWindow.getAllWindows().find((w) => /index\\.html/.test(w.webContents.getURL())); w.webContents.reload(); return 1; })()");
  await sleep(7000);
};
const idle = () => until(async () => !(await page("!!document.querySelector('#composer button[aria-label=Stop]')")), 90000);
const trigger = () => page(`(() => { const b = [...document.querySelectorAll('#composer button[data-slot=dropdown-menu-trigger]')].find((e) => /Opus|Sonnet|Haiku|Fable|GPT|Auto|Stub|Pick a model/.test(e.innerText)); const r = b.getBoundingClientRect(); return Math.round(r.x + r.width / 2) + ',' + Math.round(r.y + r.height / 2); })()`);
const pick = async (provider) => {
  await click(s, `xy=${await trigger()}`);
  await sleep(400);
  await hover(s, { codex: 'ChatGPT', copilot: 'Copilot', claude: 'Claude' }[provider]);
  await sleep(700);
  if (provider === 'codex') await click(s, 'Fast, go-to model for coding and everyday work.');
  else { await key(s, 'Right'); await sleep(300); await key(s, 'Enter'); }
  await sleep(2500);
};
const rows = async () => {
  await page('window.connRail?.refresh()');
  await sleep(2000);
  return JSON.parse(await page("JSON.stringify([...document.querySelectorAll('li[data-sidebar=menu-item]')].map((e) => e.innerText.split('\\n')[0]))"));
};
const openRow = async (title) => {
  const at = await page(`(() => { const li = [...document.querySelectorAll('li[data-sidebar=menu-item]')].find((e) => e.innerText.split('\\n')[0] === ${J(title)}); if (!li) return null; const r = li.getBoundingClientRect(); return Math.round(r.x + 60) + ',' + Math.round(r.y + r.height / 2); })()`);
  if (!at) throw new Error(`no rail row ${title}`);
  await click(s, `xy=${at}`);
  await sleep(6000);
};
const requests = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
// What each turn was handed, an injected handoff read as the text it carries.
const codexUser = () => requests().map((r) => r.seen?.handed ?? ((r.body?.input || []).filter((m) => m.role === 'user').at(-1)?.content?.map((c) => c.text).join('\n') || ''));
// What codex's exec call got back from the tool on the turn that started at
// request `from`. Every request carries the whole thread, so a turn's first
// request already repeats each earlier turn's outputs: only an output after the
// turn's own user message is this turn's.
const outputText = (m) => (typeof m.output === 'string' ? m.output : m.output.map((x) => x.text || '').join('\n'));
const turnOutput = (from) => {
  for (const r of requests().slice(from).reverse()) {
    const input = r.body?.input || [];
    const u = input.findLastIndex((m) => m.role === 'user');
    const out = input.slice(u + 1).filter((m) => m.type === 'custom_tool_call_output').at(-1);
    if (out) return outputText(out);
  }
  return null;
};
// One read through codex: send, wait for its answer, return the tool's text.
let reads = 0;
const codexRead = async (args) => {
  const from = requests().length;
  await send(`codex-read ${J(args)}`);
  const got = await until(async () => turnOutput(from), 90000);
  await idle();
  reads += 1;
  return got || '';
};
const itemText = (out, id) => (new RegExp(`<item id="${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>\\n([\\s\\S]*?)\\n<\\/item>`).exec(out) || [])[1] || null;

// A 1000-message Claude chat, and a second chat whose words must never leak.
const projDir = () => path.join(s.home, '.claude/projects', s.project.replace(/[/.]/g, '-'));
const BIG = '5e551011-0000-4000-8000-0000000b1600';
const OTHER = '5e551011-0000-4000-8000-0000000a0e00';
function writeTranscript(id, n, said, at0) {
  fs.mkdirSync(projDir(), { recursive: true });
  const uuid = (i) => `00000000-0000-4000-8000-${id.slice(-4)}${String(i).padStart(8, '0')}`;
  const lines = Array.from({ length: n }, (_, i) => {
    const typ = i % 2 ? 'assistant' : 'user';
    const content = i % 2 ? [{ type: 'text', text: `answer ${(i - 1) / 2}` }] : said(i / 2);
    return J({ type: typ, uuid: uuid(i), parentUuid: i ? uuid(i - 1) : null, sessionId: id, cwd: s.project, timestamp: new Date(at0 + i * 60000).toISOString(), message: { role: typ, content } });
  });
  fs.writeFileSync(path.join(projDir(), `${id}.jsonl`), `${lines.join('\n')}\n`);
}

let firstH2 = null;
let sId = null;
let sText = null;
try {
  await main("(() => { const h = electron.ipcMain._invokeHandlers; const send = h.get('agent:send'); h.set('agent:send', (e, a) => { globalThis.__lastChat = a.chat; return send(e, a); }); return 1; })()");
  await click(s, 'Later').catch(() => {});
  writeTranscript(BIG, 1000, (k) => (k === 0 ? 'big chat goal quark-0' : `question ${k} quark-${k}`), Date.UTC(2026, 9, 1));
  writeTranscript(OTHER, 6, (k) => `secret-other-chat zebra ${k}`, Date.UTC(2026, 8, 1));
  await reload();
  const r0 = await rows();
  note('rail', r0);
  await openRow(r0.find((x) => /big chat goal/.test(x)));
  check('X: the long chat opens on its end only', !(await page("(document.querySelector('#agent-root [role=log]') || document.body).innerText.includes('big chat goal quark-0')")), 'its first message is on screen');
  await pick('codex');

  // ---- X: codex calls the tool itself ----------------------------------------
  let out1 = await codexRead({ ids: ['h2'] });
  // The first turn after the switch starts codex's MCP servers; the tool may
  // not be there yet on that turn. Noted, then asked once more.
  const firstTurnMissed = /is not a function/.test(out1);
  note('X: the tool was missing on the first turn after the switch', firstTurnMissed);
  if (firstTurnMissed) out1 = await codexRead({ ids: ['h2'] });
  const handed = codexUser().find((t) => t.includes('<conn-handoff')) || '';
  note('header codex was handed', handed.split('\n').slice(0, 5));
  check('X: the handoff to codex leaves items out and names the tool, with how to call it', /Left out to fit/.test(handed) && /Read any of them with conn_thread_read: \{"ids":/.test(handed), handed.slice(0, 600));
  firstH2 = itemText(out1, 'h2');
  note('X: what codex got for h2', out1.slice(0, 400));
  check('X: codex itself called conn_thread_read and got h2 of this chat', firstH2 === 'question 1 quark-1', out1.slice(0, 400));
  check('X: the answer reached the model and the chat', await until(() => has('codex read:'), 20000), 'no codex read: reply');
  await shot(s, path.join(SHOTS, 'X-codex-called.png'), { preview: false });

  // ---- Q: query, cursor, scope -------------------------------------------------
  const q = await codexRead({ query: 'quark-321' });
  check('Q: a query finds this chat\'s words', /id="h642"[^>]*>\nquestion 321 quark-321/.test(q), q.slice(0, 300));
  const leak = await codexRead({ query: 'secret-other-chat' });
  // The only match is the message that asked, which is this chat's own.
  check('Q: a query never returns another chat\'s words', !/zebra/.test(leak) && !/secret-other-chat zebra/.test(leak), leak.slice(0, 300));
  const forged = await codexRead({ ids: ['h2'], chat: `h:claude:${OTHER}`, CONN_CHAT: `h:claude:${OTHER}` });
  note('Q: a read with another chat named in its arguments', forged.slice(0, 300));
  check('Q: naming another chat in the arguments changes nothing', !/zebra/.test(forged), forged.slice(0, 300));
  const page1 = await codexRead({ before: 'h20', limit: 3 });
  const nextArgs = /More: call conn_thread_read with (\{.*\})/.exec(page1)?.[1];
  check('Q: a page says how to ask for the next one', !!nextArgs && /h1[4-9]/.test(page1), page1.slice(0, 400));
  if (nextArgs) {
    const page2 = await codexRead(JSON.parse(nextArgs));
    check('Q: following next gives the earlier items of this chat', /id="h1[0-4]"|id="h1[0-3]\.0"/.test(page2) && !/zebra/.test(page2), page2.slice(0, 300));
  }

  // How codex's calls show in the chat: code mode runs the tool inside `exec`.
  const codexRows = await page("JSON.stringify([...document.querySelectorAll('button, [role=button]')].map((b) => b.innerText.trim().split('\\n')[0]).filter((t) => /earlier item|exec|thread/i.test(t)))").then(JSON.parse);
  note('X: rows the codex calls drew', codexRows);
  check('X: a codex call draws as "Read N earlier items"', codexRows.some((r) => /^Read \d+ earlier items?$/.test(r)), codexRows);
  await shot(s, path.join(SHOTS, 'X-codex-rows.png'), { preview: false });

  // ---- U: the server with another CONN_CHAT, or none ----------------------------
  const launch = (() => {
    for (const pid of fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p)).sort((a, b) => b - a)) {
      try {
        const env = `\0${fs.readFileSync(`/proc/${pid}/environ`, 'utf8')}`;
        if (!env.includes(`\0HOME=${s.home}\0`)) continue;
        const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
        if (argv.includes('app-server') && argv.some((x) => x.startsWith('mcp_servers.conn.'))) return argv;
      } catch {}
    }
    return null;
  })();
  const conf = Object.fromEntries((launch || []).filter((a) => a.startsWith('mcp_servers.conn.')).map((a) => { const at = a.indexOf('='); return [a.slice('mcp_servers.conn.'.length, at), JSON.parse(a.slice(at + 1))]; }));
  const env = Object.fromEntries(Object.entries(conf).filter(([k]) => k.startsWith('env.')).map(([k, v]) => [k.slice(4), v]));
  note('the live codex session\'s conn server', { command: conf.command, chat: env.CONN_CHAT });
  const callWith = async (envOver) => {
    const e = { PATH: process.env.PATH, HOME: s.home, ...env, ...envOver };
    for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
    assertSafeEnv(e, 'conn server');
    const client = new Client({ name: 'verify', version: '0' });
    await client.connect(new StdioClientTransport({ command: conf.command, args: conf.args, env: e }));
    try {
      const { tools } = await client.listTools();
      const listed = tools.some((t) => t.name === 'conn_thread_read');
      if (!listed) return { listed, text: null };
      const res = await client.callTool({ name: 'conn_thread_read', arguments: { ids: ['h2'] } });
      return { listed, text: res.content.map((c) => c.text).join(''), isError: !!res.isError };
    } finally { await client.close(); }
  };
  const unknown = await callWith({ CONN_CHAT: 'no-such-chat-key' });
  note('U: CONN_CHAT names no chat', unknown);
  check('U: an unknown CONN_CHAT gets a clear error', unknown.listed && unknown.isError && /no-such-chat-key/.test(unknown.text || ''), unknown);
  const none = await callWith({ CONN_CHAT: undefined });
  check('U: a server with no CONN_CHAT does not offer the tool', none.listed === false, none);
  const other = await callWith({ CONN_CHAT: `h:claude:${OTHER}` });
  note('U: a server started by hand with another chat\'s h: key and this bridge\'s token', { isError: other.isError, text: (other.text || '').slice(0, 200) });

  // ---- S: the same ids later ---------------------------------------------------
  await reload();
  await openRow((await rows()).find((x) => /big chat goal/.test(x)));
  const again = itemText(await codexRead({ ids: ['h2'] }), 'h2');
  check('S: h2 reads the same after a reload and a reopen from the rail', again === firstH2, { firstH2, again });

  // Back to Claude: it reads the ChatGPT stretch by its s1: ids itself.
  await pick('claude');
  const sOut = await (async () => {
    await send('tool mcp__preview__conn_thread_read {"query":"codex read"} ;; say: read it');
    await until(() => has('read it'), 60000);
    await idle();
    const results = claudeResults();
    return results.at(-1) || '';
  })();
  sId = /<item id="(s1:[^"]+)"/.exec(sOut)?.[1] || null;
  sText = sId ? itemText(sOut, sId) : null;
  note('S: what Claude read from the ChatGPT stretch', sOut.slice(0, 400));
  check('S: Claude calls the tool itself and gets the ChatGPT stretch under s1: ids', !!sId && !!sText, sOut.slice(0, 300));
  check('S: the call draws as "Read N earlier items"', await until(() => page("[...document.querySelectorAll('button, [role=button], div')].some((b) => /^Read \\d+ earlier items?$/.test(b.innerText.trim().split('\\n')[0]))"), 10000), 'no Read N earlier items row');
  await shot(s, path.join(SHOTS, 'S-claude-read-row.png'), { preview: false });

  // A true restart; then both ids again, h2 through codex and s1: through Claude.
  await restart(s);
  await openRow((await rows()).find((x) => /big chat goal/.test(x)));
  await send(`tool mcp__preview__conn_thread_read ${J({ ids: ['h2', sId] })} ;; say: read after restart`);
  await until(() => has('read after restart'), 60000);
  await idle();
  const after = claudeResults().at(-1) || '';
  check('S: after a true restart, h2 and the s1: id read the same', itemText(after, 'h2') === firstH2 && itemText(after, sId) === sText, { h2: itemText(after, 'h2'), s1: itemText(after, sId), want: [firstH2, sText] });
  check('S: carried or quoted history is not returned as an ordinary turn: handoff text never appears in an answer', !/<conn-handoff/.test(after), after.slice(0, 300));
  note('S: how an answer starts', after.split('\n').slice(0, 2));

  // ---- M: the first turn after a switch, again and again ---------------------
  // Each switch back to ChatGPT starts codex and its MCP servers afresh; the
  // read rides on that first turn, the one the handoff travels with.
  let misses = 0;
  const firsts = Number(process.env.FIRST_TURNS || 3);
  for (let i = 0; i < firsts; i++) {
    await pick('codex');
    const o = await codexRead({ ids: ['h2'] });
    const miss = /is not a function/.test(o);
    if (miss) misses += 1;
    note(`M: first turn ${i + 1} after a switch to ChatGPT`, miss ? 'tool missing' : itemText(o, 'h2'));
    await pick('claude');
    await send(`back on claude ${i}`);
    await until(() => has(`heard: back on claude ${i}`), 60000);
    await idle();
  }
  check(`M: the tool is there on the first turn after a switch, ${firsts} times out of ${firsts}`, misses === 0, { misses, firsts });

  // ---- F: forks name no tool; the stub Copilot does --------------------------
  await click(s, `xy=${await trigger()}`);
  await sleep(400);
  await hover(s, 'Fork to a New Chat');
  await sleep(900);
  await click(s, 'Fast, go-to model for coding and everyday work.');
  await sleep(2500);
  const nBefore = codexUser().length;
  await send('fork hello');
  await until(async () => codexUser().length > nBefore, 60000);
  await idle();
  const forkHanded = codexUser().slice(nBefore).find((t) => t.includes('<conn-handoff')) || '';
  // Carried items may quote the tool's name; only the header's own line counts.
  check('F: a fork\'s handoff leaves items out but names no tool', /fork="yes"/.test(forkHanded) && /Left out/.test(forkHanded) && !/Read any of them with conn_thread_read/.test(forkHanded), forkHanded.split('\n').filter((l) => /Left out|Read any/.test(l)));
  // The fork has the same title and is newer, so the original is the last such row.
  await openRow((await rows()).filter((x) => /big chat goal/.test(x)).at(-1));
  await pick('copilot');
  await send('to the stub copilot');
  await until(() => has('acp heard: to the stub copilot'), 90000);
  await idle();
  const stub = fs.existsSync(STUB_LOG) ? fs.readFileSync(STUB_LOG, 'utf8').trim().split('\n').map(JSON.parse) : [];
  const prompt = stub.filter((e) => e.method === 'session/prompt').at(-1)?.params?.text || '';
  // Copilot takes Conn's servers on its command line (--additional-mcp-config).
  const copilotArgs = fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p)).map((p) => {
    try {
      const env = `\0${fs.readFileSync(`/proc/${p}/environ`, 'utf8')}`;
      if (!env.includes(`\0HOME=${s.home}\0`) || !env.includes('STUB_ACP_NAME=copilot')) return null;
      return fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0');
    } catch { return null; }
  }).filter((a) => a && a.includes('--additional-mcp-config')).at(-1) || [];
  const extra = copilotArgs[copilotArgs.indexOf('--additional-mcp-config') + 1];
  const conn = extra ? JSON.parse(extra).mcpServers?.conn : null;
  const connChat = conn?.env?.CONN_CHAT || null;
  note('F: the stub Copilot\'s conn server', { command: conn?.command, chat: connChat });
  check('F: the stub Copilot is handed a header naming the tool', /Read any of them with conn_thread_read/.test(prompt) || !/Left out/.test(prompt), prompt.slice(0, 300));
  check('F: and it was really given the conn server for this chat', !!conn && !!connChat, copilotArgs.slice(0, 6));

  // ---- L: a long message goes across whole ----------------------------------
  await click(s, 'New chat');
  await sleep(800);
  await pick('claude');
  const long = `LONG-START ${'0123456789'.repeat(1200)} LONG-END`;
  // Sent as the composer sends, without typing 12000 characters.
  await page(`window.sendToAgent(${J(long)}), 1`);
  await until(() => has('heard: LONG-START'), 60000);
  await idle();
  await pick('codex');
  const nL = codexUser().length;
  await send('long after the switch');
  await until(async () => codexUser().length > nL, 60000);
  await idle();
  const handedL = codexUser().slice(nL).find((t) => t.includes('<conn-handoff')) || '';
  const carriedLong = /LONG-START (0123456789)+ LONG-END/.exec(handedL)?.[0] || '';
  check('L: a 12000-character message goes across whole, not cut at 6000', carriedLong.length === long.length, { carried: carriedLong.length, typed: long.length });
} catch (e) {
  check('the run finished', false, e.stack);
} finally {
  const off = net.stop();
  check('no agent and no provider API was reached off the machine', !off.bad.length, off.bad);
  console.log(`NOTE the app's own traffic off the machine: ${J(off.app.map((x) => x.peer))}`);
  if (!process.env.KEEP) await stop(s).catch((e) => console.log(`NOTE stop failed: ${e.message}`));
  api.kill();
  fs.rmSync(log, { force: true });
  cleanupShims();
}

function claudeResults() {
  const root = path.join(s.home, '.claude/projects');
  const out = [];
  for (const d of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    for (const f of fs.readdirSync(path.join(root, d)).filter((x) => x.endsWith('.jsonl'))) {
      for (const l of fs.readFileSync(path.join(root, d, f), 'utf8').split('\n').filter(Boolean)) {
        try {
          const o = JSON.parse(l);
          if (o.type !== 'user' || !Array.isArray(o.message?.content)) continue;
          for (const b of o.message.content) {
            if (b.type !== 'tool_result') continue;
            const t = typeof b.content === 'string' ? b.content : (b.content || []).map((x) => x.text || '').join('');
            if (/of this chat's/.test(t)) out.push({ at: o.timestamp || '', t });
          }
        } catch {}
      }
    }
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : 1)).map((x) => x.t);
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
  await main("(() => { req('./codex-history').close(); const { Driver } = req('./driver'); const orig = Driver.prototype.current; Driver.prototype.current = function (o) { const r = orig.call(this, o); return r.models.length ? r : { ...r, models: [{ value: 'claude-opus-5-5', displayName: 'Opus 5.5 (stand-in)' }] }; }; return 1; })()");
  await sleep(6000);
  console.log(`restarted pid=${child.pid}`);
}

void reads;
console.log(failures.length ? `\n${failures.length} failed: ${failures.join(', ')}` : '\nall passed');
process.exit(failures.length ? 1 : 0);
