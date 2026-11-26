/* Which agents conn_thread_read really reaches, under plain node, on a
   throwaway HOME, with no real agent and no account.

   Each agent's session is started the way Conn starts it, with the conn MCP
   server and the chat key Conn hands it: Codex against mock-codex-cli.js
   behind a shim that records its launch arguments, every ACP agent against
   stub-acp-agent.mjs (its session/new, or Copilot's command line). From what
   the agent was actually given, the conn server is started over stdio with
   exactly that command and environment, its tool list is read, and
   conn_thread_read is called: through a real Bridge to a thread reader that
   answers only for the chat the server names. Claude's in-process tool is
   called through AgentSession the same way. An agent passes only if the item
   comes back; main names the tool in a handoff only for these. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-verify-thread-agents-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.SHELL = '/bin/false';
const NODE = process.execPath;
process.env.PATH = [path.dirname(NODE), '/usr/bin', '/bin'].join(path.delimiter);
for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_GITHUB_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CURSOR_API_KEY', 'XAI_API_KEY', 'ANTHROPIC_API_KEY']) delete process.env[k];

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const { z } = require('zod');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { Bridge } = require('../src/main/bridge.js');
const history = require('../src/main/history.js');
const { createThreadReader } = require('../src/main/thread-read.js');
const { NAME } = require('../src/shared/thread-tool.js');

const failures = [];
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`); } catch (e) { failures.push(name); console.log(`FAIL ${name}: ${e.message.split('\n')[0]}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 10000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await sleep(100); }
};

// The chat on disk: a Claude transcript whose third message says MARK-7.
const CHAT = 'c-thread-agents';
const SESSION = 'aaaaaaaa-1111-4000-8000-000000000001';
const cwd = path.join(home, 'work', 'shop');
fs.mkdirSync(cwd, { recursive: true });
const pdir = path.join(home, '.claude', 'projects', cwd.replace(/[/.]/g, '-'));
fs.mkdirSync(pdir, { recursive: true });
const line = (type, content) => JSON.stringify({ type, cwd, message: { role: type, content } });
fs.writeFileSync(path.join(pdir, `${SESSION}.jsonl`), [
  line('user', [{ type: 'text', text: 'first ask' }]), line('assistant', [{ type: 'text', text: 'ok' }]),
  line('user', [{ type: 'text', text: 'the one a handoff left out: MARK-7' }]), line('assistant', [{ type: 'text', text: 'noted' }]),
].join('\n'));
const asked = [];
const threadRead = createThreadReader({
  sessionsOf: async (chat) => {
    asked.push(chat);
    if (chat !== CHAT) throw new Error(`No chat ${chat} in this window.`);
    return { dir: cwd, segments: [{ provider: 'claude', session: SESSION }] };
  },
  readSession: (dir, session) => history.readSession(dir, session, { whole: true }),
  stampOf: () => null,
});
const bridge = new Bridge({
  cwds: [cwd],
  // As index.js's runBridgeTool answers it: the result alone, or { result }
  // when the MCP server asks for a report.
  run: async (tool, args, from, chat, opts) => {
    if (tool !== 'thread_read') throw new Error(`not under test: ${tool}`);
    const result = await threadRead(chat, args);
    return opts?.report ? { result } : result;
  },
});
await bridge.start();
// What previewMcp hands every agent: Conn's server, with the bridge's address.
const mcp = { name: 'conn', command: NODE, args: [path.join(ROOT, 'mcp/server.js')], env: { ...bridge.env(), CONN_CWD: cwd } };
const bridgeEnv = { ...bridge.env(), CONN_CHAT: CHAT };

// Start the conn server an agent was given, read its tools, and call the reader.
async function callAsGiven(server) {
  const client = new Client({ name: 'thread-read-agents-check', version: '0' });
  await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env: { PATH: process.env.PATH, HOME: home, ...server.env } }));
  try {
    const { tools } = await client.listTools();
    const listed = tools.some((t) => t.name === NAME);
    const res = listed ? await client.callTool({ name: NAME, arguments: { ids: ['h2'] } }) : null;
    return { listed, text: res?.content?.map((c) => c.text).join('') || '' };
  } finally {
    await client.close();
  }
}
const proved = (r) => r.listed && /id="h2"/.test(r.text) && /MARK-7/.test(r.text);
const shim = (name, target, extraEnv = '') => {
  const file = path.join(home, 'bin', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(path.join(home, `${name}.argv`))}\n${extraEnv}exec ${JSON.stringify(NODE)} ${JSON.stringify(target)} "$@"\n`, { mode: 0o755 });
  return file;
};
const argvOf = (name) => (fs.existsSync(path.join(home, `${name}.argv`)) ? fs.readFileSync(path.join(home, `${name}.argv`), 'utf8').split('\n').filter(Boolean) : []);
const results = {};

await check('Claude: the in-process tool reads the chat its session belongs to', async () => {
  const { AgentSession } = require('../src/main/agent.js');
  // index.js binds `chat` when it builds invoke; this stands in for that closure.
  const session = new AgentSession({ cwd, invoke: (tool, args, actor, opts) => (tool === 'thread_read' ? threadRead(CHAT, args).then((result) => (opts?.report ? { result } : result)) : null) });
  const handler = session.browserHandlers(z).find((h) => h.name === NAME);
  assert.ok(handler, 'listed among its tools');
  const res = await handler.handler({ ids: ['h2'] }, {});
  results.claude = { listed: true, text: res.content.map((c) => c.text).join('') };
  assert.ok(proved(results.claude), results.claude.text.slice(0, 200));
});

await check('Codex: the app-server is launched with the conn server and this chat, and that server reads it', async () => {
  const bin = shim('codex', path.join(ROOT, 'scripts/mock-codex-cli.js'));
  const { preferBinary } = require('../src/main/codex-driver.js');
  const row = require('../src/main/providers/codex.js').create({ cacheDir: path.join(home, 'cache') });
  // After create(), which applies the settings' binary, here none.
  preferBinary(bin);
  const session = row.createSession({ cwd, mode: 'ask', mcp, bridgeEnv, shared: [] });
  // The mock answers the handshake but does not run turns; only the launch is read.
  await session.start().catch((e) => { if (process.env.DEBUG) console.log('codex start:', e?.message || e); });
  const argv = await until(async () => { const a = argvOf('codex'); return a.length ? a : null; });
  session.stop?.();
  // -c mcp_servers.conn.command="...", .args=[...], .env.KEY="..."
  const conf = Object.fromEntries((argv || []).filter((a) => a.startsWith('mcp_servers.conn.')).map((a) => { const at = a.indexOf('='); return [a.slice('mcp_servers.conn.'.length, at), JSON.parse(a.slice(at + 1))]; }));
  assert.ok(conf.command && conf.args, `the conn server is in the launch: ${JSON.stringify(argv).slice(0, 300)}`);
  const env = Object.fromEntries(Object.entries(conf).filter(([k]) => k.startsWith('env.')).map(([k, v]) => [k.slice(4), v]));
  assert.equal(env.CONN_CHAT, CHAT, 'it names this chat');
  results.codex = await callAsGiven({ command: conf.command, args: conf.args, env });
  assert.ok(proved(results.codex), results.codex.text.slice(0, 200));
});

for (const id of ['copilot', 'cursor', 'opencode', 'grok']) {
  await check(`${id}: the agent is handed the conn server with this chat, and that server reads it`, async () => {
    const log = path.join(home, `${id}.jsonl`);
    const bin = shim(id, path.join(ROOT, 'scripts/stub-acp-agent.mjs'), `export STUB_ACP_NAME=${id} STUB_ACP_LOG=${JSON.stringify(log)}\n`);
    const row = require(`../src/main/providers/${id}.js`).create({ cacheDir: path.join(home, 'cache') });
    row.preferBinary(bin);
    const session = row.createSession({ cwd, mode: 'ask', mcp, bridgeEnv, shared: [] });
    await session.start().catch((e) => { throw new Error(`the session did not start: ${e?.message || e}`); });
    session.stop?.();
    let server = null;
    const argv = argvOf(id);
    const at = argv.indexOf('--additional-mcp-config');
    if (at >= 0) {
      const conn = JSON.parse(argv[at + 1]).mcpServers.conn;
      server = conn && { command: conn.command, args: conn.args, env: conn.env };
    } else {
      const opened = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(JSON.parse).find((r) => r.method === 'session/new' || r.method === 'session/load');
      const conn = (opened?.params?.mcpServers || []).find((x) => x.name === 'conn');
      server = conn && { command: conn.command, args: conn.args, env: Object.fromEntries((conn.env || []).map((e) => [e.name, e.value])) };
    }
    assert.ok(server, 'the conn server is among what the agent was given');
    assert.equal(server.env.CONN_CHAT, CHAT, 'it names this chat');
    results[id] = await callAsGiven(server);
    assert.ok(proved(results[id]), results[id].text.slice(0, 200));
  });
}

await check('the server reads only the chat it names, and main offers the tool to the agents proved here', () => {
  assert.ok(asked.length && asked.every((c) => c === CHAT), `every call named ${CHAT}: ${asked.join(', ')}`);
  const main = fs.readFileSync(path.join(ROOT, 'src/main/index.js'), 'utf8');
  assert.ok(/const hasThreadRead = \(row\) => row\.catalogKind === 'claude' \|\| \(!row\.noConnServer && fs\.existsSync\(mcpServerPath\(ROOT\)\)\);/.test(main));
  for (const id of ['claude', 'codex', 'copilot', 'cursor', 'opencode', 'grok']) assert.ok(results[id] && proved(results[id]), `${id} was proved`);
});

await bridge.stop?.();
fs.rmSync(home, { recursive: true, force: true });
console.log(failures.length ? `\n${failures.length} failed: ${failures.join(', ')}` : '\nthread-read-agents-check: all passed');
process.exit(failures.length ? 1 : 0);
