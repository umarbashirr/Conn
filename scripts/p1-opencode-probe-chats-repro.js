#!/usr/bin/env node
'use strict';
// Conn's own probes leave no chats behind. The catalog probe opens a session in
// each open project to hear its commands, and the model probe opens one to read
// the model list. OpenCode 2.0.15 keeps every session it opens, so each probe
// put a "New session - <time>" chat in that project's rail. Runs the real
// opencode CLI on a scratch folder and passes when the folder lists no session.
// It also checks the rail of a folder an older Conn already left such a chat in,
// and that a real chat still named "New session - <time>" lists under its prompt.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = process.env.CONN_ROOT || path.join(__dirname, '..');
const shellEnv = require(path.join(ROOT, 'src/main/shell-env'));
shellEnv.ready = async () => process.env.PATH || '';
shellEnv.env = () => ({ ...process.env });

const opencode = require(path.join(ROOT, 'src/main/providers/opencode.js'));
const { AcpRpc } = require(path.join(ROOT, 'src/main/providers/acp-rpc.js'));
const { CLIENT } = require(path.join(ROOT, 'src/main/providers/acp-session.js'));
const { probeModels } = require(path.join(ROOT, 'src/main/providers/acp-driver.js'));
const { createAcpHistory } = require(path.join(ROOT, 'src/main/providers/acp-history.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-opencode-probe-'));
const project = path.join(tmp, 'project');
fs.mkdirSync(project);

let failed = false;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failed = true;
};

async function sessionsIn(bin, dir) {
  const rpc = new AcpRpc({ bin, argv: ['acp'], cwd: os.homedir() });
  try {
    await rpc.start();
    await rpc.request('initialize', { protocolVersion: 1, clientInfo: CLIENT, clientCapabilities: {} });
    const found = (await rpc.request('session/list', { cwd: dir }))?.sessions || [];
    // A leftover is reported, then removed, so a failing run does not add to
    // the person's own OpenCode history.
    for (const s of found) await rpc.request('session/delete', { sessionId: s.sessionId }).catch(() => {});
    return found;
  } finally {
    rpc.close();
  }
}

async function main() {
  const row = opencode.create({ cacheDir: tmp, settings: { get: () => ({}) } });
  const bin = row.binary();
  if (!bin) {
    console.log('SKIP no opencode CLI on PATH');
    return;
  }
  await row.catalog.refresh(project);
  const left = await sessionsIn(bin, project);
  check('catalog-probe-leaves-no-chat', left.length === 0, JSON.stringify(left.map((s) => s.title)));

  // The model probe makes and removes a scratch folder of its own; note its name.
  let scratch = null;
  const mkdtemp = fs.mkdtempSync;
  fs.mkdtempSync = (...a) => (scratch = mkdtemp(...a));
  try { await probeModels(bin, row.spec); } finally { fs.mkdtempSync = mkdtemp; }
  const leftover = scratch ? await sessionsIn(bin, scratch) : [];
  check('model-probe-leaves-no-session', scratch && leftover.length === 0, JSON.stringify({ scratch, leftover: leftover.map((s) => s.title) }));
}

// One session with nothing said, the way an older Conn's probe left it, and
// one whose only prompt was cancelled before OpenCode could title it.
async function leftovers(bin, dir) {
  const rpc = new AcpRpc({ bin, argv: ['acp'], cwd: dir });
  try {
    await rpc.start();
    await rpc.request('initialize', { protocolVersion: 1, clientInfo: CLIENT, clientCapabilities: {} });
    await rpc.request('session/new', { cwd: dir, mcpServers: [] });
    const { sessionId } = await rpc.request('session/new', { cwd: dir, mcpServers: [] });
    const turn = rpc.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'make the button red' }] }).catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
    rpc.notify('session/cancel', { sessionId });
    await turn;
  } finally {
    rpc.close();
  }
}

async function checkRail(row, bin) {
  const old = path.join(tmp, 'old');
  fs.mkdirSync(old);
  await leftovers(bin, old);
  const history = createAcpHistory({ spec: row.spec, label: 'OpenCode' });
  try {
    const titles = (await history.listSessions(old)).map((r) => r.title);
    check('rail-lists-real-chat-under-its-prompt', titles.length === 1 && titles[0] === 'make the button red', JSON.stringify(titles));
  } finally {
    history.close();
    await sessionsIn(bin, old);
  }
}

main().then(async () => {
  const row = opencode.create({ cacheDir: tmp, settings: { get: () => ({}) } });
  if (row.binary()) await checkRail(row, row.binary());
}).catch((e) => { console.log(`FAIL ${e.stack || e}`); failed = true; })
  .finally(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exitCode = failed ? 1 : 0;
  });
