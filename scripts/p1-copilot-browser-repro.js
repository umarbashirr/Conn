#!/usr/bin/env node
'use strict';
// A Copilot chat gets Conn's browser tools. Copilot 1.0.114 drops every stdio
// MCP server an ACP client sends on session/new ("Rejecting non-http/sse MCP
// server" in ~/.copilot/logs), and the conn server is stdio. Runs the real
// copilot CLI against a stub server and passes when the CLI starts it and
// lists its tools. Sends no prompt, so it spends no quota. Then Copilot's
// permission requests, which name a browser tool by the title the server gave
// it (captured from copilot 1.0.114 in a Conn chat), are read as browser tools:
// a read is allowed without a card and a page change is left to the bridge.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = process.env.CONN_ROOT || path.join(__dirname, '..');
const shellEnv = require(path.join(ROOT, 'src/main/shell-env'));
shellEnv.ready = async () => process.env.PATH || '';
shellEnv.env = () => ({ ...process.env });

const copilot = require(path.join(ROOT, 'src/main/providers/copilot.js'));
const { toolOf, callInput } = require(path.join(ROOT, 'src/main/providers/acp-session.js'));
const { toolSummary } = require(path.join(ROOT, 'src/shared/tool-summary.js'));
const { decideCodex } = require(path.join(ROOT, 'src/main/modes.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-copilot-mcp-'));
const log = path.join(tmp, 'stub.log');
const stub = path.join(tmp, 'stub.js');
fs.writeFileSync(log, '');
fs.writeFileSync(stub, `
const fs = require('fs');
const note = (s) => fs.appendFileSync(${JSON.stringify(log)}, s + '\\n');
note('launched chat=' + process.env.CONN_CHAT);
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  for (let i; (i = buf.indexOf('\\n')) >= 0;) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    note(m.method);
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
    if (m.method === 'initialize') reply({ protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'conn', version: '1' } });
    else if (m.method === 'tools/list') reply({ tools: [{ name: 'browser_navigate', inputSchema: { type: 'object' } }] });
    else if (m.id != null) reply({});
  }
});
`);

function checkPermissionTitles() {
  const asked = (title) => ({ toolCallId: 'call_1', title, kind: 'other', status: 'pending', rawInput: {} });
  const read = toolOf(asked('Read page text'));
  const open = toolOf(asked('Open a URL'));
  const row = toolOf({ toolCallId: 'call_1', title: 'conn-browser_navigate', kind: 'other', rawInput: { url: 'http://localhost:3000' } });
  const ok = read === 'browser_text' && open === 'browser_navigate' && row === 'browser_navigate'
    && decideCodex('ask', read, {}).action === 'allow';
  console.log(`${ok ? 'PASS' : 'FAIL'} copilot-permission-titles-are-browser-tools${ok ? '' : `: ${JSON.stringify({ read, open, row })}`}`);
  if (!ok) process.exitCode = 1;
}

// A browser row reads "Read text", not "Read text conn-browser_text": the
// call's title is Copilot's name for the tool, not something it is doing.
function checkRowSummaries() {
  const calls = [
    { title: 'conn-browser_text', kind: 'other', rawInput: {} },
    { title: 'conn-browser_navigate', kind: 'other', rawInput: { url: 'http://localhost:3000' } },
  ];
  const shown = calls.map((u) => toolSummary(toolOf(u), callInput(u)));
  const ok = shown[0] === '' && shown[1] === 'localhost:3000';
  console.log(`${ok ? 'PASS' : 'FAIL'} copilot-browser-rows-hide-tool-name${ok ? '' : `: ${JSON.stringify(shown)}`}`);
  if (!ok) process.exitCode = 1;
}

async function main() {
  checkPermissionTitles();
  checkRowSummaries();
  const row = copilot.create({ cacheDir: tmp, settings: { get: () => ({}) } });
  if (!row.binary()) {
    console.log('SKIP no copilot CLI on PATH');
    return;
  }
  const session = row.createSession({
    cwd: tmp,
    mode: 'ask',
    mcp: { name: 'conn', command: process.execPath, args: [stub], env: {} },
    bridgeEnv: { CONN_CHAT: 'chat-1' },
    shared: [],
  });
  session.on('error', () => {});
  try {
    await session.start();
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !fs.readFileSync(log, 'utf8').includes('tools/list')) {
      await new Promise((r) => setTimeout(r, 250));
    }
  } finally {
    session.stop();
  }
  const seen = fs.readFileSync(log, 'utf8');
  const ok = seen.includes('launched chat=chat-1') && seen.includes('tools/list');
  console.log(`${ok ? 'PASS' : 'FAIL'} copilot-starts-conn-mcp${ok ? '' : `: stub log ${JSON.stringify(seen)}`}`);
  if (!ok) process.exitCode = 1;
}

main().catch((e) => { console.log(`FAIL ${e.stack || e}`); process.exitCode = 1; })
  .finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
