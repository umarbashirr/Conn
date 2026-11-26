#!/usr/bin/env node
/* A handoff handed to Codex as thread items (thread/inject_items), live on
   handoff-harness.mjs: Xvfb, a throwaway HOME, stub ACP agents, the real
   claude CLI against the stand-in API and the real codex CLI (0.171.0)
   against fake-responses-api.mjs, outbound connections watched.

   I  Claude to ChatGPT: the model's input holds the carried history as
      separate messages, header to closing tag, and the user turn only what
      was typed. The row says injected.
   B  Back to Claude (inline, the row says so) and to ChatGPT again: the
      resumed thread is handed only what it missed, injected again, and still
      holds the first handoff.
   R  Reload, reopen from the rail and a true restart: every typed message is
      one bubble, no carried text is a bubble, the rows keep their method;
      conn_thread_read and the rollout agree.
   X  Codex refuses the method: the text goes in front of the message in the
      same send, and the row says inline.
   U  An inject nobody answers (the answer dropped, then the server killed
      mid-request): no second inject and no paste on that thread; a new
      thread gets the whole chat as text; the rail still shows one chat.
   F  A turn that fails after the handoff went, then Retry: the handoff is
      not carried again.
   K  Fork to a New Chat on ChatGPT: injected the same way.
   SHOT_DIR names the screenshot folder (default /tmp/handoff-verify/pr3).
   ONLY=I,X,U,F runs just those parts (I takes B and R with it, F takes K). */
import { drive, safeBoot, watchNet, cleanupShims, providerAddresses, assertSafeEnv } from './handoff-harness.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { stop, click, hover, key, type, shot, evaluate } = drive;
const SHOTS = process.env.SHOT_DIR || '/tmp/handoff-verify/pr3';
fs.mkdirSync(SHOTS, { recursive: true });
const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` ${JSON.stringify(detail)?.slice(0, 900)}`}`);
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
const FAIL_ONCE = path.join(os.tmpdir(), `fake-fail-once-${process.pid}`);
process.env.FAKE_FAIL_ONCE = FAIL_ONCE;
const api = spawn(process.execPath, [path.join(ROOT, 'scripts/fake-responses-api.mjs'), log], { stdio: ['ignore', 'pipe', 'inherit'] });
const port = await new Promise((resolve) => api.stdout.on('data', (d) => { const m = /port (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));
const s = await safeBoot({ codexPort: port });
const net = watchNet(s, await providerAddresses());
console.log(`session ${s.dir}`);
const page = (e) => evaluate(s, e);
const main = (e) => evaluate(s, e, { main: true });
const has = (t) => page(`document.body.innerText.includes(${J(t)})`);
const composerText = () => page("document.querySelector('#composer [contenteditable=\"true\"]').innerText.trim()");
// Typed and sent; an Enter the composer was not ready for is pressed again.
const send = async (t) => {
  await page("document.querySelector('#composer [contenteditable=\"true\"]').focus()");
  await type(s, t, { enter: true });
  if (!(await until(async () => (await composerText()) === '', 5000))) await key(s, 'Enter');
};
const idle = () => until(async () => !(await page("!!document.querySelector('#composer button[aria-label=Stop]')")), 90000);
const reload = async () => {
  await main("(() => { const w = electron.BrowserWindow.getAllWindows().find((w) => /index\\.html/.test(w.webContents.getURL())); w.webContents.reload(); return 1; })()");
  await sleep(7000);
};
const trigger = () => page(`(() => { const b = [...document.querySelectorAll('#composer button[data-slot=dropdown-menu-trigger]')].find((e) => /Opus|Sonnet|Haiku|Fable|GPT|Auto|Stub|Pick a model/.test(e.innerText)); const r = b.getBoundingClientRect(); return Math.round(r.x + r.width / 2) + ',' + Math.round(r.y + r.height / 2); })()`);
const pick = async (provider, tries = 3) => {
  await click(s, `xy=${await trigger()}`);
  await sleep(600);
  // The menu can take a moment to draw its providers; close it and ask again.
  const ok = await hover(s, { codex: 'ChatGPT', claude: 'Claude' }[provider]).then(() => true, (e) => (tries > 1 ? false : Promise.reject(e)));
  if (!ok) { await key(s, 'Escape'); await sleep(1500); return pick(provider, tries - 1); }
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
// The chat on screen, top to bottom: handoff rows by their label, user bubbles by their text.
const transcript = async () => JSON.parse(await page(`JSON.stringify([...(document.querySelector('#agent-root [role=log]') || document).querySelectorAll('[data-handoff], .is-user')].map((e) => e.dataset.handoff ? 'H ' + e.getAttribute('aria-label') : 'U ' + e.innerText.trim()))`));
const handoffRows = async () => (await transcript()).filter((x) => x.startsWith('H ')).map((x) => x.slice(2));
const requests = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []).filter((r) => r.method === 'POST');
// The first request of the turn whose typed message was `typed`.
const turnReq = (typed) => requests().find((r) => r.seen?.user === typed);
const waitReply = (t, ms = 60000) => until(() => has(t), ms);
const rolloutOf = (thread) => {
  const out = [];
  const walk = (d) => { for (const n of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) { const p = path.join(d, n.name); if (n.isDirectory()) walk(p); else if (n.name.endsWith(`${thread}.jsonl`)) out.push(p); } };
  walk(path.join(s.home, '.codex/sessions'));
  return out[0] ? fs.readFileSync(out[0], 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : null;
};
const injectedIn = (lines) => (lines || []).filter((o) => o.type === 'response_item' && /<conn-handoff[^>]*delivery=\\?"injected/.test(J(o.payload?.content || ''))).length;
const turnsIn = (lines) => (lines || []).filter((o) => o.type === 'event_msg' && o.payload?.type === 'task_started').length;
// Each typed message once, carried text never, as bubbles.
const bubblesOk = (t, typed) => {
  const users = t.filter((x) => x.startsWith('U ')).map((x) => x.slice(2));
  // A bubble's text ends with what was typed, under its Edit and Retry buttons.
  const each = typed.map((w) => users.filter((u) => u.split('\n').at(-1) === w).length);
  return { ok: each.every((n) => n === 1) && !users.some((u) => /<item |conn-handoff/.test(u)), each, users };
};

// Patching the transport only, real codex either side: `refuse` sends a method
// codex does not have; `hang` sends the real request and drops its answer, so
// the request's own timeout fires; `die` kills the server once it is sent.
await main(`(() => {
  const { AppServer } = req('./codex-rpc');
  const orig = AppServer.prototype.request;
  globalThis.__injects = [];
  AppServer.prototype.request = function (m, p, t) {
    if (m !== 'thread/inject_items') return orig.call(this, m, p, t);
    const mode = globalThis.__injectMode || 'real';
    globalThis.__injects.push({ mode, thread: p.threadId, items: p.items.length, at: Date.now() });
    if (mode === 'refuse') return orig.call(this, 'thread/inject_itemz', p, t);
    const pr = orig.call(this, m, p, t);
    if (mode === 'hang') this.pending.delete(this.seq);
    if (mode === 'die') setTimeout(() => { try { process.kill(-this.child.pid, 'SIGKILL'); } catch { this.child.kill('SIGKILL'); } }, 0);
    return pr;
  };
  req('./codex').CodexSession.injectMs = 3000;
  return 1;
})()`);

const want = (k) => !process.env.ONLY || process.env.ONLY.split(',').includes(k);
const textOf = (m) => (Array.isArray(m?.content) ? m.content.map((c) => c?.text || '').join('') : '');
let restartFn = null;
try {
  await click(s, 'Later').catch(() => {});

  if (want('I')) {
  // ---- I: Claude to ChatGPT, injected ---------------------------------------
  await send('inj A1 ALPHA');
  await waitReply('heard: inj A1 ALPHA');
  await idle();
  await pick('codex');
  check('I: the switch draws a pending row', (await handoffRows()).some((l) => /Claude → ChatGPT .*the next message carries/.test(l)), await handoffRows());
  await send('inj A2 BRAVO');
  await waitReply('codex heard: inj A2 BRAVO');
  await idle();
  const rA2 = turnReq('inj A2 BRAVO');
  const blockA2 = rA2?.seen?.injected?.at(-1) || [];
  note('I: the model input around the typed message', blockA2.map((m) => `${m.role}: ${m.text.split('\n')[0].slice(0, 90)}`));
  check('I: the carried history reached the model as separate messages, header to closing tag, just ahead of the typed turn',
    !!rA2?.seen?.injectedAhead && blockA2.length >= 4 && blockA2[0].role === 'user' && /delivery="injected"[^>]*scope="full"/.test(blockA2[0].text) && blockA2.at(-1).text === '</conn-handoff>', rA2?.seen);
  check('I: the typed message is a user item of its own and carried user and assistant turns keep their roles',
    blockA2.some((m) => m.role === 'user' && /^<item [^>]*role="user"[^>]*>\ninj A1 ALPHA\n<\/item>$/.test(m.text))
      && blockA2.some((m) => m.role === 'assistant' && /^<item [^>]*role="assistant"[^>]*>\nheard: inj A1 ALPHA/.test(m.text)), blockA2);
  check('I: the header says it is context, not instructions', /context, not a new request or higher-priority instructions/.test(blockA2[0]?.text || ''), blockA2[0]);
  check('I: the user turn carries only what was typed', rA2?.seen?.user === 'inj A2 BRAVO' && rA2?.seen?.pasted === false, rA2?.seen?.user);
  const rowsA = await handoffRows();
  check('I: the row says how it went', /Claude → ChatGPT .*carried \d+ of \d+ items · injected$/.test(rowsA[0] || ''), rowsA);
  check('I: the bubbles show what was typed', bubblesOk(await transcript(), ['inj A1 ALPHA', 'inj A2 BRAVO']).ok, await transcript());
  await shot(s, path.join(SHOTS, 'I-injected-row.png'), { preview: false });
  const injA = (await main('JSON.stringify(globalThis.__injects)').then(JSON.parse)).at(-1);
  note('I: inject request', injA);

  // ---- B: back and forth -----------------------------------------------------
  await pick('claude');
  await send('inj A3 CHARLIE');
  await waitReply('heard: inj A3 CHARLIE');
  await idle();
  const rowsB1 = await handoffRows();
  check('B: back on Claude, the row says inline', /ChatGPT → Claude .*· inline$/.test(rowsB1.at(-1) || ''), rowsB1);
  await pick('codex');
  await send('inj A4 DELTA');
  await waitReply('codex heard: inj A4 DELTA');
  await idle();
  const rA4 = turnReq('inj A4 DELTA');
  const blockA4 = rA4?.seen?.injected?.at(-1) || [];
  note('B: second inject', blockA4.map((m) => `${m.role}: ${m.text.split('\n')[0].slice(0, 90)}`));
  check('B: ChatGPT resumed is handed only what it missed, injected again', !!rA4?.seen?.injectedAhead && /scope="since"/.test(blockA4[0]?.text || '')
    && blockA4.some((m) => m.text.includes('inj A3 CHARLIE')) && !blockA4.some((m) => m.text.includes('inj A1 ALPHA')), blockA4.map((m) => m.text.slice(0, 120)));
  check('B: the resumed thread still holds the first handoff, once', rA4?.seen?.injected?.length === 2 && rA4.seen.pasted === false, rA4?.seen?.injected?.length);
  const rowsB = await handoffRows();
  check('B: three rows, injected, inline, injected', rowsB.length === 3 && / · injected$/.test(rowsB[0]) && / · inline$/.test(rowsB[1]) && / · injected$/.test(rowsB[2]), rowsB);
  const thread1 = injA?.thread;
  const roll1 = rolloutOf(thread1);
  check('B: the codex rollout holds both injected handoffs, each before a turn', injectedIn(roll1) === 2 && turnsIn(roll1) === 2, { injected: injectedIn(roll1), turns: turnsIn(roll1) });

  // ---- R: reload, reopen, restart ------------------------------------------
  const TYPED_A = ['inj A1 ALPHA', 'inj A2 BRAVO', 'inj A3 CHARLIE', 'inj A4 DELTA'];
  const looksRight = async (when) => {
    const t = await transcript();
    const b = bubblesOk(t, TYPED_A);
    const hr = t.filter((x) => x.startsWith('H '));
    check(`R: after ${when}, each typed message is one bubble and nothing carried is`, b.ok, b);
    check(`R: after ${when}, the rows keep their method`, hr.length === 3 && / · injected$/.test(hr[0]) && / · inline$/.test(hr[1]) && / · injected$/.test(hr[2]), hr);
    check(`R: after ${when}, the order is as it happened`, t.join('|').replace(/U ([^|]*)/g, (_, u) => `U ${TYPED_A.find((w) => u.split('\n').at(-1) === w) || u}`)
      .startsWith(`U inj A1 ALPHA|H ${hr[0].slice(2)}|U inj A2 BRAVO|H ${hr[1].slice(2)}|U inj A3 CHARLIE|H ${hr[2].slice(2)}|U inj A4 DELTA`), t);
  };
  await reload();
  const railA = await rows();
  check('R: the switched chat is one row in the rail', railA.filter((x) => /inj A1 ALPHA/.test(x)).length === 1, railA);
  await openRow(railA.find((x) => /inj A1 ALPHA/.test(x)));
  await looksRight('a reload and a reopen from the rail');
  await shot(s, path.join(SHOTS, 'R-reopened.png'), { preview: false });
  // conn_thread_read, through codex itself, on the reopened chat.
  const nRead = requests().length;
  await send('codex-read {"query":"inj A1 ALPHA"}');
  await until(async () => requests().slice(nRead).some((r) => (r.body?.input || []).some((m) => m.type === 'custom_tool_call_output')), 90000);
  await idle();
  const out = requests().slice(nRead).flatMap((r) => (r.body?.input || []).filter((m) => m.type === 'custom_tool_call_output')).map((m) => (typeof m.output === 'string' ? m.output : (m.output || []).map((x) => x.text || '').join('\n'))).at(-1) || '';
  note('R: conn_thread_read answer', out.slice(0, 500));
  check('R: conn_thread_read finds the first message once, and never an injected item as a turn', (out.match(/<item id="[^"]*"[^>]*>\ninj A1 ALPHA\n<\/item>/g) || []).length === 1 && !/conn-handoff|delivery=/.test(out), out.slice(0, 600));
  restartFn = restart;
  await restart(s);
  await openRow((await rows()).find((x) => /inj A1 ALPHA/.test(x)));
  TYPED_A.push('codex-read {"query":"inj A1 ALPHA"}');
  await looksRight('a true restart');
  TYPED_A.pop();

  }

  if (want('X')) {
  // ---- X: refused ----------------------------------------------------------
  await click(s, 'New chat');
  await sleep(800);
  await pick('claude');
  await send('inj X1 ECHO');
  await waitReply('heard: inj X1 ECHO');
  await idle();
  await pick('codex');
  await main("globalThis.__injectMode = 'refuse', 1");
  await send('inj X2 FOXTROT');
  await waitReply('codex heard: inj X2 FOXTROT');
  await idle();
  await main("globalThis.__injectMode = null, 1");
  const rX2 = turnReq('inj X2 FOXTROT') || requests().find((r) => r.seen?.user?.endsWith('inj X2 FOXTROT'));
  check('X: refused, the text goes in front of the message in the same send', rX2?.seen?.pasted === true && rX2.seen.pastedDelivery === 'inline' && !rX2.seen.injected.length && /User message:\ninj X2 FOXTROT$/.test(rX2.seen.user), rX2?.seen);
  const rowsX = await handoffRows();
  check('X: the row says inline', / · inline$/.test(rowsX.at(-1) || ''), rowsX);
  check('X: one request for the turn, with the history once', requests().filter((r) => r.seen?.user?.includes('inj X2 FOXTROT')).every((r) => (r.seen.user.match(/<conn-handoff/g) || []).length === 1), null);

  }

  if (want('U')) {
  // ---- U: unanswered, then a death -----------------------------------------
  for (const mode of ['hang', 'die']) {
    const tag = mode === 'hang' ? 'U' : 'D';
    await click(s, 'New chat');
    await sleep(800);
    await pick('claude');
    await send(`inj ${tag}1 GOLF`);
    await waitReply(`heard: inj ${tag}1 GOLF`);
    await idle();
    await pick('codex');
    await send(`inj ${tag}2 HOTEL`);
    await waitReply(`codex heard: inj ${tag}2 HOTEL`);
    await idle();
    await pick('claude');
    await send(`inj ${tag}3 INDIA`);
    await waitReply(`heard: inj ${tag}3 INDIA`);
    await idle();
    await pick('codex');
    await main(`globalThis.__injectMode = ${J(mode)}, 1`);
    const before = (await main('JSON.stringify(globalThis.__injects)').then(JSON.parse)).length;
    await send(`inj ${tag}4 JULIET`);
    await waitReply(`codex heard: inj ${tag}4 JULIET`, 90000);
    await idle();
    await main("globalThis.__injectMode = null, 1");
    const injs = (await main('JSON.stringify(globalThis.__injects)').then(JSON.parse)).slice(before);
    note(`${tag}: injects for the turn`, injs);
    const doubt = injs[0]?.thread;
    const reqs = requests().filter((r) => r.seen?.user?.includes(`inj ${tag}4 JULIET`));
    const r4 = reqs[0];
    check(`${tag}: one inject for the handoff, never retried`, injs.length === 1 && injs[0].mode === mode, injs);
    check(`${tag}: the turn went to a new thread with the whole chat pasted, saying so`, reqs.length >= 1 && r4.seen.pasted && r4.seen.pastedDelivery === 'new-thread'
      && /scope="full"/.test(r4.seen.user) && r4.seen.user.includes(`inj ${tag}1 GOLF`) && r4.seen.user.includes(`inj ${tag}3 INDIA`) && !r4.seen.injected.length, r4?.seen && { ...r4.seen, user: r4.seen.user.slice(0, 400) });
    check(`${tag}: no request carried that handoff twice`, reqs.every((r) => (r.seen.user.match(/<conn-handoff/g) || []).length === 1 && !r.seen.injected.some((b) => b.some((m) => m.text.includes(`inj ${tag}3 INDIA`)))), reqs.length);
    const rollDoubt = rolloutOf(doubt);
    note(`${tag}: the thread in doubt`, { injected: injectedIn(rollDoubt), turns: turnsIn(rollDoubt) });
    check(`${tag}: the thread in doubt got no turn after the inject`, !!rollDoubt && turnsIn(rollDoubt) === 1, { turns: turnsIn(rollDoubt) });
    const rowsU = await handoffRows();
    check(`${tag}: the row says inline on a new thread`, / · inline on a new thread$/.test(rowsU.at(-1) || ''), rowsU);
    await shot(s, path.join(SHOTS, `${tag}-new-thread-row.png`), { preview: false });
    await send(`inj ${tag}5 KILO`);
    await waitReply(`codex heard: inj ${tag}5 KILO`);
    await idle();
    const r5 = turnReq(`inj ${tag}5 KILO`);
    check(`${tag}: the next message goes to the new thread, typed only, history there once`, r5?.seen?.pasted === false && requests().filter((r) => r.seen?.user?.includes(`inj ${tag}4 JULIET`)).length >= 1
      && (r5.body.input.filter((m) => m.role === 'user' && /<conn-handoff/.test((m.content || []).map((c) => c.text).join(''))).length === 1), r5?.seen);
    await reload();
    const rail = await rows();
    check(`${tag}: the rail shows one chat`, rail.filter((x) => x.includes(`inj ${tag}1 GOLF`)).length === 1, rail);
    await openRow(rail.find((x) => x.includes(`inj ${tag}1 GOLF`)));
    const t = await transcript();
    const b = bubblesOk(t, [`inj ${tag}1 GOLF`, `inj ${tag}2 HOTEL`, `inj ${tag}3 INDIA`, `inj ${tag}4 JULIET`, `inj ${tag}5 KILO`]);
    check(`${tag}: reopened, each message once and the rows injected, inline, inline on a new thread`, b.ok && (await handoffRows()).map((l) => / · (injected|inline on a new thread|inline)$/.exec(l)?.[1]).join() === 'injected,inline,inline on a new thread', { b, rows: await handoffRows() });
  }

  }

  if (want('F')) {
  // ---- F: a failed turn after the handoff went, then Retry ------------------
  // A new chat on Claude, unless the one on screen is the window's first, still blank.
  if ((await transcript()).length) {
    await click(s, 'New chat');
    await sleep(800);
    await pick('claude');
  }
  await send('inj F1 LIMA');
  await waitReply('heard: inj F1 LIMA');
  await idle();
  await pick('codex');
  await send('inj F2 fail-once-token');
  await until(async () => fs.existsSync(FAIL_ONCE), 60000);
  await idle();
  await sleep(1500);
  await shot(s, path.join(SHOTS, 'F-failed-turn.png'), { preview: false });
  note('F: the chat after the failed turn', await transcript());
  const rowsF = await handoffRows();
  check('F: the turn failed but the handoff went: the row says injected, not pending', / · injected$/.test(rowsF.at(-1) || ''), rowsF);
  // The failed turn's own Retry, not the one each bubble offers on hover.
  const retried = await click(s, 'css=[data-turn-error] button').then(() => true).catch(() => false);
  if (!retried) await send('inj F2 fail-once-token');
  note('F: retried with', retried ? 'the failed turn\'s Retry button' : 'the same message again');
  check('F: the retry is answered', !!(await waitReply('codex heard: inj F2 fail-once-token')), await transcript());
  await idle();
  // Every request whose thread holds the failed message: the failed turn's and the retry's.
  const fReqs = requests().filter((r) => (r.body?.input || []).some((m) => m.role === 'user' && textOf(m) === 'inj F2 fail-once-token'));
  const pastedAnywhere = (r) => (r.body?.input || []).some((m) => m.role === 'user' && /<conn-handoff/.test(textOf(m)) && !/^\s*<conn-handoff[^>]*delivery="injected"/.test(textOf(m)));
  note('F: requests for the turn and its retry', fReqs.map((r) => ({ injected: r.seen.injected.length, pasted: pastedAnywhere(r), user: r.seen.user.slice(0, 80) })));
  check('F: neither the failed turn nor the retry carried the handoff a second time', fReqs.length >= 2 && fReqs.every((r) => r.seen.injected.length === 1 && !pastedAnywhere(r)), fReqs.map((r) => r.seen.injected.length));
  const fInjects = (await main('JSON.stringify(globalThis.__injects)').then(JSON.parse));
  check('F: one inject for the chat', fInjects.filter((x) => x.thread === fInjects.at(-1)?.thread).length === 1, fInjects);

  // ---- K: Fork to a New Chat on ChatGPT --------------------------------------
  await pick('claude');
  await send('inj F3 MIKE');
  await waitReply('heard: inj F3 MIKE');
  await idle();
  await click(s, `xy=${await trigger()}`);
  await sleep(400);
  await hover(s, 'Fork to a New Chat');
  await sleep(900);
  await click(s, 'Fast, go-to model for coding and everyday work.');
  await sleep(2500);
  await send('inj K1 fork hello');
  await waitReply('codex heard: inj K1 fork hello');
  await idle();
  const rK = turnReq('inj K1 fork hello');
  check('K: a fork to ChatGPT is injected too', !!rK?.seen?.injectedAhead && /fork="yes"/.test(rK.seen.injected.at(-1)[0].text) && rK.seen.pasted === false, rK?.seen && { injected: rK.seen.injected.length, pasted: rK.seen.pasted });
  const rowsK = await handoffRows();
  check('K: the fork\'s row says injected', /^Forked from Claude to ChatGPT .* · injected$/.test(rowsK.at(-1) || ''), rowsK);
  await reload();
  const railK = await rows();
  const forkTitle = railK.filter((x) => x.includes('inj F1 LIMA'));
  note('K: rail rows for the forked chat', forkTitle);
  await openRow(forkTitle[0]);
  const tK = await transcript();
  note('K: the fork reopened', tK);
  check('K: reopened, the fork\'s row still says injected and its message is one bubble', tK.filter((x) => x.includes('inj K1 fork hello')).length === 1 && tK.some((x) => /^H Forked from Claude to ChatGPT .* · injected$/.test(x)), tK);
  await shot(s, path.join(SHOTS, 'K-fork-reopened.png'), { preview: false });
  }
} catch (e) {
  check('the run finished', false, e.stack);
} finally {
  const off = net.stop();
  check('no agent and no provider API was reached off the machine', !off.bad.length, off.bad);
  console.log(`NOTE the app's own traffic off the machine: ${J(off.app.map((x) => x.peer))}`);
  if (!process.env.KEEP) await stop(s).catch((e) => console.log(`NOTE stop failed: ${e.message}`));
  api.kill();
  fs.rmSync(log, { force: true });
  fs.rmSync(FAIL_ONCE, { force: true });
  cleanupShims();
}
void restartFn;

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
  // The transport patch and the short timeout again, for the scenarios after this.
  await main(`(() => {
    const { AppServer } = req('./codex-rpc');
    const orig = AppServer.prototype.request;
    globalThis.__injects = globalThis.__injects || [];
    AppServer.prototype.request = function (m, p, t) {
      if (m !== 'thread/inject_items') return orig.call(this, m, p, t);
      const mode = globalThis.__injectMode || 'real';
      globalThis.__injects.push({ mode, thread: p.threadId, items: p.items.length, at: Date.now() });
      if (mode === 'refuse') return orig.call(this, 'thread/inject_itemz', p, t);
      const pr = orig.call(this, m, p, t);
      if (mode === 'hang') this.pending.delete(this.seq);
      if (mode === 'die') setTimeout(() => { try { process.kill(-this.child.pid, 'SIGKILL'); } catch { this.child.kill('SIGKILL'); } }, 0);
      return pr;
    };
    req('./codex').CodexSession.injectMs = 3000;
    return 1;
  })()`);
  await sleep(6000);
  console.log(`restarted pid=${child.pid}`);
}

console.log(failures.length ? `\n${failures.length} failed: ${failures.join(', ')}` : '\nall passed');
process.exit(failures.length ? 1 : 0);
