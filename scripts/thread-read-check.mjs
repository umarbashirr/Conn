/* conn_thread_read under plain node, on a throwaway HOME: ids that stay the
   same however a chat is read, paging with `next`, the token cap, reading only
   the calling chat, search, and the handoff naming the tool only when the
   agent it goes to has it. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-thread-read-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.SHELL = '/bin/false';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const history = require('../src/main/history.js');
const { readThread, replayStored } = require('../src/shared/replay.js');
const { entriesOf, buildHandoff, wrapMessage } = require('../src/shared/handoff.js');
const { pick, answer, countOf, NAME, CAP } = require('../src/shared/thread-tool.js');
const { createThreadReader } = require('../src/main/thread-read.js');

const failures = [];
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`); } catch (e) { failures.push(name); console.log(`FAIL ${name}: ${e.message.split('\n')[0]}`); }
};

// Two Claude transcripts on disk: chat one ran on A, then Copilot B (stubbed
// below), then A again; chat two is C alone.
const A = 'aaaaaaaa-1111-4000-8000-000000000001';
const B = 'bbbbbbbb-2222-4000-8000-000000000002';
const C = 'cccccccc-3333-4000-8000-000000000003';
const cwd = path.join(home, 'work', 'shop');
const dir = path.join(home, '.claude', 'projects', cwd.replace(/[/.]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const line = (type, content) => JSON.stringify({ type, cwd, message: { role: type, content } });
const said = (text) => line('assistant', [{ type: 'text', text }]);
const tool = (id, command, out) => [line('assistant', [{ type: 'tool_use', id, name: 'Bash', input: { command } }]), line('user', [{ type: 'tool_result', tool_use_id: id, content: out }])];
const write = (id, lines) => fs.writeFileSync(path.join(dir, `${id}.jsonl`), `${lines.join('\n')}\n`);
const handed = (text) => wrapMessage(buildHandoff({ items: [{ id: 'h0', kind: 'user', text: 'earlier' }], from: 'copilot', to: 'claude', window: 200000 }).text, text);
write(A, [
  line('user', 'Fix the login bug on the CHECKOUT page'), said('Looking at it.'),
  ...tool('toolu_1', 'npm test', 'FAIL login.spec'), said('The session cookie is dropped.'),
  line('user', handed('now the signup page')), said('Signup done.'),
]);
write(C, [line('user', 'a different chat about PAYMENTS'), said('ok')]);
// Copilot's session, as its history reader would replay it.
const copilot = { messages: [{ type: 'user', message: { content: [{ type: 'text', text: handed('carry on with the cookie') }] } }, { type: 'assistant', message: { content: [{ type: 'text', text: 'Cookie fixed by Copilot.' }] } }], total: 2 };
const readOne = async (session, provider) => {
  if (provider === 'copilot') return copilot;
  const t = await history.readSession(cwd, session, { whole: true });
  return { ...t, subagents: history.listSubagents(cwd, session) };
};
const segs = [{ provider: 'claude', session: A }, { provider: 'copilot', session: B, cut: 0 }, { provider: 'claude', session: A, cut: 0 }];

await check('an item has the same id read whole, read in a window, and read again after it grew', async () => {
  const whole = await readThread([{ provider: 'claude', session: A }], readOne);
  const ids = whole.items.map((it) => it.id);
  assert.ok(ids.includes('h0') && ids.includes('toolu_1'));
  // The window opens a long chat with only its end read in; its ids count from the start.
  const t = await history.readSession(cwd, A, { limit: 3 });
  const tail = replayStored(t, t.total - t.messages.length);
  for (const it of tail) assert.ok(ids.includes(it.id), `${it.id} from a window is the id read whole`);
  // A later turn appends; nothing earlier moves.
  fs.appendFileSync(path.join(dir, `${A}.jsonl`), `${said('One more thing.')}\n`);
  const grown = await readThread([{ provider: 'claude', session: A }], readOne);
  assert.deepEqual(grown.items.slice(0, whole.items.length).map((it) => it.id), ids);
});

await check('a switched chat is read the same way the window reads it, ids prefixed by session', async () => {
  const thread = await readThread(segs, readOne);
  const ids = thread.items.map((it) => it.id);
  assert.ok(ids.includes('h0') && ids.some((id) => id.startsWith('s1:')), ids.join(' '));
  const again = await readThread(segs, readOne);
  assert.deepEqual(again.items.map((it) => it.id), ids, 'read twice, the same ids');
  // The window's handoff reads every session but the one it is going to;
  // the same items have the same ids there.
  const before = await readThread(segs.slice(0, 2), readOne);
  for (const it of before.items) assert.ok(ids.includes(it.id), `${it.id} named by the handoff is found by the tool`);
});

await check('a handoff never comes back as an item, and carried rows say so', async () => {
  const thread = await readThread(segs, readOne);
  const all = entriesOf(thread.items);
  assert.ok(!all.some((e) => /conn-handoff/.test(e.text)), 'replay unwraps what a handoff carried');
  assert.ok(all.some((e) => e.body === 'now the signup page'), 'what was typed is the item');
  const carried = entriesOf([{ id: 'h0:c:u1', kind: 'user', text: 'from the parent', carried: true }]);
  assert.ok(/carried="yes"/.test(carried[0].text));
});

// Entries of a known size, for paging and the cap.
const big = Array.from({ length: 60 }, (_, i) => ({ id: `h${i}`, kind: i % 2 ? 'assistant' : 'user', text: `message ${i} ${'x'.repeat(400)}` }));
const bigEntries = entriesOf(big);

await check('paging back with next visits every item once, oldest first in each answer', () => {
  const seen = [];
  let args = { limit: 7 };
  for (let guard = 0; guard < 20; guard++) {
    const res = pick(bigEntries, args);
    const ids = res.entries.map((e) => e.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))), 'oldest first');
    seen.unshift(...ids);
    if (!res.next) break;
    args = res.next;
  }
  assert.deepEqual(seen, bigEntries.map((e) => e.id));
  assert.deepEqual(pick(bigEntries, { ids: ['h3', 'h1', 'nope'] }).entries.map((e) => e.id), ['h1', 'h3']);
  assert.deepEqual(pick(bigEntries, { ids: ['h3', 'nope'] }).missing, ['nope']);
  const around = pick(bigEntries, { around: 'h30', limit: 5 }).entries.map((e) => e.id);
  assert.deepEqual(around, ['h28', 'h29', 'h30', 'h31', 'h32']);
});

await check('an answer stays near the token cap, whole items only, and says how to go on', () => {
  const res = pick(bigEntries, { limit: 50 });
  const used = res.entries.reduce((n, e) => n + e.tokens, 0);
  assert.ok(used <= CAP, `${used} tokens`);
  assert.ok(res.entries.length < 50 || used <= CAP);
  const huge = entriesOf([{ id: 'h0', kind: 'user', text: 'y'.repeat(100000) }]);
  const one = pick(huge, { ids: ['h0'] });
  assert.equal(one.entries.length, 1);
  assert.ok(one.entries[0].text.length < CAP * 4 + 400, 'one item too big for an answer is cut, and says so');
  assert.ok(/too long for one answer/.test(one.entries[0].text));
  const text = answer({ ...pick(bigEntries, { limit: 3 }), total: bigEntries.length });
  assert.ok(text.startsWith(`3 of this chat's ${bigEntries.length} items`));
  assert.ok(new RegExp(`More: call ${NAME} with \\{"before":"h57"`).test(text));
  assert.equal(countOf(text), 3);
});

await check('search matches what was said, not what a tool printed, and pages too', async () => {
  const thread = await readThread([{ provider: 'claude', session: A }], readOne);
  const all = entriesOf(thread.items);
  assert.deepEqual(pick(all, { query: 'checkout' }).entries.map((e) => e.id), ['h0'], 'case does not matter');
  assert.deepEqual(pick(all, { query: 'login.spec' }).entries, [], 'tool output is not searched');
  const many = pick(bigEntries, { query: 'message', limit: 4 });
  assert.equal(many.entries.length, 4);
  assert.deepEqual(many.next.query, 'message');
});

await check('the tool reads only the chat it was started for', async () => {
  const chats = { one: { dir: cwd, segments: [{ provider: 'claude', session: A }] }, two: { dir: cwd, segments: [{ provider: 'claude', session: C }] } };
  const threadRead = createThreadReader({
    sessionsOf: async (chat) => { if (!chats[chat]) throw new Error(`No chat ${chat} in this window.`); return chats[chat]; },
    readSession: (d, session, p) => readOne(session, p),
    stampOf: () => null,
  });
  const mine = await threadRead('one', { query: 'checkout' });
  assert.ok(/id="h0"/.test(mine) && /CHECKOUT/.test(mine));
  const theirs = await threadRead('one', { query: 'payments' });
  assert.ok(theirs.startsWith('0 of'), 'another chat\'s words are not found');
  const ask = await threadRead('two', { ids: ['h0'] });
  assert.ok(/PAYMENTS/.test(ask) && !/CHECKOUT/.test(ask), 'the same id in another chat is that chat\'s item');
  await assert.rejects(threadRead(null, {}), /not started for a chat/);
  await assert.rejects(threadRead('ghost', {}), /No chat ghost/);
  const main = read('src/main/index.js');
  assert.ok(/if \(tool === THREAD_ROUTE\) \{\n\s+const result = await threadRead\(named, args\);/.test(main), 'the bridge reads the chat the server names, never the one on screen');
  assert.ok(/tool === THREAD_ROUTE\n\s+\? threadRead\(chat, args\)/.test(main), 'Claude\'s in-process call reads its own chat');
});

await check('the handoff names the tool only when the agent it goes to has it', async () => {
  const items = big;
  const named = buildHandoff({ items, from: 'claude', to: 'codex', window: 200000, cap: 2000, reader: NAME });
  assert.ok(named.omittedIds.length && new RegExp(`Read any of them with ${NAME}`).test(named.text));
  const plain = buildHandoff({ items, from: 'claude', to: 'codex', window: 200000, cap: 2000 });
  assert.ok(!/conn_thread_read/.test(plain.text));
  const all = buildHandoff({ items: items.slice(0, 2), from: 'claude', to: 'codex', window: 200000, reader: NAME });
  assert.ok(!/conn_thread_read/.test(all.text), 'nothing left out, nothing to read');
  const agent = read('src/renderer/ui/useAgent.js');
  assert.ok(/\?\.threadRead \? THREAD_TOOL : null/.test(agent), 'the window asks whether the CLI has the tool');
  assert.ok(/reader: thread \? reader : null/.test(agent), 'and names it only for ids read off disk');
  assert.ok(/threadRead: hasThreadRead\(row\)/.test(read('src/main/index.js')), 'main says, per CLI');
  assert.ok(/conn_thread_read\$\/\.test/.test(read('src/main/modes.js')), 'and it is never a permission card');
});

await check('Conn\'s MCP server offers the tool only to a server started for a chat', async () => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const list = async (env) => {
    const client = new Client({ name: 'thread-read-check', version: '0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'mcp/server.js')], env: { ...process.env, CONN_BRIDGE_URL: 'http://127.0.0.1:9', CONN_TOKEN: 'unused', ...env } }));
    const { tools } = await client.listTools();
    await client.close();
    return tools;
  };
  assert.ok(!(await list({})).some((t) => t.name === NAME));
  const withChat = await list({ CONN_CHAT: 'c1' });
  const t = withChat.find((x) => x.name === NAME);
  assert.ok(t, 'listed for a chat');
  assert.ok(t.description.length <= 140, `a short description: ${t.description.length} chars`);
});

await check('a handoff reads every message as stored, not the lighter window a chat is drawn from', async () => {
  // The window's read cuts a long text short; a handoff copies word for word.
  const long = 'z'.repeat(9000);
  // As the CLI stores a prompt: a list of blocks.
  write(C, [line('user', [{ type: 'text', text: long }]), said('ok')]);
  const drawn = await history.readSession(cwd, C, { limit: 10 });
  assert.ok(drawn.messages[0].message.content[0].text.length < 9000, 'drawing slims it');
  const stored = await history.readSession(cwd, C, { whole: true });
  assert.equal(stored.messages[0].message.content[0].text.length, 9000);
  const agent = read('src/renderer/ui/useAgent.js');
  assert.ok(/conn\(\)\.agent\.transcript\(session, chat\.project, \{ whole: true, provider \}\)/.test(agent), 'the handoff asks for the whole transcript');
  assert.ok(/whole === true \? \{ whole: true \} : \{ limit, end \}/.test(read('src/main/index.js')), 'and main reads it so');
  write(C, [line('user', 'a different chat about PAYMENTS'), said('ok')]);
});

fs.rmSync(home, { recursive: true, force: true });
console.log(failures.length ? `\n${failures.length} failed: ${failures.join(', ')}` : '\nthread-read-check: all passed');
process.exit(failures.length ? 1 : 0);
