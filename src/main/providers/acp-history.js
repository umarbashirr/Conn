'use strict';
/* Session history for a CLI that speaks ACP: Cursor, Grok and OpenCode.
   One factory, one held process per provider.

   The same names and the same return shapes as history.js and codex-history.js,
   so index.js picks a module per provider and every handler behind it stays as
   it was.

   Nothing here reads a file. Each of these CLIs keeps its chats in a store of
   its own and serves them through session/list and session/load, which is also
   how a chat started in the CLI's own terminal reaches the rail. Loading a
   session replays it as session/update notifications before the call answers,
   and foldUpdates turns that replay into the messages the panel draws.

   The process is held open for the reason codex-history gives: the rail asks
   once per open project, and a cold start for each ask is the cost that adds
   up. IDLE_MS with nothing asked of it shuts the process down again. Answers
   are not cached.

   Slow starts are real. Grok's initialize can take over thirty seconds, and
   Cursor replays a long chat in about ten. The list gives up after LIST_MS so a
   slow CLI leaves its own chats off one refresh rather than holding up every
   other provider's, and the start it began carries on for the next one. */
const fs = require('fs');
const os = require('os');
const { AcpRpc } = require('./acp-rpc');
const { CLIENT, ACP_INSTRUCTIONS, toolOf, callInput, textOf } = require('./acp-session');
const shellEnv = require('../shell-env');
const { chatTitle } = require('../../shared/chat-title');
const { clip } = require('../transcript-clip');

const IDLE_MS = 5 * 60 * 1000;
const INIT_MS = 60000;
const CALL_MS = 20000;
const LIST_MS = 15000;
const LOAD_MS = 60000;
const MAX_PAGES = 20;

// --- replayed updates in, claude-shaped messages out ------------------------

const message = (role, content) => ({ type: role, message: { role, content } });

/* Consecutive chunks of one role are one message. A messageId says where one
   ends when the agent sends it; Cursor sends none, so there the role changing
   or a tool call is the only break. */
function chunk(s, role, u) {
  const c = u.content;
  // An attached image is not text, and textOf would print its bytes.
  const said = c && typeof c === 'object' && c.type && c.type !== 'text' ? '' : textOf(c);
  if (!said) return;
  const key = u.messageId ?? null;
  if (!(s.run && s.run.role === role && s.run.key === key)) {
    const block = { type: 'text', text: '' };
    s.out.push(message(role, [block]));
    s.run = { role, key, block };
  }
  s.run.block.text += said;
}

// The same decisions AcpSession#note makes while the chat runs, through the
// same functions, so a chat read back draws the rows it drew live.
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

/* Every kind not in this table is dropped, as the live path drops it: thoughts,
   plans, command lists and usage never reached the transcript while the chat
   ran, and showing them now would make a replayed chat say more than it did. */
const FOLD = new Map([
  ['user_message_chunk', (s, u) => chunk(s, 'user', u)],
  ['agent_message_chunk', (s, u) => chunk(s, 'assistant', u)],
  ['tool_call', toolStarted],
  ['tool_call_update', toolUpdated],
]);

function foldUpdates(updates) {
  const s = { out: [], run: null, tools: new Map() };
  for (const u of updates) FOLD.get(u?.sessionUpdate)?.(s, u);

  // AcpSession.send puts Conn's browser instructions ahead of a turn's text,
  // and the bubble the person saw held only what they typed. A resumed chat
  // sends them again on its first turn, so any user message may carry them.
  for (const m of s.out) {
    const b = m.message.content[0];
    if (m.type === 'user' && b.type === 'text' && b.text.startsWith(ACP_INSTRUCTIONS)) {
      b.text = b.text.slice(ACP_INSTRUCTIONS.length).trimStart();
    }
  }
  return s.out.filter((m) => {
    const b = m.message.content[0];
    return b.type !== 'text' || b.text.trim();
  });
}

// --- the held process --------------------------------------------------------

const within = (ms, promise) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('timed out')), ms);
  promise.then(resolve, reject).finally(() => clearTimeout(timer));
});

// A project opened through a symlink is recorded by whichever spelling started
// the chat, and an agent matches the cwd it is given exactly.
function spellings(cwd) {
  const paths = [cwd];
  try {
    const real = fs.realpathSync(cwd);
    if (real !== cwd) paths.push(real);
  } catch {}
  return paths;
}

// Ids are the CLI's own, and anything else arriving where one was meant is a
// chat key or a stray path.
const SESSION_ID = /^[A-Za-z0-9_-]{8,128}$/;

function rowOf(s) {
  if (!s?.sessionId) return null;
  const title = chatTitle(s.title);
  if (!title) return null;
  return { id: s.sessionId, title: title.slice(0, 120), at: Date.parse(s.updatedAt) || 0 };
}

function createAcpHistory({ spec, label }) {
  let live = null;     // { rpc, dead, ready } for the process, or null when nothing is asking
  let idleTimer = null;
  const collecting = new Map();  // session id -> the updates a load is hearing
  const reads = new Map();       // session id -> the read in flight

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
    // A history query must never be the reason a process stays up.
    idleTimer.unref?.();
  }

  /* The process runs in the home directory. session/list is told which cwd to
     filter on and session/load is given one, so the directory the process
     itself sits in never reaches an answer, and home keeps it out of any
     project the person has open. The entry is published before the process is
     up so that close() at quit can reach one that is still starting. */
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
        if (method === 'session/update' && params?.update) collecting.get(params.sessionId)?.push(params.update);
      });
      // Nobody is here to answer the agent, and a request left unanswered holds
      // the load that raised it.
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
      // No binary, no login, no answer: the rail draws an empty project the
      // same way it does for a claude project with no transcripts.
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

  // null when the CLI cannot be started.
  async function withServer(fn) {
    const first = await connect();
    if (!first) return null;
    keepAlive();
    try {
      return await fn(first);
    } catch (e) {
      if (!first.rpc.closed) throw e;
      // The process died between one question and the next, which is what an
      // upgrade under a running app looks like. Retry once on a fresh one
      // rather than making the first click after an upgrade the one that fails.
      const again = await connect();
      if (!again) return null;
      return fn(again);
    }
  }

  async function collect(cwd, limit) {
    const rows = await withServer(async ({ rpc }) => {
      const byId = new Map();
      for (const dir of spellings(cwd)) {
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

  // The rail groups by day and searches the lot, so the limit is high for the
  // same reason it is in history.js.
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
      collecting.set(id, updates);
      try {
        await rpc.request('session/load', { sessionId: id, cwd, mcpServers: [] }, LOAD_MS);
      } finally {
        collecting.delete(id);
      }
      // OpenCode keeps a loaded session in memory until it is told it can go.
      if (caps.sessionCapabilities?.close) await rpc.request('session/close', { sessionId: id }, CALL_MS).catch(() => {});
      return true;
    });
    if (!done) throw new Error(spec.missing || `could not start ${label} to read that chat`);
    return clip(id, foldUpdates(updates));
  }

  // Two clicks on one chat, or the rail and the panel, share one load.
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

  // Synchronous on purpose, as in codex-history: index.js folds it into a reply
  // it already awaited. These CLIs replay a chat as one flat conversation.
  const listSubagents = () => [];

  async function readSubagent() {
    throw new Error(`${label} chats have no subagent transcripts to open`);
  }

  return { listSessions, readSession, readSubagent, listSubagents, deleteSession, close };
}

module.exports = { createAcpHistory, foldUpdates };
