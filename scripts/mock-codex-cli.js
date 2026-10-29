#!/usr/bin/env node
'use strict';
// Stand-in for `codex`: `--version`, and an `app-server` that answers
// codex-driver.js's probe and runs a CodexSession turn. Each turn starts one
// command that never finishes, and `turn/interrupt` ends the turn.
const fs = require('fs');
// A turn changes four files (an add, a delete, a move and an update) and asks
// to apply the last one.
const EDITS = process.env.MOCK_CODEX_EDITS === '1';
// A turn reasons four ways: summary deltas over two paragraphs, a summary that
// arrives whole, no summary at all, and deltas cut short by a command. A prompt
// with "hang" reasons once and waits for turn/interrupt.
const REASON = process.env.MOCK_CODEX_REASON === '1';
const readline = require('readline');

// A probe spawns this twice, once per arm of #probe()'s Promise.all: once for
// --version, once for app-server. A counter file is the only way a test
// running in a different process can see how many times either one ran.
if (process.env.MOCK_CODEX_COUNT_FILE) {
  try { fs.appendFileSync(process.env.MOCK_CODEX_COUNT_FILE, 'x'); } catch {}
}

if (process.argv.includes('--version')) {
  process.stdout.write('mock-codex 0.0.1\n');
  process.exit(0);
}

// Wire shapes from codex 0.158.0; the mapping rules live in codexFiles.
const CHANGES = {
  'mock-add': [{ path: '/proj/notes.txt', kind: { type: 'add' }, diff: 'first line\nsecond line\n' }],
  'mock-delete': [{ path: '/proj/old.txt', kind: { type: 'delete' }, diff: 'goodbye\nworld\n' }],
  'mock-move': [{
    path: '/proj/src/a.js',
    kind: { type: 'update', move_path: '/proj/lib/a.js' },
    diff: "@@ -1,3 +1,3 @@\n const a = 1;\n-export default a;\n+module.exports = a;\n const b = 2;\n",
  }],
  'mock-update': [{
    path: '/proj/style.css',
    kind: { type: 'update', move_path: null },
    diff: '@@ -1,4 +1,4 @@\n button {\n-  color: blue;\n+  color: red;\n   margin: 0;\n }\n'
      + '@@ -20,3 +20,4 @@\n a {\n   color: green;\n+  text-decoration: none;\n }\n',
  }],
};
let approving = null;

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function editTurn() {
  for (const [id, changes] of Object.entries(CHANGES)) {
    const item = { type: 'fileChange', id, changes, status: 'inProgress' };
    notify('item/started', { threadId: 'mock-thread', turnId: 'mock-turn', item });
    if (id === 'mock-update') {
      approving = id;
      return send({
        jsonrpc: '2.0', id: 'mock-approval', method: 'item/fileChange/requestApproval',
        params: { threadId: 'mock-thread', turnId: 'mock-turn', itemId: id, startedAtMs: Date.now(), reason: null, grantRoot: null },
      });
    }
    notify('item/completed', { threadId: 'mock-thread', turnId: 'mock-turn', item: { ...item, status: 'completed' } });
  }
}

const TURN = { threadId: 'mock-thread', turnId: 'mock-turn' };
const reasoning = (id, summary = []) => ({ type: 'reasoning', id, summary, content: [] });
const R1 = reasoning('r1', ['Reading the file', 'Then edit']);
const M1 = { type: 'agentMessage', id: 'm1', text: 'Done editing.' };

function reasonTurn(hang) {
  const started = (item) => notify('item/started', { ...TURN, item });
  const completed = (item) => notify('item/completed', { ...TURN, item });
  const part = (itemId, summaryIndex) => notify('item/reasoning/summaryPartAdded', { ...TURN, itemId, summaryIndex });
  const said = (itemId, summaryIndex, delta) => notify('item/reasoning/summaryTextDelta', { ...TURN, itemId, summaryIndex, delta });
  if (hang) {
    started(reasoning('r4'));
    return said('r4', 0, 'Halfway');
  }
  started(reasoning('r1'));
  part('r1', 0);
  said('r1', 0, 'Reading ');
  notify('item/reasoning/textDelta', { ...TURN, itemId: 'r1', contentIndex: 0, delta: 'raw chain of thought' });
  said('r1', 0, 'the file');
  part('r1', 1);
  said('r1', 1, 'Then edit');
  completed(R1);
  started({ ...M1, text: '' });
  notify('item/agentMessage/delta', { ...TURN, itemId: 'm1', delta: 'Done ' });
  notify('item/agentMessage/delta', { ...TURN, itemId: 'm1', delta: 'editing.' });
  completed(M1);
  started(reasoning('r2'));
  completed(reasoning('r2', ['Whole']));
  started(reasoning('r3'));
  completed(reasoning('r3'));
  started(reasoning('r5'));
  said('r5', 0, 'Peek');
  const ls = { type: 'commandExecution', id: 'c1', command: 'ls', status: 'inProgress' };
  started(ls);
  completed({ ...ls, status: 'completed', exitCode: 0, aggregatedOutput: '' });
  completed(reasoning('r5', ['Peek']));
  notify('turn/completed', { threadId: 'mock-thread', turn: { id: 'mock-turn', status: 'completed' } });
}

function onMessage(msg) {
  if (approving && msg && msg.id === 'mock-approval' && !msg.method) {
    const item = { type: 'fileChange', id: approving, changes: CHANGES[approving], status: 'completed' };
    approving = null;
    notify('item/completed', { threadId: 'mock-thread', turnId: 'mock-turn', item });
    return notify('turn/completed', { threadId: 'mock-thread', turn: { id: 'mock-turn', status: 'completed' } });
  }
  if (!msg || typeof msg !== 'object' || msg.id === undefined || !msg.method) return;
  if (msg.method === 'initialize') {
    return send({ jsonrpc: '2.0', id: msg.id, result: { userAgent: 'mock-codex' } });
  }
  if (msg.method === 'model/list') {
    return send({
      jsonrpc: '2.0', id: msg.id,
      result: { data: [{ id: 'mock-codex-model', displayName: 'Mock Codex Model' }] },
    });
  }
  if (msg.method === 'thread/start') {
    return send({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 'mock-thread' }, model: 'mock-codex-model' } });
  }
  if (EDITS && msg.method === 'thread/list') {
    const row = { id: '019a0000-0000-7000-8000-000000000001', preview: 'edit the files', cwd: msg.params?.cwd?.[0], updatedAt: 1 };
    return send({ jsonrpc: '2.0', id: msg.id, result: { data: [row] } });
  }
  if (EDITS && msg.method === 'thread/read') {
    const items = Object.entries(CHANGES).map(([id, changes]) => ({ type: 'fileChange', id, changes, status: 'completed' }));
    return send({
      jsonrpc: '2.0', id: msg.id,
      result: { thread: { id: msg.params?.threadId, createdAt: 1, turns: [{ id: 'mock-turn', startedAt: 1, items }] } },
    });
  }
  if (REASON && msg.method === 'thread/list') {
    const row = { id: '019a0000-0000-7000-8000-000000000002', preview: 'think it through', cwd: msg.params?.cwd?.[0], updatedAt: 1 };
    return send({ jsonrpc: '2.0', id: msg.id, result: { data: [row] } });
  }
  if (REASON && msg.method === 'thread/read') {
    return send({
      jsonrpc: '2.0', id: msg.id,
      result: { thread: { id: msg.params?.threadId, createdAt: 1, turns: [{ id: 'mock-turn', startedAt: 1, items: [R1, M1] }] } },
    });
  }
  if (msg.method === 'turn/start') {
    send({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'mock-turn', status: 'inProgress' } } });
    if (/limit/i.test(JSON.stringify(msg.params?.input || ''))) {
      const error = { message: "You've hit your usage limit.", codexErrorInfo: 'usageLimitExceeded' };
      notify('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 100, resetsAt: Math.floor(Date.now() / 1000) + 600 } } });
      notify('error', { threadId: 'mock-thread', turnId: 'mock-turn', error, willRetry: false });
      return notify('turn/completed', { threadId: 'mock-thread', turn: { id: 'mock-turn', status: 'failed', error } });
    }
    if (EDITS) return editTurn();
    if (REASON) return reasonTurn(/hang/i.test(JSON.stringify(msg.params?.input || '')));
    return notify('item/started', {
      threadId: 'mock-thread',
      turnId: 'mock-turn',
      item: { type: 'commandExecution', id: 'mock-exec', command: 'sleep 600', status: 'inProgress' },
    });
  }
  // What codex 0.158.0 does: the turn ends at once, with no item/completed for
  // the command it cut short.
  if (msg.method === 'turn/interrupt') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return notify('turn/completed', { threadId: 'mock-thread', turn: { id: 'mock-turn', status: 'interrupted' } });
  }
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

function startLingeringFetch(pidsFile) {
  const fetch = require('child_process').spawn('sleep', ['600'], { stdio: 'ignore' });
  fs.appendFileSync(pidsFile, `${process.pid} ${fetch.pid}\n`);
}

if (process.argv.includes('app-server')) {
  if (process.env.MOCK_CODEX_PIDS_FILE) startLingeringFetch(process.env.MOCK_CODEX_PIDS_FILE);
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    try { onMessage(JSON.parse(line)); } catch {}
  });
  rl.on('close', () => process.exit(0));
} else {
  process.exit(1);
}
