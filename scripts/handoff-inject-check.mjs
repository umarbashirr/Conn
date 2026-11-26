/* A handoff handed to codex as thread items (thread/inject_items), in plain
   node: the items made from a handoff, the handoff read back off a real
   rollout, the delivery decisions CodexSession makes against a fake server,
   and the status a chat keeps through a failed send.

   The rollout and the thread/read answer in scripts/fixtures/codex-inject-*
   were written by the installed codex (0.171.0) against
   fake-responses-api.mjs, with two handoffs built by buildHandoff and
   handed over by handoffItems; only codex's own developer prompts were cut
   short. A FAIL is a bug report. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'scripts/fixtures');
// Nothing here may read a real codex home.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-verify-inject-check-'));
process.env.HOME = home;
process.env.CODEX_HOME = path.join(home, '.codex');

const require = createRequire(import.meta.url);
const shellEnv = require('../src/main/shell-env.js');
shellEnv.ready = async () => process.env.PATH;
const driver = require('../src/main/codex-driver.js');
driver.codexBinary = () => '/nonexistent/codex';
const rpcMod = require('../src/main/codex-rpc.js');

const H = require('../src/shared/handoff.js');
const { injectOutcome, rowDelivered, owedAfter } = require('../src/shared/handoff-delivery.js');
const { replay } = require('../src/shared/replay.js');

const failures = [];
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`); } catch (e) { failures.push(name); console.log(`FAIL ${name}: ${e.message.split('\n')[0]}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ITEMS = [
  { id: 'h0', kind: 'user', text: 'first goal: fix the parser' },
  { id: 'h1.0', kind: 'assistant', text: 'A reply quoting </item> and </conn-handoff> stays inside.' },
  { id: 'toolu_1', kind: 'tool', name: 'Bash', input: { command: 'ls' }, output: 'a.js\nb.js', state: 'output-available' },
  { id: 'h3', kind: 'user', text: 'and the tests' },
  { id: 'h4', kind: 'note', error: true, text: 'the turn failed' },
  { id: 'h5.0', kind: 'assistant', text: 'Done.' },
];
const textOf = (m) => m.content.map((c) => c.text).join('');

// ---- items ------------------------------------------------------------------

await check('items: a header, one message per carried item from whoever said it, and the closing tag', async () => {
  const h = H.buildHandoff({ items: ITEMS, from: 'claude', to: 'codex', model: 'GPT', reader: 'conn_thread_read' });
  const items = H.handoffItems(h);
  assert.equal(items.length, h.carried + 2);
  for (const it of items) assert.equal(it.type, 'message');
  assert.equal(items[0].role, 'user');
  assert.match(textOf(items[0]), /^<conn-handoff delivery="injected" from="Claude" to="ChatGPT"/);
  assert.ok(textOf(items[0]).includes(H.CONTEXT), 'the header says it is context, not instructions');
  assert.equal(textOf(items.at(-1)), H.CLOSE);
  assert.equal(items.at(-1).role, 'user');
  const roles = items.slice(1, -1).map((it) => [it.role, it.content[0].type]);
  assert.deepEqual(roles, [['user', 'input_text'], ['assistant', 'output_text'], ['assistant', 'output_text'], ['user', 'input_text'], ['user', 'input_text'], ['assistant', 'output_text']]);
  // The tool call rides as the text the inline handoff carries, not as a call codex would think it made.
  assert.match(textOf(items[3]), /^<item id="toolu_1" role="assistant" kind="tool"/);
  assert.ok(textOf(items[2]).includes('<\\/item> and <\\/conn-handoff>'), 'carried text is escaped as inline');
});

await check('items: joined back they are the inline handoff, but for the tag saying how it went', async () => {
  const h = H.buildHandoff({ items: ITEMS, from: 'claude', to: 'codex', model: 'GPT', cap: 60, reader: 'conn_thread_read' });
  assert.ok(h.omittedIds.length > 0, 'something is left out');
  const joined = H.itemTexts(H.handoffItems(h)).join('\n');
  assert.equal(joined.replace(' delivery="injected"', ''), h.text);
  assert.match(textOf(H.handoffItems(h)[0]), /Left out to fit your context window .*\nRead any of them with conn_thread_read: \{"ids":/);
});

await check('items: read back as a stored prompt, they unwrap to the typed message and the carried entries', async () => {
  const h = H.buildHandoff({ items: ITEMS, from: 'claude', to: 'codex', model: 'GPT' });
  const prompt = H.injectedPrompt(H.itemTexts(H.handoffItems(h)), 'what I typed');
  const u = H.unwrapHandoff(prompt);
  assert.equal(u.handoff, true);
  assert.equal(u.text, 'what I typed');
  assert.equal(u.delivery, 'injected');
  assert.equal(u.carried, h.carried);
  assert.equal(u.total, h.total);
  assert.deepEqual(u.entries().map((e) => e.body), h.entries.map((e) => H.unescape(e.text.split('\n').slice(1, -1).join('\n'))));
  assert.equal(H.typedText(prompt), 'what I typed');
  assert.equal(H.unwrapHandoff(H.wrapMessage(h.text, 'x')).delivery, 'inline', 'a plain inline handoff reads as inline');
  assert.equal(H.unwrapHandoff(H.wrapMessage(H.withDelivery(h.text, 'new-thread'), 'x')).delivery, 'new-thread');
  assert.equal(H.injectedPrompt(['<conn-handoff from="a">', 'no close'], 'x'), null, 'half a block is not a handoff');
  assert.equal(H.injectedPrompt([h.text], 'x'), null, 'an inline handoff is not an injected one');
});

// ---- reading it back off a real rollout -------------------------------------

const history = require('../src/main/codex-history.js');
const threadRead = JSON.parse(fs.readFileSync(path.join(FIX, 'codex-inject-thread-read.json'), 'utf8'));
const rolloutFile = path.join(FIX, 'codex-inject-rollout.jsonl');

await check('rollout: both injected handoffs are found, each under the turn it went ahead of', async () => {
  const got = history.injectedHandoffs(rolloutFile);
  const turns = threadRead.thread.turns.map((t) => t.id);
  assert.deepEqual([...got.keys()], [turns[0], turns[2]]);
  const first = H.unwrapHandoff(H.injectedPrompt(got.get(turns[0]), 'x'));
  assert.deepEqual([first.delivery, first.scope, first.carried, first.total], ['injected', 'full', 2, 5]);
  const second = H.unwrapHandoff(H.injectedPrompt(got.get(turns[2]), 'x'));
  assert.deepEqual([second.scope, second.carried, second.total], ['since', 2, 2]);
});

await check('rollout: thread/read itself shows none of the injected items', async () => {
  const texts = threadRead.thread.turns.flatMap((t) => t.items.map((i) => i.text || (i.content || []).map((c) => c.text).join('')));
  assert.deepEqual(texts, ['typed after the first handoff', 'codex heard: typed after the first handoff', 'a plain codex turn', 'codex heard: a plain codex turn', 'typed after the second handoff', 'codex heard: typed after the second handoff']);
});

function writeRollout(lines) {
  const f = path.join(home, `r-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(f, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return f;
}
const ri = (role, text) => ({ type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] } });
const started = (id) => ({ type: 'event_msg', payload: { type: 'task_started', turn_id: id } });

await check('rollout: a block with no turn after it goes with the next turn; half a block, or an inline one, with none', async () => {
  const h = H.buildHandoff({ items: ITEMS, from: 'claude', to: 'codex' });
  const texts = H.itemTexts(H.handoffItems(h));
  const f = writeRollout([
    started('t0'), ri('user', 'plain'),
    ...texts.map((t, i) => ri(H.handoffItems(h)[i].role, t)),
    // The turn this went with never started; the retry is t1.
    started('t1'), ri('user', 'retried'),
    ri('user', texts[0]), ri('user', texts[1]),
    started('t2'),
    ri('user', H.wrapMessage(h.text, 'inline one')),
    started('t3'),
  ]);
  const got = history.injectedHandoffs(f);
  assert.deepEqual([...got.keys()], ['t1']);
  assert.deepEqual(got.get('t1'), texts);
  assert.equal(history.injectedHandoffs(path.join(home, 'missing.jsonl')).size, 0);
});

class HistoryServer extends EventEmitter {
  constructor() { super(); this.closed = false; }
  async start() { return {}; }
  async request(method, params) {
    if (method === 'thread/read' && params.threadId === threadRead.thread.id) return { thread: { ...threadRead.thread, path: rolloutFile } };
    throw Object.assign(new Error(`no ${method}`), { answered: true, code: -32600 });
  }
  close() { this.closed = true; }
}

await check('readSession: injected handoffs come back as handoff rows saying injected, the bubbles only what was typed', async () => {
  const { start, request } = rpcMod.AppServer.prototype;
  rpcMod.AppServer.prototype.start = HistoryServer.prototype.start;
  rpcMod.AppServer.prototype.request = HistoryServer.prototype.request;
  let t;
  try {
    t = await history.readSession(home, threadRead.thread.id, { whole: true });
  } finally {
    history.close();
    Object.assign(rpcMod.AppServer.prototype, { start, request });
  }
  const rows = replay(t.messages);
  const shape = rows.map((r) => (r.kind === 'handoff' ? `handoff:${r.method}:${r.carried}/${r.total}:${r.scope}` : `${r.kind}:${r.text}`));
  assert.deepEqual(shape, [
    'handoff:injected:2/5:full', 'user:typed after the first handoff', 'assistant:codex heard: typed after the first handoff',
    'user:a plain codex turn', 'assistant:codex heard: a plain codex turn',
    'handoff:injected:2/2:since', 'user:typed after the second handoff', 'assistant:codex heard: typed after the second handoff',
  ]);
  // Ids stay where they were: the handoff takes its message's id, not a new place.
  assert.deepEqual(rows.filter((r) => r.kind === 'user').map((r) => r.id), ['h0', 'h2', 'h4']);
  assert.ok(!rows.some((r) => /<item |conn-handoff/.test(r.text || '')), 'no carried text in a bubble');
  assert.equal(t.messages.filter(H.carriesHandoff).length, 2, 'the stitched reads cut at both');
  const md = require('../src/main/chat-export.js').toMarkdown({ title: 't', messages: t.messages });
  assert.ok(!/conn-handoff|<item /.test(md), 'export shows no carried text');
  assert.ok(md.includes('typed after the second handoff'));
});

// ---- what a failed inject proves -------------------------------------------

await check('outcome: a refusal proves nothing went; silence and a death prove nothing either way', async () => {
  const e = (o) => Object.assign(new Error(o.message || 'x'), o);
  assert.deepEqual(injectOutcome(e({ answered: true, code: -32600, message: 'Invalid request: unknown variant `thread/inject_items`, expected one of …' })), { how: 'refused', unsupported: true });
  assert.deepEqual(injectOutcome(e({ answered: true, code: -32601, message: 'Method not found' })), { how: 'refused', unsupported: true });
  assert.deepEqual(injectOutcome(e({ answered: true, code: -32600, message: 'Invalid request: missing field `items`' })), { how: 'refused', unsupported: false });
  assert.deepEqual(injectOutcome(e({ answered: true, code: -32602, message: 'invalid params' })), { how: 'refused', unsupported: false });
  assert.deepEqual(injectOutcome(e({ answered: true, code: -32603, message: 'internal error' })), { how: 'unsure', unsupported: false });
  assert.deepEqual(injectOutcome(e({ unanswered: true, message: 'codex did not answer thread/inject_items in time' })), { how: 'unsure', unsupported: false });
  assert.deepEqual(injectOutcome(e({ unanswered: true, message: 'codex app-server exited (null)' })), { how: 'unsure', unsupported: false });
  assert.deepEqual(injectOutcome(e({ unsent: true })), { how: 'refused', unsupported: false });
  assert.deepEqual(injectOutcome(new Error('anything else')), { how: 'unsure', unsupported: false });
});

await check('codex-rpc: an error answer keeps its code; a timeout and a death say they went unanswered', async () => {
  // A stand-in app-server: refuses `refuse`, never answers `hang`, exits on `die`.
  const bin = path.join(home, 'fake-app-server.js');
  fs.writeFileSync(bin, `let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    const say = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...o }) + '\\n');
    if (m.method === 'initialize') say({ result: {} });
    else if (m.method === 'refuse') say({ error: { code: -32600, message: 'Invalid request: unknown variant' } });
    else if (m.method === 'die') process.exit(3);
  }
});
`);
  const s = new rpcMod.AppServer({ bin, cwd: home });
  await s.start({ clientInfo: { name: 'check', version: '0' } });
  try {
    await assert.rejects(s.request('refuse', {}), (err) => err.answered === true && err.code === -32600 && !err.unanswered);
    await assert.rejects(s.request('hang', {}, 100), (err) => err.unanswered === true && !err.answered);
    await assert.rejects(s.request('die', {}), (err) => err.unanswered === true && /exited/.test(err.message));
    await assert.rejects(s.request('after', {}), (err) => err.unsent === true);
  } finally {
    s.close();
  }
});

// ---- CodexSession against a fake server -------------------------------------

const { CodexSession } = require('../src/main/codex.js');
let servers = [];
// `inject`: 'ok' | 'unknown' | 'invalid' | 'hang' | 'die'. `boot`: false for a server that will not start.
function fakeServer(plan) {
  return (opts) => {
    const srv = new EventEmitter();
    srv.n = servers.length;
    srv.calls = [];
    srv.closed = false;
    srv.opts = opts;
    srv.start = async () => {
      if (plan.boot === false && srv.n > 0) throw new Error('codex would not start');
      return {};
    };
    srv.close = () => { srv.closed = true; };
    srv.request = (method, params, timeout) => {
      srv.calls.push({ method, params });
      if (srv.closed) return Promise.reject(Object.assign(new Error('not running'), { unsent: true }));
      if (method === 'thread/start') return Promise.resolve({ thread: { id: `thread-${srv.n}` }, model: 'gpt' });
      if (method === 'thread/resume') return Promise.resolve({ thread: { id: params.threadId }, model: 'gpt' });
      if (method === 'turn/start') return Promise.resolve({ turn: { id: `turn-${srv.calls.length}` } });
      if (method === 'turn/steer') return Promise.resolve({});
      if (method === 'thread/inject_items') {
        const how = srv.n === 0 ? plan.inject : (plan.later || 'ok');
        if (how === 'ok') return Promise.resolve({});
        if (how === 'unknown') return Promise.reject(Object.assign(new Error('Invalid request: unknown variant `thread/inject_items`'), { answered: true, code: -32600 }));
        if (how === 'invalid') return Promise.reject(Object.assign(new Error('Invalid request: missing field `items`'), { answered: true, code: -32600 }));
        if (how === 'hang') return new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('codex did not answer thread/inject_items in time'), { unanswered: true })), timeout));
        if (how === 'die') {
          return new Promise((_, rej) => setTimeout(() => {
            srv.closed = true;
            rej(Object.assign(new Error('codex app-server exited (null)'), { unanswered: true }));
            srv.emit('closed', 'codex app-server exited (null)');
          }, 20));
        }
      }
      return Promise.resolve({});
    };
    servers.push(srv);
    return srv;
  };
}
async function session(plan, extra = {}) {
  servers = [];
  const s = new CodexSession({ cwd: home, server: fakeServer(plan), ...extra });
  const events = [];
  for (const ev of ['ready', 'error', 'closed']) s.on(ev, (x) => events.push([ev, x?.sessionId || x || null]));
  s.on('message', (m) => { if (m.type === 'user') events.push(['user', m.message.content[0].text]); });
  await s.start();
  return { s, events };
}
const H1 = H.buildHandoff({ items: ITEMS, from: 'claude', to: 'codex' });
const WHOLE = H.buildHandoff({ items: [...ITEMS, { id: 'h6', kind: 'user', text: 'more' }], from: 'claude', to: 'codex' });
const payload = (whole = false) => ({ text: H1.text, items: H.handoffItems(H1), ...(whole && { whole: WHOLE.text }) });
const turnText = (srv) => srv.calls.filter((c) => c.method === 'turn/start').map((c) => c.params.input.at(-1).text);
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (!fn() && Date.now() < end) await sleep(10); return fn(); };

await check('session: injected, then the turn carries only what was typed', async () => {
  const { s, events } = await session({ inject: 'ok' });
  const res = await s.sendHandoff('hello', [], payload());
  assert.deepEqual(res, { delivery: 'injected', sessionId: 'thread-0' });
  await until(() => turnText(servers[0]).length);
  const calls = servers[0].calls.map((c) => c.method);
  assert.deepEqual(calls, ['thread/start', 'thread/inject_items', 'turn/start']);
  const inj = servers[0].calls[1].params;
  assert.equal(inj.threadId, 'thread-0');
  assert.deepEqual(inj.items, H.handoffItems(H1));
  assert.deepEqual(turnText(servers[0]), ['hello']);
  assert.deepEqual(events.filter((e) => e[0] === 'user'), [['user', 'hello']]);
});

await check('session: a codex without the method gets the text in the same send, and is never asked again', async () => {
  const { s } = await session({ inject: 'unknown' });
  assert.deepEqual(await s.sendHandoff('hello', [], payload()), { delivery: 'inline', sessionId: 'thread-0' });
  await until(() => turnText(servers[0]).length);
  assert.deepEqual(turnText(servers[0]), [H.wrapMessage(H1.text, 'hello')]);
  assert.equal(s.noInject, true);
  s.busy = false; // the fake server never ends a turn
  assert.deepEqual(await s.sendHandoff('again', [], payload()), { delivery: 'inline', sessionId: 'thread-0' });
  await until(() => turnText(servers[0]).length === 2);
  assert.equal(servers[0].calls.filter((c) => c.method === 'thread/inject_items').length, 1);
  assert.equal(turnText(servers[0])[1], H.wrapMessage(H1.text, 'again'));
});

await check('session: a refused request goes inline that once; the next handoff tries again', async () => {
  const { s } = await session({ inject: 'invalid' });
  assert.equal((await s.sendHandoff('hello', [], payload())).delivery, 'inline');
  assert.equal(s.noInject, false);
  await until(() => turnText(servers[0]).length);
  assert.equal(turnText(servers[0])[0], H.wrapMessage(H1.text, 'hello'));
});

for (const how of ['hang', 'die']) {
  await check(`session: an inject that ${how === 'hang' ? 'goes unanswered' : 'dies with the server'} moves to a new thread, where the whole chat goes as text`, async () => {
    CodexSession.injectMs = 60;
    const { s, events } = await session({ inject: how });
    const res = await s.sendHandoff('hello', [], payload(true));
    assert.deepEqual(res, { delivery: 'new-thread', whole: true, sessionId: 'thread-1' });
    await until(() => turnText(servers[1]).length);
    // Nothing more went to the thread in doubt: no second inject, no text, no turn.
    assert.deepEqual(servers[0].calls.map((c) => c.method), ['thread/start', 'thread/inject_items']);
    assert.equal(servers[0].closed, true);
    assert.deepEqual(servers[1].calls.map((c) => c.method), ['thread/start', 'turn/start']);
    const sent = turnText(servers[1])[0];
    assert.equal(H.unwrapHandoff(sent).delivery, 'new-thread');
    assert.equal(H.unwrapHandoff(sent).text, 'hello');
    assert.equal(H.unwrapHandoff(sent).total, WHOLE.total, 'the whole chat, not the part since');
    assert.deepEqual(events.filter((e) => e[0] !== 'user'), [['ready', 'thread-0'], ['ready', 'thread-1']], 'the chat hears of the new thread and nothing ended');
    assert.equal(s.closed, false);
    assert.equal(s.sessionId, 'thread-1');
    CodexSession.injectMs = 15000;
  });
}

await check('session: no new thread to be had is lost, and the session ends', async () => {
  CodexSession.injectMs = 40;
  const { s, events } = await session({ inject: 'hang', boot: false });
  assert.deepEqual(await s.sendHandoff('hello', [], payload()), { lost: true });
  await until(() => s.closed);
  assert.equal(s.closed, true);
  assert.ok(events.some((e) => e[0] === 'closed'));
  assert.ok(!servers.some((srv) => srv.calls.some((c) => c.method === 'turn/start')), 'nothing was pasted anywhere');
  CodexSession.injectMs = 15000;
});

await check('session: a thread an inject went unanswered on is never injected again', async () => {
  const { s } = await session({ inject: 'ok' });
  s.unsure.add('thread-0');
  CodexSession.injectMs = 40;
  const res = await s.sendHandoff('hello', [], payload());
  assert.equal(res.delivery, 'new-thread');
  assert.ok(!servers[0].calls.some((c) => c.method === 'thread/inject_items'));
  CodexSession.injectMs = 15000;
});

await check('session: busy, it goes as text into the running turn', async () => {
  const { s } = await session({ inject: 'ok' });
  s.send('first');
  assert.deepEqual(await s.sendHandoff('second', [], payload()), { delivery: 'inline', sessionId: 'thread-0' });
  await until(() => servers[0].calls.some((c) => c.method === 'turn/steer'));
  assert.ok(!servers[0].calls.some((c) => c.method === 'thread/inject_items'));
  assert.equal(servers[0].calls.find((c) => c.method === 'turn/steer').params.input.at(-1).text, H.wrapMessage(H1.text, 'second'));
});

await check('session: a message sent while the inject is in flight steers into the turn after it', async () => {
  const { s } = await session({ inject: 'ok' });
  const res = s.sendHandoff('with handoff', [], payload());
  s.send('right behind it');
  await res;
  await until(() => servers[0].calls.some((c) => c.method === 'turn/steer'));
  assert.deepEqual(servers[0].calls.map((c) => c.method), ['thread/start', 'thread/inject_items', 'turn/start', 'turn/steer']);
  assert.equal(servers[0].calls[3].params.expectedTurnId, 'turn-3');
});

await check('session: the inject comes after the thread exists and before a turn/start that waits for the conn server', async () => {
  const previews = { command: process.execPath, args: ['mcp.js'], env: {} };
  const { s } = await session({ inject: 'ok' }, { previews });
  s.connStatus = 'starting';
  const res = await s.sendHandoff('hello', [], payload());
  assert.equal(res.delivery, 'injected');
  await sleep(150);
  assert.deepEqual(servers[0].calls.map((c) => c.method), ['thread/start', 'thread/inject_items'], 'no turn while conn is starting');
  // codex says the conn server is up.
  servers[0].emit('notification', 'mcpServer/startupStatus/updated', { name: 'conn', status: 'ready' });
  await until(() => turnText(servers[0]).length);
  assert.deepEqual(servers[0].calls.map((c) => c.method), ['thread/start', 'thread/inject_items', 'turn/start']);
});

// ---- the chat's status ------------------------------------------------------

await check('status: pending, then the way it went; a failed send keeps one that went and owes one that did not', async () => {
  const row = { id: 'm', kind: 'handoff', pending: true };
  const carry = { carried: 3, total: 9, scope: 'since' };
  const whole = { carried: 7, total: 20, scope: 'full' };
  assert.deepEqual(rowDelivered(row, { carry }), { id: 'm', kind: 'handoff', pending: false, carried: 3, total: 9, scope: 'since' });
  assert.equal(rowDelivered(row, { carry, res: { delivery: 'injected' } }).method, 'injected');
  assert.deepEqual(rowDelivered(row, { carry, whole, res: { delivery: 'new-thread', whole: true } }), { id: 'm', kind: 'handoff', pending: false, carried: 7, total: 20, scope: 'full', method: 'new-thread' });
  const owed = { since: 5, used: 900, from: 'claude', marker: 'm' };
  assert.equal(owedAfter(owed, { error: 'turn failed', delivery: 'injected' }), null, 'went: never again');
  assert.equal(owedAfter(owed, { error: 'no codex' }), owed, 'never went: owed as it was');
  assert.equal(owedAfter(owed, null), owed, 'no answer at all: nothing proved it went');
  assert.deepEqual(owedAfter(owed, { error: 'gone', lost: true }), { ...owed, since: 0, used: 0, fresh: true }, 'in doubt: the whole chat, on a new thread');
});

await check('renderer: the send hands main the typed text and the handoff beside it, never pasted together', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/renderer/ui/useAgent.js'), 'utf8');
  assert.ok(!/wrapMessage\(/.test(src), 'the window no longer pastes the handoff into the message');
  assert.match(src, /carry \? \{ text: carry\.text, items: handoffItems\(carry\)/);
  assert.match(src, /owedAfter\(owed, res\)/);
  const app = fs.readFileSync(path.join(ROOT, 'src/renderer/ui/App.jsx'), 'utf8');
  assert.match(app, /HANDOFF_METHOD = \{ injected: 'injected', inline: 'inline', 'new-thread': 'inline on a new thread' \}/);
});

fs.rmSync(home, { recursive: true, force: true });
console.log(failures.length ? `\n${failures.length} failed: ${failures.join(', ')}` : '\nall passed');
process.exit(failures.length ? 1 : 0);
