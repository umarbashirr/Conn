#!/usr/bin/env node
'use strict';
// Stand-in for `codex`: `--version`, and an `app-server` that answers
// codex-driver.js's probe and runs a CodexSession turn. Each turn starts one
// command that never finishes, and `turn/interrupt` ends the turn.
const fs = require('fs');
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

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function onMessage(msg) {
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
  if (msg.method === 'turn/start') {
    send({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'mock-turn', status: 'inProgress' } } });
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
