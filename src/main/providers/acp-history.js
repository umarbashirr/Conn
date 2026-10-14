'use strict';
const fs = require('fs');
const os = require('os');
const { AcpRpc } = require('./acp-rpc');
const { CLIENT, ACP_INSTRUCTIONS, toolOf, callInput, textOf } = require('./acp-session');
const shellEnv = require('../shell-env');
const { chatTitle } = require('../../shared/chat-title');
const { clip } = require('../transcript-clip');

// Grok's initialize can take over thirty seconds and Cursor replays a long
// chat in about ten, so these sit well past the shared handshake.
const IDLE_MS = 5 * 60 * 1000;
const INIT_MS = 60000;
const CALL_MS = 20000;
const LIST_MS = 15000;
const LOAD_MS = 60000;
const MAX_PAGES = 20;

const message = (role, content) => ({ type: role, message: { role, content } });

const textOnly = (c) => (c && typeof c === 'object' && c.type && c.type !== 'text' ? '' : textOf(c));

function chunk(s, role, u) {
  const said = textOnly(u.content);
  if (!said) return;
  // OpenCode marks where a message ends with messageId. Cursor sends none, so
  // there a change of role or a tool call is the only break.
  const key = u.messageId ?? null;
  if (!(s.run && s.run.role === role && s.run.key === key)) {
    const block = { type: 'text', text: '' };
    s.out.push(message(role, [block]));
    s.run = { role, key, block };
  }
  s.run.block.text += said;
}

function toolStarted(s, u) {
  s.run = null;
  const block = { type: 'tool_use', id: u.toolCallId, name: toolOf(u), input: callInput(u) };
  s.tools.set(u.toolCallId, block);
  s.out.push(message('assistant', [block]));
}

function toolUpdated(s, u) {
  s.run = null;
  const block = s.tools.get(u.toolCallId);
  if (block) Object.assign(block.input, callInput(u));
  if (u.status !== 'completed' && u.status !== 'failed') return;
  const output = textOf(u.rawOutput) || textOf(u.content) || u.status;
  s.out.push(message('user', [{ type: 'tool_result', tool_use_id: u.toolCallId, content: output, is_error: u.status === 'failed' }]));
}

const FOLD = new Map([
  ['user_message_chunk', (s, u) => chunk(s, 'user', u)],
  ['agent_message_chunk', (s, u) => chunk(s, 'assistant', u)],
  ['tool_call', toolStarted],
  ['tool_call_update', toolUpdated],
]);

function foldUpdates(updates) {
  const s = { out: [], run: null, tools: new Map() };
  for (const u of updates) FOLD.get(u?.sessionUpdate)?.(s, u);

  for (const m of s.out) {
    const b = m.message.content[0];
    if (m.type === 'user' && b.type === 'text') b.text = withoutPreface(b.text);
  }
  return s.out.filter((m) => {
    const b = m.message.content[0];
    return b.type !== 'text' || b.text.trim();
  });
}

const withoutPreface = (text) => (text.startsWith(ACP_INSTRUCTIONS) ? text.slice(ACP_INSTRUCTIONS.length).trimStart() : text);

const within = (ms, promise) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('timed out')), ms);
  promise.then(resolve, reject).finally(() => clearTimeout(timer));
});

function cwdAndRealpath(cwd) {
  const paths = [cwd];
  try {
    const real = fs.realpathSync(cwd);
    if (real !== cwd) paths.push(real);
  } catch {}
  return paths;
}

const SESSION_ID = /^[A-Za-z0-9_-]{8,128}$/;

function rowOf(s) {
  if (!s?.sessionId) return null;
  const title = chatTitle(s.title);
  if (!title) return null;
  return { id: s.sessionId, title: title.slice(0, 120), at: Date.parse(s.updatedAt) || 0 };
}

function createAcpHistory({ spec, label }) {
  let live = null;
  let idleTimer = null;
  const updatesBySession = new Map();
  const reads = new Map();

  function close() {
    clearTimeout(idleTimer);
    idleTimer = null;
    const entry = live;
    live = null;
    if (!entry) return;
    entry.dead = true;
    entry.rpc?.close();
  }

  function keepAlive() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(close, IDLE_MS);
    idleTimer.unref?.();
  }

  function connect() {
    if (live && !live.rpc?.closed) return live.ready;
    const entry = { rpc: null, dead: false, ready: null };
    live = entry;
    entry.ready = (async () => {
      await shellEnv.ready();
      const bin = spec.binary();
      if (!bin || entry.dead) return null;
      const rpc = new AcpRpc({ bin, argv: spec.argv || ['acp'], cwd: os.homedir() });
      entry.rpc = rpc;
      rpc.on('closed', () => { if (live === entry) live = null; });
      rpc.on('notification', (method, params) => {
        if (method === 'session/update' && params?.update) updatesBySession.get(params.sessionId)?.push(params.update);
      });
      rpc.on('request', (method, _params, respond) => {
        if (method === 'session/request_permission') respond.result({ outcome: { outcome: 'cancelled' } });
        else respond.error({ code: -32601, message: `${method} is not available while reading history` });
      });
      await rpc.start();
      const init = await rpc.request('initialize', {
        protocolVersion: 1,
        clientInfo: CLIENT,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      }, INIT_MS);
      if (init?.authMethods?.length && spec.authenticate) {
        try { await spec.authenticate(rpc, init); } catch {}
      }
      keepAlive();
      return { rpc, caps: init?.agentCapabilities || {} };
    })()
      .catch(() => null)
      .then((conn) => {
        if (!conn) {
          entry.rpc?.close();
          if (live === entry) live = null;
        }
        return conn;
      });
    return entry.ready;
  }

  async function withServer(fn) {
    const first = await connect();
    if (!first) return null;
    keepAlive();
    try {
      return await fn(first);
    } catch (e) {
      if (!first.rpc.closed) throw e;
      const again = await connect();
      if (!again) return null;
      return fn(again);
    }
  }

  async function collect(cwd, limit) {
    const rows = await withServer(async ({ rpc }) => {
      const byId = new Map();
      for (const dir of cwdAndRealpath(cwd)) {
        let cursor = null;
        for (let page = 0; page < MAX_PAGES; page++) {
          const res = await rpc.request('session/list', { cwd: dir, ...(cursor && { cursor }) }, CALL_MS);
          for (const s of res?.sessions || []) {
            const row = rowOf(s);
            if (row) byId.set(row.id, row);
          }
          cursor = res?.nextCursor;
          if (!cursor || byId.size >= limit) break;
        }
      }
      return [...byId.values()];
    });
    return (rows || []).sort((a, b) => b.at - a.at).slice(0, limit);
  }

  async function listSessions(cwd, limit = 200) {
    try {
      return await within(LIST_MS, collect(cwd, limit));
    } catch {
      return [];
    }
  }

  async function load(cwd, id) {
    const updates = [];
    const done = await withServer(async ({ rpc, caps }) => {
      updates.length = 0;
      updatesBySession.set(id, updates);
      try {
        await rpc.request('session/load', { sessionId: id, cwd, mcpServers: [] }, LOAD_MS);
      } finally {
        updatesBySession.delete(id);
      }
      if (caps.sessionCapabilities?.close) await rpc.request('session/close', { sessionId: id }, CALL_MS).catch(() => {});
      return true;
    });
    if (!done) throw new Error(spec.missing || `could not start ${label} to read that chat`);
    return clip(id, foldUpdates(updates));
  }

  function readSession(cwd, id) {
    let read = reads.get(id);
    if (!read) {
      read = load(cwd, id).finally(() => reads.delete(id));
      reads.set(id, read);
    }
    return read;
  }

  async function deleteSession(cwd, id) {
    if (!SESSION_ID.test(String(id || ''))) throw new Error(`not a session id: ${id}`);
    const done = await withServer(async ({ rpc, caps }) => {
      if (!caps.sessionCapabilities?.delete) return false;
      await rpc.request('session/delete', { sessionId: id }, CALL_MS);
      return true;
    });
    if (done === null) throw new Error(`could not reach ${label} to delete that chat`);
    if (!done) throw new Error(`${label} cannot delete a chat from outside itself. Delete it from inside ${label}.`);
    return true;
  }

  const listSubagents = () => [];

  async function readSubagent() {
    throw new Error(`${label} chats have no subagent transcripts to open`);
  }

  return { listSessions, readSession, readSubagent, listSubagents, deleteSession, close };
}

module.exports = { createAcpHistory, foldUpdates };
