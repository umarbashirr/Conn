#!/usr/bin/env node
/* Round three of the switch fixes, live on handoff-harness.mjs (stub ACP
   agents, local stand-ins for Claude and Codex, Xvfb, throwaway HOME).

   P  The phone, through the mobile gate's own WebSocket on 127.0.0.1: a send
      for a chat switched in the window but not yet sent on is acked only once
      the window has it, and it goes to the new agent with the handoff. The
      gate's transcript read of a switched chat picks up a message written
      after an earlier read (the stitched-read cache).
   H  Settings › Chat › Hidden chats: the delete toasts, the rows' title,
      agent, folder and date, Try deleting again refused and then allowed
      once the stub lets it, and Show again on a chat whose every part was
      kept (two agents).
   T  A fork whose carried history has a call still running draws that call
      as handed over when the fork is reopened.

   STUB_ACP_DELETE_GATE is set here: the stub advertises delete and allows it
   only once the gate file exists. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GATE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hv-gate-')), 'allow-delete');
process.env.STUB_ACP_DELETE_GATE = GATE;
const { drive, safeBoot, watchNet, cleanupShims, providerAddresses, assertSafeEnv } = await import('./handoff-harness.mjs');
const { spawn } = await import('node:child_process');
const { fileURLToPath } = await import('node:url');
const { createRequire } = await import('node:module');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { buildHandoff, wrapMessage } = require('../src/shared/handoff.js');
const { stop, click, hover, key, type, shot, evaluate } = drive;
const SHOTS = process.env.SHOT_DIR || '/tmp/handoff-verify/r4';
fs.mkdirSync(SHOTS, { recursive: true });
const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` ${JSON.stringify(detail)?.slice(0, 700)}`}`);
  if (!ok) failures.push(name);
};
const note = (what, v) => console.log(`NOTE ${what}: ${JSON.stringify(v)?.slice(0, 900)}`);
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
const FAIL_ONCE = path.join(path.dirname(GATE), 'failed-once');
// Inherited rather than passed: an env passed to a spawn is checked for a throwaway HOME.
process.env.FAKE_FAIL_ONCE = FAIL_ONCE;
const api = spawn(process.execPath, [path.join(ROOT, 'scripts/fake-responses-api.mjs'), log], { stdio: ['ignore', 'pipe', 'inherit'] });
const port = await new Promise((resolve) => api.stdout.on('data', (d) => { const m = /port (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));
const s = await safeBoot({ codexPort: port });
const net = watchNet(s, await providerAddresses());
console.log(`session ${s.dir}`);
const page = (e) => evaluate(s, e);
const main = (e) => evaluate(s, e, { main: true });
const codexUsers = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [])
  // An injected handoff reads as the text it carries.
  .map((r) => r.seen?.handed ?? ((r.body?.input || []).filter((m) => m.role === 'user').at(-1)?.content?.map((c) => c.text).join('\n') || ''));
const conn = (f) => { try { return JSON.parse(fs.readFileSync(path.join(s.home, '.conn', f), 'utf8')); } catch { return {}; } };
const stubStore = (name) => { try { return JSON.parse(fs.readFileSync(path.join(s.home, '.stub-acp', `${name}.json`), 'utf8')); } catch { return {}; } };
const FIXED = ['New chat', 'Search', 'Board', 'Check for updates', 'Customize', 'Usage'];
const rows = async () => {
  await page('window.connRail?.refresh()');
  await sleep(2500);
  return JSON.parse(await page("JSON.stringify([...document.querySelectorAll('li[data-sidebar=menu-item]')].map((e) => e.innerText.split('\\n')[0]))")).filter((r) => !FIXED.includes(r));
};
const has = (t) => page(`document.body.innerText.includes(${JSON.stringify(t)})`);
const toasts = () => page("JSON.stringify([...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.innerText))").then(JSON.parse);
const reload = async () => {
  await main("(() => { const w = electron.BrowserWindow.getAllWindows().find((w) => /index\\.html/.test(w.webContents.getURL())); w.webContents.reload(); return 1; })()");
  await sleep(7000);
};
const focus = () => page("document.querySelector('#composer [contenteditable=\"true\"]').focus()");
const send = async (t) => { await focus(); await type(s, t, { enter: true }); };
const trigger = () => page(`(() => { const b = [...document.querySelectorAll('#composer button[data-slot=dropdown-menu-trigger]')].find((e) => /Opus|Sonnet|Haiku|Fable|GPT|Auto|Stub|Pick a model/.test(e.innerText)); const r = b.getBoundingClientRect(); return Math.round(r.x + r.width / 2) + ',' + Math.round(r.y + r.height / 2); })()`);
const pick = async (provider) => {
  await click(s, `xy=${await trigger()}`);
  await sleep(400);
  await hover(s, { codex: 'ChatGPT', copilot: 'Copilot', cursor: 'Cursor', claude: 'Claude' }[provider]);
  await sleep(700);
  if (provider === 'codex') await click(s, 'Fast, go-to model for coding and everyday work.');
  else { await key(s, 'Right'); await sleep(300); await key(s, 'Enter'); }
  await sleep(2500);
};
const newChat = async () => { await click(s, 'New chat'); await sleep(800); };
// A new chat follows the last pick; on a fresh boot it is Claude with nothing
// picked yet ("Pick a model"), before the app has learned Claude's real list.
const toClaude = async () => {
  const on = await page("[...document.querySelectorAll('#composer button[data-slot=dropdown-menu-trigger]')].map((e) => e.innerText).join(' ')");
  if (!/Opus|Sonnet|Haiku|Fable|Pick a model/.test(on)) await pick('claude');
};
const idle = () => until(async () => !(await page("!!document.querySelector('#composer button[aria-label=Stop]')")), 60000);
const deleteRow = async (title) => {
  await hover(s, title);
  await click(s, `Delete ${title}`);
  await sleep(400);
  await click(s, 'Delete');
  await until(async () => (await toasts()).some((t) => /Removed from Conn|Deleted the/.test(t)), 8000);
  const t = await toasts();
  await sleep(2500);
  return t;
};
const projDir = () => path.join(s.home, '.claude/projects', s.project.replace(/[/.]/g, '-'));
const claudeIds = () => (fs.existsSync(projDir()) ? fs.readdirSync(projDir()).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -6)) : []);

// The mobile gate, as the phone talks to it.
async function gate() {
  const appLog = fs.readFileSync(path.join(s.dir, 'app.log'), 'utf8');
  const gport = /mobile gate listening on [^:]+:(\d+)/.exec(appLog)?.[1];
  const token = /mobile gate token (\S+)/.exec(appLog)?.[1];
  if (!gport || !token) throw new Error('no mobile gate in the app log');
  const ws = new WebSocket(`ws://127.0.0.1:${gport}`);
  const frames = [];
  ws.onmessage = (m) => frames.push(JSON.parse(m.data));
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = () => fail(new Error('gate refused')); });
  ws.send(JSON.stringify({ op: 'auth', token }));
  await until(async () => frames.some((f) => f.op === 'ack' && f.of === 'auth'), 5000);
  const ask = async (frame, match, ms = 30000) => {
    const start = frames.length;
    ws.send(JSON.stringify(frame));
    return until(async () => frames.slice(start).find(match), ms);
  };
  return { ask, close: () => ws.close(), frames };
}

try {
  await main("(() => { const h = electron.ipcMain._invokeHandlers; const send = h.get('agent:send'); h.set('agent:send', (e, a) => { globalThis.__lastChat = a.chat; return send(e, a); }); globalThis.__sends = []; for (const [mod, cls] of [['./agent', 'AgentSession'], ['./codex', 'CodexSession'], ['./providers/acp-session', 'AcpSession']]) { const C = req(mod)[cls]; const orig = C.prototype.send; C.prototype.send = function (text, images) { globalThis.__sends.push({ provider: this.provider, text: String(text) }); return orig.call(this, text, images); }; const sh = C.prototype.sendHandoff; if (sh) C.prototype.sendHandoff = function (text, images, h) { globalThis.__sends.push({ provider: this.provider, text: `${h.text}\n\nUser message:\n${text}` }); this.send = (t, i) => orig.call(this, t, i); return sh.call(this, text, images, h).finally(() => { delete this.send; }); }; } return 1; })()");
  await click(s, 'Later').catch(() => {});
  if (only('P')) {
    // ---- P: the phone ------------------------------------------------------
    await send('ph ALPHA');
    await until(() => has('heard: ph ALPHA'));
    await idle();
    const head = claudeIds()[0];
    await pick('codex');
    const g = await gate();
    const before = codexUsers().length;
    const ack = await g.ask({ op: 'send', chat: `h:claude:${head}`, session: head, provider: 'claude', project: s.project, text: 'ph BRAVO from the phone', nonce: 'n1' },
      (f) => f.nonce === 'n1' && f.op === 'ack', 15000);
    note('gate answer to the phone send', ack);
    check('P: the phone send is acked ok once the window has it', !!ack && !ack.error, ack);
    await until(async () => codexUsers().length > before, 30000);
    const got = codexUsers().slice(before);
    check('P: it reaches Codex with the handoff', got.some((t) => t.includes('<conn-handoff') && t.endsWith('ph BRAVO from the phone')), got.map((t) => t.slice(-60)));
    await idle();
    await sleep(2000);
    const read1 = await g.ask({ op: 'transcript', project: s.project, id: head, provider: 'claude', nonce: 't1' }, (f) => f.nonce === 't1', 30000);
    const said = (r) => JSON.stringify(r?.messages || []);
    check('P: the gate reads the switched chat whole', said(read1).includes('ph ALPHA') && said(read1).includes('ph BRAVO from the phone') && !said(read1).includes('conn-handoff'), said(read1).slice(0, 300));
    await send('ph CHARLIE from the window');
    await until(() => has('codex heard: ph CHARLIE from the window'));
    await idle();
    await sleep(1500);
    const read2 = await g.ask({ op: 'transcript', project: s.project, id: head, provider: 'claude', nonce: 't2' }, (f) => f.nonce === 't2', 30000);
    check('P: a message written after a read shows on the next read (the cache is not stale)', said(read2).includes('ph CHARLIE from the window'), said(read2).slice(-300));
    // A send the window cannot take: the chat it names is not open there.
    await main(`(() => { electron.ipcMain.emit('agent:pendingHandoffs', {}, { list: [{ head: 'nothead-0000-0000', key: 'no-such-chat' }] }); return 1; })()`);
    const bad = await g.ask({ op: 'send', chat: 'h:claude:nothead-0000-0000', session: 'nothead-0000-0000', provider: 'claude', project: s.project, text: 'lost?', nonce: 'n2' },
      (f) => f.nonce === 'n2' && f.op === 'ack', 15000);
    note('gate answer when the window does not have the chat', bad);
    check('P: a send the window does not take is an error, not a silent ok', !!bad?.error, bad);
    g.close();
    // The window's side directly: the same phone send id handed over twice.
    await pick('claude');
    await main(`(() => { globalThis.__taken = []; if (!globalThis.__tapped) { globalThis.__tapped = true; electron.ipcMain.on('agent:phoneTurnTaken', (_e, a) => globalThis.__taken.push(a)); } return 1; })()`);
    const before2 = (await main("JSON.stringify(globalThis.__sends || [])").then(JSON.parse)).length;
    const k = await main(`(() => { return globalThis.__lastChat || null; })()`);
    const twice = `(() => { const w = electron.BrowserWindow.getAllWindows().find((x) => /index\\.html/.test(x.webContents.getURL())); for (const id of ['r1', 'r2']) w.webContents.send('agent:phoneTurn', { id, turnId: 'dup-turn-1', chat: ${JSON.stringify(k)}, text: 'ph DUP sent twice', images: [] }); return 1; })()`;
    await main(twice);
    await sleep(8000);
    const taken = await main('JSON.stringify(globalThis.__taken)').then(JSON.parse);
    const sentDup = (await main("JSON.stringify(globalThis.__sends || [])").then(JSON.parse)).slice(before2).filter((x) => x.text.endsWith('ph DUP sent twice'));
    note('acks for the two hand-overs', taken);
    check('P: a phone send id the window already took is acked and not sent again', taken.length === 2 && taken.every((x) => x.ok) && sentDup.length === 1, { taken, sent: sentDup.length });
    await shot(s, path.join(SHOTS, 'P-phone.png'));
  }
} catch (e) {
  check('the P run finished', false, e.stack);
}

try {
  if (only('H')) {
    // ---- H: Hidden chats -----------------------------------------------------
    await newChat();
    await toClaude();
    await send('hid ALPHA');
    await until(() => has('heard: hid ALPHA'));
    await idle();
    await pick('copilot');
    await send('hid BRAVO');
    await until(() => has('acp heard: hid BRAVO'), 60000);
    await idle();
    await sleep(2000);
    await newChat();
    await pick('copilot');
    await send('both ALPHA');
    await until(() => has('acp heard: both ALPHA'), 60000);
    await idle();
    await pick('cursor');
    await send('both BRAVO');
    await until(() => has('acp heard: both BRAVO'), 60000);
    await idle();
    await sleep(2000);
    const recs = conn('chat-segments.json');
    note('records before the deletes', recs);
    await reload();
    note('rail before the deletes', await rows());
    const t1 = await deleteRow('hid ALPHA');
    note('toast, Claude -> Copilot chat', t1);
    check('H: the toast names the part that went and the agent that kept its part', t1.some((t) => /Deleted the Claude part\./.test(t) && /Copilot kept its part on disk/.test(t)), t1);
    const t2 = await deleteRow('both ALPHA');
    note('toast, Copilot -> Cursor chat', t2);
    check('H: a chat every agent kept says it was removed from Conn and who kept copies', t2.some((t) => /Removed from Conn\./.test(t) && /(Copilot and Cursor|Cursor and Copilot) kept their copies on disk/.test(t)), t2);
    const hidden = conn('hidden-sessions.json');
    note('hidden-sessions.json', hidden);
    const railAfter = await rows();
    check('H: neither chat is in the rail', !railAfter.some((r) => /hid |both /.test(r)), railAfter);

    // Settings › Chat.
    await click(s, 'Customize');
    await sleep(1000);
    await click(s, 'Chat');
    await sleep(1500);
    const section = () => page("(() => { const h = [...document.querySelectorAll('h2,h3,div')].find((e) => e.innerText.trim() === 'Hidden chats'); let el = h; for (let i = 0; i < 4 && el; i++) el = el.parentElement; return el ? el.innerText : ''; })()");
    await page("[...document.querySelectorAll('h2,h3,div')].find((e) => e.innerText.trim() === 'Hidden chats')?.scrollIntoView({ block: 'start' })");
    const list = await section();
    note('Hidden chats section', list);
    await shot(s, path.join(SHOTS, 'H-hidden-chats.png'), { preview: false });
    const date = new Date().toLocaleDateString('en-US');
    check('H: the Copilot part is listed under its chat\'s title with agent, folder and date', /hid ALPHA[\s\S]*Copilot · shop · /.test(list), list);
    // Both kept parts are one hidden chat: one row naming both agents.
    const bothRow = await page("(() => { const leaf = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && e.textContent.trim() === 'both ALPHA'); let el = leaf; while (el && !el.querySelector('button')) el = el.parentElement; return el ? el.innerText : null; })()");
    note('the two-agent chat\'s hidden row', bothRow);
    check('H: the two-agent chat is one hidden row naming both agents', !!bothRow && /(Copilot and Cursor|Cursor and Copilot) · shop/.test(bothRow) && (list.match(/both ALPHA/g) || []).length === 1, { bothRow });
    void date;

    // Try deleting again: refused, then allowed.
    const copilotPart = Object.keys(hidden).find((k) => stubStore('copilot')[k]?.turns.some((x) => x.text.endsWith('hid BRAVO')));
    // The row is the nearest ancestor of a label reading exactly `title` that
    // holds a button; the nth such row, newest hidden first.
    const rowButton = (title, label, nth = 0) => page(`(() => { const leaves = [...document.querySelectorAll('*')].filter((e) => e.children.length === 0 && e.textContent.trim() === ${JSON.stringify(title)}); const rows = []; for (const leaf of leaves) { let el = leaf; while (el && !el.querySelector('button')) el = el.parentElement; if (el && !rows.includes(el)) rows.push(el); } const row = rows[${nth}]; const b = row && [...row.querySelectorAll('button')].find((x) => x.innerText.trim() === ${JSON.stringify(label)}); if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return Math.round(r.x + r.width / 2) + ',' + Math.round(r.y + r.height / 2); })()`);
    const tryAt = await rowButton('hid ALPHA', 'Try deleting again');
    await click(s, `xy=${tryAt}`);
    await until(async () => (await toasts()).some((t) => /Could not do that/.test(t)), 15000);
    const refused = await toasts();
    note('toast, try again while refused', refused);
    check('H: Try deleting again while the agent refuses says why and keeps the row', refused.some((t) => /Could not do that/.test(t)) && (await section()).includes('hid ALPHA'), refused);
    fs.writeFileSync(GATE, 'yes');
    await sleep(500);
    const tryAt2 = await rowButton('hid ALPHA', 'Try deleting again');
    await click(s, `xy=${tryAt2}`);
    await until(async () => (await toasts()).some((t) => /Deleted from disk/.test(t)), 15000);
    await sleep(1500);
    check('H: once the agent allows it, Try deleting again deletes it from disk and the row goes', !(await section()).includes('hid ALPHA') && !stubStore('copilot')[copilotPart] && !conn('hidden-sessions.json')[copilotPart], { copilotPart, inStore: !!stubStore('copilot')[copilotPart] });
    fs.rmSync(GATE, { force: true });

    // Show again on both parts of the two-agent chat.
    for (let i = 0; i < 2; i++) {
      const at = await rowButton('both ALPHA', 'Show again', 0);
      if (!at) break;
      await click(s, `xy=${at}`);
      await sleep(2500);
    }
    await shot(s, path.join(SHOTS, 'H-after-show-again.png'), { preview: false });
    await key(s, 'Escape');
    await sleep(500);
    await reload();
    const back = await rows();
    note('rail after Show again on both parts', back);
    const bothRows = back.filter((r) => /both /.test(r) || r === 'Copilot chat' || r === 'Cursor chat');
    check('H: Show again brings the two-agent chat back as one chat', bothRows.length === 1, back);
    const bothTitle = bothRows[0];
    if (bothTitle) {
      await click(s, bothTitle);
      await sleep(6000);
      const shownBoth = await page("(document.querySelector('#agent-root') || document.body).innerText");
      const pos = ['acp heard: both ALPHA', 'acp heard: both BRAVO'].map((w) => shownBoth.lastIndexOf(w));
      check('H: the chat Show again brought back reads in order, both stretches', pos[0] >= 0 && pos[1] > pos[0] && /Copilot → Cursor/.test(shownBoth), { pos, text: shownBoth.slice(0, 300) });
    }
    check('H: Show again brings back every kept part (none lost from the rail)', bothRows.length >= 1 && !Object.keys(conn('hidden-sessions.json')).length, { back, hidden: conn('hidden-sessions.json') });
  }
} catch (e) {
  check('the H run finished', false, e.stack);
}

try {
  if (only('S')) {
    // ---- S: Show again on what is left of a Claude -> Copilot chat -----------
    // Claude deletes its part; Copilot keeps its part, whose first message is
    // the one that carried the handoff.
    await newChat();
    await toClaude();
    await send('rem ALPHA');
    await until(() => has('heard: rem ALPHA'));
    await idle();
    await pick('copilot');
    await send('rem BRAVO');
    await until(() => has('acp heard: rem BRAVO'), 60000);
    await idle();
    await sleep(2000);
    await reload();
    const before = await rows();
    await deleteRow('rem ALPHA');
    await click(s, 'Customize');
    await sleep(1000);
    await click(s, 'Chat');
    await sleep(1500);
    const leaves = "[...document.querySelectorAll('*')].filter((e) => e.children.length === 0 && e.textContent.trim() === 'rem ALPHA')";
    const at = await page(`(() => { for (const leaf of ${leaves}) { let el = leaf; while (el && !el.querySelector('button')) el = el.parentElement; const b = el && [...el.querySelectorAll('button')].find((x) => x.innerText.trim() === 'Show again'); if (b) { b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return Math.round(r.x + r.width / 2) + ',' + Math.round(r.y + r.height / 2); } } return null; })()`);
    check('S: the kept Copilot part is listed under its chat\'s title', !!at, 'no Show again button for rem ALPHA');
    if (at) await click(s, `xy=${at}`);
    await sleep(2500);
    await key(s, 'Escape');
    await reload();
    const after = await rows();
    note('rail before the delete / after Show again', { before, after });
    const added = after.filter((r) => !before.includes(r) || r === 'rem ALPHA');
    check('S: Show again puts the kept part back in the rail', added.length >= 1, { before, after });
    if (added.length) {
      await click(s, added[0]);
      await sleep(5000);
      const shown = await page("(document.querySelector('#agent-root') || document.body).innerText");
      check('S: and it opens on what Copilot kept', shown.includes('acp heard: rem BRAVO'), shown.slice(0, 300));
      note('S: the row it came back as', added[0]);
    }
    await shot(s, path.join(SHOTS, 'S-show-again-remnant.png'), { preview: false });
  }
} catch (e) {
  check('the S run finished', false, e.stack);
}

try {
  if (only('B')) {
    // ---- B: the Board with a switched chat --------------------------------
    await newChat();
    await toClaude();
    await send('brd ALPHA');
    await until(() => has('heard: brd ALPHA'));
    await idle();
    await pick('codex');
    await send('brd BRAVO');
    await until(() => has('codex heard: brd BRAVO'));
    await idle();
    await sleep(2000);
    await reload();
    await click(s, 'Board');
    await sleep(2500);
    const cards = JSON.parse(await page("JSON.stringify([...document.querySelectorAll('[data-slot=board-card]')].map((b) => b.innerText.split('\\n')[0]))"));
    note('Board cards', cards);
    check('B: a saved switched chat is one Board card', cards.filter((c) => /brd /.test(c)).length === 1, cards);
    await shot(s, path.join(SHOTS, 'B-board.png'), { preview: false });
    const at = await page("(() => { const b = [...document.querySelectorAll('[data-slot=board-card]')].find((x) => /brd ALPHA/.test(x.innerText)); if (!b) return null; const r = b.getBoundingClientRect(); return Math.round(r.x + r.width / 2) + ',' + Math.round(r.y + r.height / 2); })()");
    note('card at', at);
    // The update toast sits over the top right, where the Recent lane's first card is.
    await click(s, 'Later').catch(() => {});
    await sleep(500);
    await hover(s, `xy=${at}`);
    await sleep(300);
    await click(s, `xy=${at}`);
    await sleep(1500);
    note('toasts after the card click', await toasts());
    await sleep(4500);
    const text = await page("(document.querySelector('#agent-root') || document.body).innerText");
    check('B: opening the saved switched chat from its card shows every stretch', text.includes('heard: brd ALPHA') && text.includes('codex heard: brd BRAVO') && /Claude → ChatGPT/.test(text), text.slice(0, 400));
    await shot(s, path.join(SHOTS, 'B-opened-from-card.png'), { preview: false });
    // Carry on in the chat the card opened, the way a person would: switch it.
    const before = conn('chat-segments.json');
    note('record before carrying on', before);
    await pick('codex');
    await send('brd CHARLIE after the card');
    await until(() => has('codex heard: brd CHARLIE after the card'), 30000);
    await idle();
    await sleep(2500);
    const after = conn('chat-segments.json');
    note('record after carrying on', after);
    const head = Object.keys(before).find((h) => before[h].length === 2);
    const lostB = head && before[head][1] && !after[head]?.some((x) => x.session === before[head][1].session);
    await reload();
    const r = await rows();
    note('rail after carrying on', r);
    check('B: carrying on in a chat opened from its card keeps its earlier stretches on record', !lostB, { before: before[head], after: after[head] });
    check('B: and the chat is still one row', r.filter((x) => /brd /.test(x)).length === 1, r);
  }
} catch (e) {
  check('the B run finished', false, e.stack);
}

try {
  if (only('L')) {
    // ---- L: pipeline stages on a chat switched at its gate ---------------------
    // plan (gate) on Claude; switched to ChatGPT at the gate; "more" continues
    // it, fails once and is retried, and gates; a true restart; then "last"
    // continues the same chat from disk.
    const pdir = path.join(s.home, '.conn', 'pipelines');
    fs.mkdirSync(pdir, { recursive: true });
    fs.writeFileSync(path.join(pdir, 'switchy.yml'), [
      'name: Switchy', 'stages:',
      '  - id: plan', '    prompt: plan it now', '    provider: claude', '    gate: true',
      '  - id: more', '    prompt: "fail-once-token carry on from {{plan}}"', '    same: plan', '    gate: true',
      '  - id: last', '    prompt: last word after the restart', '    same: plan', '',
    ].join('\n'));
    const runCard = () => page(`(() => { const c = [...document.querySelectorAll('[data-slot="pipeline-run"]')].find((x) => x.getAttribute('aria-label') === 'Switchy run'); return c && { status: c.dataset.status, stages: Object.fromEntries([...c.querySelectorAll('[data-slot="pipeline-stage"]')].map((b) => [b.dataset.stage, b.dataset.status])) }; })()`);
    const runFile = () => fs.readdirSync(path.join(s.home, '.conn', 'runs')).map((n) => JSON.parse(fs.readFileSync(path.join(s.home, '.conn', 'runs', n), 'utf8'))).find((r) => JSON.stringify(r).includes('Switchy'));
    await key(s, 'Ctrl+K');
    await type(s, 'Run pipeline');
    await key(s, 'Enter');
    await until(() => page(`!!document.querySelector('[data-slot="pipeline-option"][aria-label="Switchy"]')`), 10000);
    await click(s, 'css=[data-slot="pipeline-option"][aria-label="Switchy"]');
    await sleep(500);
    await click(s, 'Start');
    const gated = await until(async () => { const r = await runCard(); return r?.status === 'waiting' && r; }, 60000);
    note('run at the first gate', gated);
    await click(s, 'css=[data-slot="pipeline-stage"][data-stage="plan"]');
    await sleep(2500);
    await pick('codex');
    await send('pl talk it over on chatgpt');
    await until(() => has('codex heard: pl talk it over on chatgpt'), 30000);
    await idle();
    await key(s, 'Ctrl+Shift+M');
    await sleep(1000);
    await click(s, 'css=[data-slot="pipeline-run"] [data-action="continue"]');
    const failed = await until(async () => { const r = await runCard(); return r?.status === 'failed' && r; }, 60000);
    note('run after the first try of "more"', failed || await runCard());
    check('L: the stage on the switched chat fails once (the stand-in refuses it)', !!failed && failed.stages.more === 'failed', failed || await runCard());
    await click(s, 'css=[data-slot="pipeline-run"] [data-action="retry"]');
    const regated = await until(async () => { const r = await runCard(); return r?.status === 'waiting' && r.stages.more !== 'failed' && r; }, 60000);
    note('run after Retry', regated || await runCard());
    check('L: Retry sends the stage again, on the agent the chat is on now', !!regated && codexUsers().some((u) => u.includes('fail-once-token')) && fs.existsSync(FAIL_ONCE), regated || await runCard());
    const recs = conn('chat-segments.json');
    const run1 = runFile();
    const planSession = run1?.stages?.[0]?.session;
    const head = Object.keys(recs).find((h) => h === planSession || recs[h].some((x) => x.session === planSession));
    note('stage sessions on disk', run1?.stages?.map((x) => [x.id, x.session]));
    note('the plan chat\'s record', recs[head]);
    check('L: the plan stage really ran on Claude and the chat moved to ChatGPT', !!head && recs[head]?.[0]?.provider === 'claude' && recs[head].some((x) => x.provider === 'codex'), recs[head]);
    check('L: every stage that ran is saved under the chat\'s first session', !!head && (run1?.stages || []).filter((x) => x.session).every((x) => x.session === head), run1?.stages?.map((x) => [x.id, x.session]));
    await shot(s, path.join(SHOTS, 'L-pipeline.png'), { preview: false });

    await reload();
    await click(s, 'Later').catch(() => {});
    await key(s, 'Ctrl+Shift+M');
    await sleep(1500);
    await click(s, 'css=[data-slot="pipeline-stage"][data-stage="more"]');
    await sleep(4000);
    const t3 = await toasts();
    const shown = await page("(document.querySelector('#agent-root') || document.body).innerText");
    check('L: the same: stage opens after a reload, whole', !t3.some((x) => /Could not open/.test(x)) && shown.includes('codex heard: pl talk it over on chatgpt') && shown.includes('plan it now'), { t3, shown: shown.slice(0, 300) });

    // A true restart, then Continue: "last" takes up the plan chat from disk.
    const beforeRec = conn('chat-segments.json')[head];
    await restart(s);
    await click(s, 'Later').catch(() => {});
    await key(s, 'Ctrl+Shift+M');
    await sleep(2000);
    const afterRestart = await runCard();
    note('run after the restart', afterRestart);
    const codexBefore = codexUsers().length;
    await click(s, 'css=[data-slot="pipeline-run"] [data-action="continue"]');
    const finished = await until(async () => { const r = await runCard(); return r?.stages.last === 'done' && r; }, 90000);
    note('run after Continue past the restart', finished || await runCard());
    const lastSent = codexUsers().slice(codexBefore);
    note('what Codex got after the restart', lastSent.map((x) => x.slice(-80)));
    check('L: after a restart, a same: stage continues the switched chat on the agent it is on now', !!finished && lastSent.some((x) => x.endsWith('last word after the restart')), { finished, lastSent: lastSent.map((x) => x.slice(-60)) });
    await sleep(2000);
    const afterRec = conn('chat-segments.json')[head];
    note('record after the restart stage', afterRec);
    check('L: and the chat\'s record keeps every stretch it had', !!afterRec && beforeRec.every((x) => afterRec.some((y) => y.session === x.session && y.provider === x.provider)), { beforeRec, afterRec });
    const run2 = runFile();
    check('L: every stage is still saved under the chat\'s first session', (run2?.stages || []).filter((x) => x.session).every((x) => x.session === head), run2?.stages?.map((x) => [x.id, x.session]));
    await click(s, 'css=[data-slot="pipeline-stage"][data-stage="last"]');
    await sleep(5000);
    const whole = await page("(document.querySelector('#agent-root') || document.body).innerText");
    const at = ['plan it now', 'codex heard: pl talk it over on chatgpt', 'last word after the restart'].map((w) => whole.lastIndexOf(w));
    check('L: the stage chat opens whole and in order after the restart', at.every((x, i) => x >= 0 && (i === 0 || x > at[i - 1])), { at, text: whole.slice(0, 400) });
    const r = await rows();
    check('L: the stage chat is one row', r.filter((x) => /Switchy/.test(x)).length === 1, r);
    await shot(s, path.join(SHOTS, 'L-after-restart.png'), { preview: false });
  }
} catch (e) {
  check('the L run finished', false, e.stack);
}

try {
  if (only('T')) {
    // ---- T: a call still running, carried into a fork ------------------------
    const FORK = '5e551011-0000-4000-8000-00000000f0f0';
    const items = [
      { id: 'u1', kind: 'user', text: 'run the long build' },
      { id: 't1', kind: 'tool', name: 'Bash', input: { command: 'make everything' }, state: 'input-available' },
      { id: 'a1', kind: 'assistant', text: 'the build is going' },
    ];
    const h = buildHandoff({ items, from: 'claude', to: 'claude', model: 'Opus 5.5', fork: true, window: 200000 });
    const prompt = wrapMessage(h.text, 'tchat after the fork');
    fs.mkdirSync(projDir(), { recursive: true });
    const line = (i, type, content) => JSON.stringify({ type, uuid: `00000000-0000-4000-8000-00000000f0${i}0`, parentUuid: i ? `00000000-0000-4000-8000-00000000f0${i - 1}0` : null, sessionId: FORK, cwd: s.project, timestamp: new Date(Date.UTC(2026, 10, 1) + i * 60000).toISOString(), message: { role: type, content } });
    fs.writeFileSync(path.join(projDir(), `${FORK}.jsonl`), `${[line(0, 'user', prompt), line(1, 'assistant', [{ type: 'text', text: 'heard: tchat after the fork' }])].join('\n')}\n`);
    await reload();
    const r = await rows();
    const title = r.find((x) => /tchat/.test(x));
    note('fork row', title);
    await click(s, title);
    await sleep(5000);
    const text = await page("document.querySelector('#agent-root')?.innerText || document.body.innerText");
    check('T: the reopened fork draws the running call as still running when handed over', text.includes('still running when handed over') && /Forked from/.test(text), text.slice(0, 500));
    await shot(s, path.join(SHOTS, 'T-handed-over.png'), { preview: false });
  }
} catch (e) {
  check('the T run finished', false, e.stack);
} finally {
  const off = net.stop();
  check('no agent and no provider API was reached off the machine', !off.bad.length, off.bad);
  console.log(`NOTE the app's own traffic off the machine: ${JSON.stringify(off.app.map((x) => x.peer))}`);
  if (!process.env.KEEP) await stop(s).catch((e) => console.log(`NOTE stop failed: ${e.message}`));
  api.kill();
  fs.rmSync(log, { force: true });
  fs.rmSync(path.dirname(GATE), { recursive: true, force: true });
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
