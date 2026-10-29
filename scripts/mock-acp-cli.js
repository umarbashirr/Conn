#!/usr/bin/env node
'use strict';
// Stand-in ACP agent for tests. Speaks newline-delimited JSON-RPC on stdio.
const readline = require('readline');

if (process.argv.includes('--version')) {
  process.stdout.write('mock-acp 0.0.1\n');
  process.exit(0);
}

const AUTH = process.env.MOCK_ACP_AUTH === '1';
const ASK = process.env.MOCK_ACP_ASK === '1';
// Answer the way OpenCode does: model and mode as session config options.
const CONFIG = process.env.MOCK_ACP_CONFIG === '1';
const REJECT_MODEL = process.env.MOCK_ACP_REJECT_MODEL === '1';
// A file to append each session start and prompt to, so a test can read what
// the app handed the agent.
const LOG = process.env.MOCK_ACP_LOG || '';
const record = (entry) => LOG && require('fs').appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
// A prompt edits two files, one new, behind a permission request, the way an
// agent that sends diff content does.
const RICH = process.env.MOCK_ACP_RICH === '1';
// A prompt plays back what a real agent sent for one turn, from a capture in
// scripts/fixtures/acp-real, stopping at its permission request until answered.
const REPLAY = process.env.MOCK_ACP_REPLAY || '';
// A prompt alternates thought and message chunks around a tool call. A prompt
// with "hang" thinks once and waits for session/cancel.
const THINK = process.env.MOCK_ACP_THINK === '1';
const STORE = process.env.MOCK_ACP_STORE || '';
const DELETE = process.env.MOCK_ACP_DELETE === '1';
const PIDS = process.env.MOCK_ACP_PIDS || '';
const trace = (what) => PIDS && require('fs').appendFileSync(PIDS, `${what} ${process.pid}\n`);
trace('start');
const stored = STORE ? [
  { sessionId: `${STORE}-chat-0001`, title: 'Make the button red', updatedAt: '2026-03-02T10:00:00.000Z' },
  { sessionId: `${STORE}-chat-0002`, title: 'Older chat on page two', updatedAt: '2026-03-01T09:30:00.000Z' },
] : [];
const chosen = { model: 'mock-1', mode: 'build' };
let seq = 0;
// A session id the app can file things under: unique to this process, and long
// enough to pass for a real agent's.
let minted = 0;
const mint = () => `mock-${process.pid}-${++minted}`;
let promptId = null;
let cancelled = false;
let cwd = process.cwd();
let rich = null;

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value ?? null });
}

function fail(id, message, code = -32000) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function chunk(sessionId, text) {
  notify('session/update', {
    sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
    },
  });
}

function thought(sessionId, text) {
  notify('session/update', {
    sessionId,
    update: {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text },
    },
  });
}

function thinkTurn(id, sessionId, text) {
  thought(sessionId, '');
  thought(sessionId, 'Looking ');
  if (/\bhang\b/i.test(text)) return;
  thought(sessionId, 'around');
  chunk(sessionId, 'Found it.');
  thought(sessionId, 'Now run it');
  tool(sessionId, 't1', 'echo', 'execute', { command: 'echo hi' });
  toolDone(sessionId, 't1', 'hi\n', false);
  thought(sessionId, 'It worked');
  chunk(sessionId, 'Done.');
  result(id, { stopReason: 'end_turn' });
  promptId = null;
}

function tool(sessionId, id, title, kind, input) {
  notify('session/update', {
    sessionId,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: id,
      title,
      kind,
      status: 'pending',
      rawInput: input,
    },
  });
}

function toolDone(sessionId, id, output, failed) {
  notify('session/update', {
    sessionId,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: id,
      status: failed ? 'failed' : 'completed',
      rawOutput: output,
      content: [{ type: 'content', content: { type: 'text', text: output } }],
    },
  });
}

const PERM_OPTIONS = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'always', name: 'Always', kind: 'allow_always' },
  { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
];

let replay = null;

function replayStep() {
  while (replay.at < replay.frames.length) {
    const [kind, frame] = replay.frames[replay.at++];
    if (kind === 'raw') {
      notify('session/update', { sessionId: replay.sessionId, update: frame });
      continue;
    }
    replay.permId = `perm-${++seq}`;
    send({
      jsonrpc: '2.0',
      id: replay.permId,
      method: 'session/request_permission',
      params: { ...frame, sessionId: replay.sessionId, options: PERM_OPTIONS },
    });
    return;
  }
  chunk(replay.sessionId, 'replayed');
  result(promptId, { stopReason: 'end_turn' });
  promptId = null;
  replay = null;
}

function richEdit(sessionId, id) {
  const diffs = [
    { type: 'diff', path: `${cwd}/style.css`, oldText: 'button {\n  color: blue;\n  margin: 0;\n}\n', newText: 'button {\n  color: red;\n  margin: 0;\n}\n' },
    { type: 'diff', path: `${cwd}/notes.txt`, oldText: null, newText: 'first line\nsecond line\n' },
  ];
  notify('session/update', {
    sessionId,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 't-rich',
      title: 'Edit style.css, notes.txt',
      kind: 'edit',
      status: 'pending',
      content: diffs,
      locations: [{ path: `${cwd}/style.css` }, { path: `${cwd}/notes.txt` }],
    },
  });
  rich = { permId: `perm-${++seq}`, sessionId, diffs };
  send({
    jsonrpc: '2.0',
    id: rich.permId,
    method: 'session/request_permission',
    params: {
      sessionId,
      toolCall: { toolCallId: 't-rich', title: 'Edit style.css, notes.txt', kind: 'edit', content: diffs },
      options: PERM_OPTIONS,
    },
  });
  promptId = id;
}

function richDone({ sessionId, diffs }) {
  notify('session/update', {
    sessionId,
    update: { sessionUpdate: 'tool_call_update', toolCallId: 't-rich', status: 'completed', content: diffs },
  });
  rich = null;
  if (promptId == null) return;
  chunk(sessionId, 'edited both files');
  result(promptId, { stopReason: 'end_turn' });
  promptId = null;
}

function replayStored(sessionId) {
  const { ACP_INSTRUCTIONS } = require('../src/main/providers/acp-session');
  const said = `${ACP_INSTRUCTIONS}\n\nmake the button red`;
  const at = 40;
  const update = (u) => notify('session/update', { sessionId, update: u });
  const text = (sessionUpdate, t) => update({ sessionUpdate, content: { type: 'text', text: t } });
  update({ sessionUpdate: 'available_commands_update', availableCommands: [] });
  text('user_message_chunk', said.slice(0, at));
  text('user_message_chunk', said.slice(at));
  text('agent_thought_chunk', 'the css lives in style.css');
  text('agent_message_chunk', 'Sure, ');
  text('agent_message_chunk', 'I will ');
  text('agent_message_chunk', 'change it.');
  update({
    sessionUpdate: 'tool_call', toolCallId: 'replay-0-1', title: 'Edit style.css', kind: 'edit', status: 'pending', rawInput: {},
  });
  update({
    sessionUpdate: 'tool_call_update', toolCallId: 'replay-0-1', status: 'completed', rawInput: { path: 'style.css' }, rawOutput: 'edited style.css',
  });
  update({ sessionUpdate: 'usage_update', used: 10, size: 100 });
  text('agent_message_chunk', 'Done.');
  text('user_message_chunk', 'thanks');
}

async function handlePrompt(id, params) {
  promptId = id;
  cancelled = false;
  const { sessionId } = params;
  const text = (params.prompt || [])
    .map((b) => (b && b.type === 'text' ? b.text : ''))
    .join('\n');
  record({ method: 'session/prompt', text });

  if (ASK) {
    send({
      jsonrpc: '2.0',
      id: `perm-${++seq}`,
      method: 'session/request_permission',
      params: {
        sessionId,
        toolCall: { toolCallId: 't-ask', title: 'echo', kind: 'execute', rawInput: { command: 'echo hi' } },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'always', name: 'Always', kind: 'allow_always' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        ],
      },
    });
  }

  if (/\bauth\b/i.test(text)) return fail(id, 'Authentication required', -32000);

  if (RICH) return richEdit(sessionId, id);
  if (REPLAY) {
    promptId = id;
    replay = { frames: JSON.parse(require('fs').readFileSync(REPLAY, 'utf8')).frames, at: 0, sessionId, permId: null };
    return replayStep();
  }
  if (THINK) return thinkTurn(id, sessionId, text);

  if (/\bhang\b/i.test(text)) {
    tool(sessionId, 't-hang', 'sleep', 'execute', { command: 'sleep 600' });
    return;
  }

  if (/tool/i.test(text)) {
    tool(sessionId, 't1', 'echo', 'execute', { command: 'echo hi' });
    toolDone(sessionId, 't1', 'hi\n', false);
  }

  if (CONFIG) chunk(sessionId, `model=${chosen.model} mode=${chosen.mode}`);
  else {
    chunk(sessionId, 'hello ');
    chunk(sessionId, 'from mock');
  }
  if (cancelled) {
    result(id, { stopReason: 'cancelled' });
  } else {
    result(id, { stopReason: 'end_turn' });
  }
  promptId = null;
}

function onMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  const { id, method, params } = msg;

  if (method === 'session/cancel') {
    cancelled = true;
    if (promptId != null) {
      result(promptId, { stopReason: 'cancelled' });
      promptId = null;
    }
    return;
  }

  if (rich && id === rich.permId && !method) return richDone(rich);
  if (replay && id === replay.permId && !method) return replayStep();
  if (id === undefined || !method) return;

  if (method === 'initialize') {
    return result(id, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        ...(STORE ? { sessionCapabilities: { list: {}, ...(DELETE ? { close: {}, delete: {} } : {}) } } : {}),
        promptCapabilities: { image: true },
        mcpCapabilities: {},
      },
      agentInfo: { name: 'mock-acp', title: 'Mock ACP', version: '0.0.1' },
      authMethods: AUTH ? [{ id: 'login', name: 'Log in', description: 'mock login' }] : [],
    });
  }

  if (method === 'authenticate') {
    return AUTH ? fail(id, 'not logged in') : result(id, {});
  }

  if (STORE && method === 'session/list') {
    if (!params?.cwd) return fail(id, 'cwd is required');
    trace('list');
    const page = params.cursor ? 1 : 0;
    const row = stored[page];
    return result(id, {
      sessions: row ? [{ ...row, cwd: params.cwd }] : [],
      ...(page === 0 && stored.length > 1 ? { nextCursor: 'page-2' } : {}),
    });
  }

  if (STORE && DELETE && method === 'session/delete') {
    record({ method, sessionId: params?.sessionId });
    const at = stored.findIndex((s) => s.sessionId === params?.sessionId);
    if (at >= 0) stored.splice(at, 1);
    return result(id, {});
  }

  if (STORE && method === 'session/close') record({ method, sessionId: params?.sessionId });

  if (STORE && method === 'session/load') {
    if (!stored.some((s) => s.sessionId === params?.sessionId)) return fail(id, 'session not found');
    replayStored(params.sessionId);
  }

  if (method === 'session/new' || method === 'session/load') {
    if (AUTH) return fail(id, 'not authenticated; run login');
    const servers = params?.mcpServers || [];
    if (params?.cwd) cwd = params.cwd;
    record({ method, cwd: params?.cwd, mcpServers: servers });
    if (CONFIG) {
      return result(id, {
        sessionId: params?.sessionId || mint(),
        configOptions: [
          { id: 'model', category: 'model', type: 'select', currentValue: chosen.model, options: [
            { value: 'mock-1', name: 'Zen/Mock One' },
            { value: 'mock-2', name: 'Zen/Mock Two' },
          ] },
          { id: 'mode', category: 'mode', type: 'select', currentValue: chosen.mode, options: [
            { value: 'build', name: 'build' },
            { value: 'plan', name: 'plan' },
          ] },
        ],
      });
    }
    return result(id, {
      sessionId: params?.sessionId || mint(),
      mcpServers: servers.map((s) => s.name),
      models: {
        currentModelId: params?._meta?.model || 'mock-1',
        availableModels: [
          { modelId: 'mock-1', name: 'Mock One' },
          { modelId: 'mock-2', name: 'Mock Two' },
        ],
      },
      modes: {
        currentModeId: 'ask',
        availableModes: [
          { id: 'ask', name: 'Ask' },
          { id: 'plan', name: 'Plan' },
          { id: 'bypass', name: 'Bypass' },
        ],
      },
    });
  }

  if (method === 'session/prompt') return handlePrompt(id, params || {});
  if (method === 'session/set_config_option') {
    chosen[params.configId] = params.value;
    return result(id, {});
  }
  if (CONFIG && /^session\/set_(model|mode)$/.test(method)) return fail(id, `${method} is not how this agent is configured`);
  if (method === 'session/set_model') {
    if (REJECT_MODEL) return fail(id, 'unknown model');
    chosen.model = params?.modelId || chosen.model;
    return result(id, {});
  }
  if (method === 'session/set_mode') return result(id, {});
  if (method === 'session/close') return result(id, {});

  fail(id, `unknown method ${method}`, -32601);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  try { onMessage(msg); } catch (e) {
    if (msg.id !== undefined) fail(msg.id, e.message);
  }
});
rl.on('close', () => {
  if (process.env.MOCK_ACP_LINGER === '1') setInterval(() => {}, 1 << 30);
  else process.exit(0);
});
