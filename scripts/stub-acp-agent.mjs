#!/usr/bin/env node
/* A local stand-in for an ACP agent (Copilot, Cursor, OpenCode, Grok), so a
   test never reaches a real account. It speaks newline-delimited JSON-RPC on
   stdio, keeps its sessions in $HOME/.stub-acp/<name>.json so a chat can be
   listed, reopened and deleted, and answers each prompt with
   `acp heard: <last line>`. Every request is appended to STUB_ACP_LOG.

   STUB_ACP_NAME     which agent it plays (default: the name it was run as)
   STUB_ACP_INIT_MS  delay before answering initialize, to make a switch slow
   STUB_ACP_DELETE   1 to advertise session/delete; otherwise it refuses
   STUB_ACP_DELETE_GATE  a file: session/delete is advertised, and allowed only
                     while the file exists (an agent that starts to allow it)
   STUB_ACP_LOG      file to append { name, method, params } to */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

if (process.argv.includes('--version')) {
  process.stdout.write('stub-acp 0.0.1\n');
  process.exit(0);
}

const NAME = process.env.STUB_ACP_NAME || path.basename(process.argv[1] || 'stub');
const INIT_MS = Number(process.env.STUB_ACP_INIT_MS || 0);
const GATE = process.env.STUB_ACP_DELETE_GATE || '';
const DELETE = process.env.STUB_ACP_DELETE === '1' || !!GATE;
const LOG = process.env.STUB_ACP_LOG || '';
const STORE = path.join(os.homedir(), '.stub-acp', `${NAME}.json`);
const MODELS = [
  { modelId: 'auto', name: 'Auto' },
  // The same name Codex lists, to show a pick is told apart by its CLI.
  { modelId: 'gpt-6.2-sol', name: 'GPT-6.2 Sol' },
  { modelId: 'stub-two', name: 'Stub Two' },
];

const load = () => { try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch { return {}; } };
const save = (db) => { fs.mkdirSync(path.dirname(STORE), { recursive: true }); fs.writeFileSync(STORE, JSON.stringify(db)); };
const record = (method, params) => LOG && fs.appendFileSync(LOG, `${JSON.stringify({ at: Date.now(), name: NAME, method, params })}\n`);
const send = (o) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...o })}\n`);
const result = (id, r) => send({ id, result: r });
const fail = (id, message) => send({ id, error: { code: -32000, message } });
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let minted = 0;
const mint = () => `stub_${NAME}_${process.pid}_${Date.now()}_${++minted}`;
const sessionInfo = (id) => ({
  sessionId: id,
  models: { currentModelId: 'auto', availableModels: MODELS },
  modes: { currentModeId: 'ask', availableModes: [{ id: 'ask', name: 'ask' }, { id: 'bypass', name: 'bypass' }] },
});

async function handle({ id, method, params = {} }) {
  if (id === undefined || !method) return;
  record(method, method === 'session/prompt' ? { sessionId: params.sessionId, text: (params.prompt || []).map((b) => b?.text || '').join('\n') } : params);
  if (method === 'initialize') {
    if (INIT_MS) await sleep(INIT_MS);
    return result(id, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { list: {}, close: {}, ...(DELETE ? { delete: {} } : {}) },
        promptCapabilities: { image: true },
        mcpCapabilities: {},
      },
      agentInfo: { name: `stub-${NAME}`, title: `Stub ${NAME}`, version: '0.0.1' },
      authMethods: [],
    });
  }
  if (method === 'authenticate') return result(id, {});
  if (method === 'session/new') return result(id, sessionInfo(mint()));
  if (method === 'session/load') {
    const s = load()[params.sessionId];
    if (!s) return fail(id, 'session not found');
    for (const t of s.turns) {
      update(params.sessionId, { sessionUpdate: t.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk', content: { type: 'text', text: t.text } });
    }
    return result(id, sessionInfo(params.sessionId));
  }
  if (method === 'session/list') {
    const db = load();
    const sessions = Object.entries(db)
      .filter(([, s]) => s.cwd === params.cwd && s.turns.length)
      .map(([sessionId, s]) => ({ sessionId, cwd: s.cwd, title: s.turns[0].text.slice(0, 80), updatedAt: new Date(s.at).toISOString() }));
    return result(id, { sessions });
  }
  if (method === 'session/delete') {
    if (!DELETE) return fail(id, 'delete is not supported');
    if (GATE && !fs.existsSync(GATE)) return fail(id, 'this agent will not delete that chat yet');
    const db = load();
    delete db[params.sessionId];
    save(db);
    return result(id, {});
  }
  if (method === 'session/close' || method === 'session/set_model' || method === 'session/set_mode' || method === 'session/set_config_option') return result(id, {});
  if (method === 'session/prompt') {
    const text = (params.prompt || []).map((b) => (b?.type === 'text' ? b.text : '')).join('\n');
    const said = `acp heard: ${text.trim().split('\n').at(-1) || ''}`;
    const db = load();
    const s = db[params.sessionId] || (db[params.sessionId] = { cwd: params.cwd || process.cwd(), turns: [], at: 0 });
    s.turns.push({ role: 'user', text }, { role: 'agent', text: said });
    s.at = Date.now();
    save(db);
    update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: said } });
    return result(id, { stopReason: 'end_turn' });
  }
  return fail(id, `${method} is not supported by the stub`);
}

// session/new carries the cwd; session/prompt does not, so remember it.
const cwds = new Map();
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'session/new' || msg.method === 'session/load') cwds.set('last', msg.params?.cwd);
  if (msg.method === 'session/prompt') msg.params = { ...msg.params, cwd: msg.params?.cwd || cwds.get('last') };
  handle(msg).catch((e) => fail(msg.id, e.message));
});
