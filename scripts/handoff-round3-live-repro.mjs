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
const { drive, safeBoot, watchNet, cleanupShims, providerAddresses } = await import('./handoff-harness.mjs');
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
const api = spawn(process.execPath, [path.join(ROOT, 'scripts/fake-responses-api.mjs'), log], { stdio: ['ignore', 'pipe', 'inherit'] });
const port = await new Promise((resolve) => api.stdout.on('data', (d) => { const m = /port (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));
const s = await safeBoot({ codexPort: port });
const net = watchNet(s, await providerAddresses());
console.log(`session ${s.dir}`);
const page = (e) => evaluate(s, e);
const main = (e) => evaluate(s, e, { main: true });
const codexUsers = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [])
  .map((r) => (r.body?.input || []).filter((m) => m.role === 'user').at(-1)?.content?.map((c) => c.text).join('\n') || '');
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
    check('H: both kept parts of the two-agent chat are listed', (list.match(/both ALPHA/g) || []).length === 2 && /Cursor · shop/.test(list), list);
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
    check('H: Show again brings back every kept part (none lost from the rail)', bothRows.length >= 1 && !Object.keys(conn('hidden-sessions.json')).length, { back, hidden: conn('hidden-sessions.json') });
  }
} catch (e) {
  check('the H run finished', false, e.stack);
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
    // ---- L: a pipeline stage on a chat that was switched at its gate ---------
    const pdir = path.join(s.home, '.conn', 'pipelines');
    fs.mkdirSync(pdir, { recursive: true });
    fs.writeFileSync(path.join(pdir, 'switchy.yml'), [
      'name: Switchy', 'stages:', '  - id: plan', '    prompt: plan it now', '    gate: true',
      '  - id: more', '    prompt: "carry on from {{plan}}"', '    same: plan', '',
    ].join('\n'));
    const runCard = () => page(`(() => { const c = [...document.querySelectorAll('[data-slot="pipeline-run"]')].find((x) => x.getAttribute('aria-label') === 'Switchy run'); return c && { status: c.dataset.status, stages: Object.fromEntries([...c.querySelectorAll('[data-slot="pipeline-stage"]')].map((b) => [b.dataset.stage, b.dataset.status])) }; })()`);
    await key(s, 'Ctrl+K');
    await type(s, 'Run pipeline');
    await key(s, 'Enter');
    await until(() => page(`!!document.querySelector('[data-slot="pipeline-option"][aria-label="Switchy"]')`), 10000);
    await click(s, 'css=[data-slot="pipeline-option"][aria-label="Switchy"]');
    await sleep(500);
    await click(s, 'Start');
    const gated = await until(async () => { const r = await runCard(); return r?.status === 'waiting' && r; }, 60000);
    note('run at the gate', gated);
    await click(s, 'css=[data-slot="pipeline-stage"][data-stage="plan"]');
    await sleep(2500);
    await pick('codex');
    await send('pl talk it over on chatgpt');
    await until(() => has('codex heard: pl talk it over on chatgpt'), 30000);
    await idle();
    await key(s, 'Ctrl+Shift+M');
    await sleep(1000);
    await click(s, 'css=[data-slot="pipeline-run"] [data-action="continue"]');
    const done = await until(async () => { const r = await runCard(); return r?.stages.more === 'done' && r; }, 60000);
    note('run after the same: stage', done || await runCard());
    await sleep(1500);
    const runs = fs.readdirSync(path.join(s.home, '.conn', 'runs')).map((n) => JSON.parse(fs.readFileSync(path.join(s.home, '.conn', 'runs', n), 'utf8')));
    const run = runs.find((r) => JSON.stringify(r).includes('Switchy'));
    const recs = conn('chat-segments.json');
    const head = Object.keys(recs).find((h) => recs[h].some((x) => x.provider === 'codex'));
    note('stage sessions on disk', run?.stages?.map((x) => [x.id, x.session]));
    note('the plan chat\'s record', recs[head]);
    const followerIds = new Set((recs[head] || []).slice(1).map((x) => x.session));
    check('L: a stage on a switched chat is saved under the chat\'s first session, not a later one', !(run?.stages || []).some((x) => followerIds.has(x.session) && x.session !== head), run?.stages?.map((x) => [x.id, x.session]));
    await shot(s, path.join(SHOTS, 'L-pipeline.png'), { preview: false });
    // After a reload the stage's chat is only on disk: open it from its chip.
    await reload();
    await click(s, 'Later').catch(() => {});
    await key(s, 'Ctrl+Shift+M');
    await sleep(1500);
    await click(s, 'css=[data-slot="pipeline-stage"][data-stage="more"]');
    await sleep(1500);
    const t3 = await toasts();
    const shown = await page("(document.querySelector('#agent-root') || document.body).innerText");
    note('opening the "more" stage after a reload: toasts', t3);
    check('L: the same: stage on a switched chat opens after a reload, whole', !t3.some((x) => /Could not open/.test(x)) && shown.includes('codex heard: pl talk it over on chatgpt') && shown.includes('plan it now'), { t3, shown: shown.slice(0, 300) });
    await shot(s, path.join(SHOTS, 'L-open-stage-after-reload.png'), { preview: false });
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

console.log(failures.length ? `\n${failures.length} failed: ${failures.join(', ')}` : '\nall passed');
process.exit(failures.length ? 1 : 0);
