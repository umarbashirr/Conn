#!/usr/bin/env node
'use strict';
// MCP front end to the preview pane, so an agent in the terminal can see and
// drive the page instead of guessing at it. The tools are the shared table in
// src/shared/browser-tools.js; this file only carries them over stdio.
const fs = require('fs');
const { execFileSync } = require('child_process');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

const state = require('../cli/state');
const { browserTools, toolContent, planBatch, batchContent } = require('../src/shared/browser-tools');
const threadTool = require('../src/shared/thread-tool');

/* The flags that hand the claude CLI permission rules, hooks, or the skills
   and agents that declare hooks, none of which is in a settings file the
   window reads. The CLI weighs a browser_batch call, never its steps, so the
   window is the only check on them, and it cannot see these. Claude Code
   started with one is offered no batch: each browser action is then a call
   of its own, which the CLI weighs itself. --tools is not one of them: it
   picks the built-in tools and leaves MCP tools alone. */
const OWN_RULES = ['--disallowedTools', '--disallowed-tools', '--settings', '--plugin-dir', '--plugin-dir-no-mcp', '--plugin-url',
  '--agents', '--add-dir', '--managed-settings', '--managed-settings-in-initialize', '--project-config-root'];

// The command line of the agent that started this server, word by word, or
// null when it cannot be read. On Windows Conn's node is a .cmd shim, so a
// cmd.exe stands between the two.
function parentArgs() {
  const pid = process.ppid;
  try {
    if (process.platform === 'linux') return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    const line = process.platform === 'win32'
      ? execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($p.Name -eq 'cmd.exe') { $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)" }; $p.CommandLine`], { encoding: 'utf8' })
      : execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' });
    return line.trim() ? line.trim().split(/\s+/).map((w) => w.replace(/^"/, '')) : null;
  } catch {
    return null;
  }
}
const parent = parentArgs();
if (!parent) process.stderr.write('conn mcp: the command line of the agent that started this server could not be read, so browser_batch is offered as usual\n');
const ownRules = (parent || []).some((a) => OWN_RULES.some((f) => a === f || a.startsWith(`${f}=`)));

// Which project the agent is working in. The window may have several open, so
// the request has to say. The terminal that started this server exports
// CONN_CWD, and that is a better answer than the shell's cwd, which drifts
// as the agent moves around the tree.
const callerCwd = () => process.env.CONN_CWD || process.cwd();

function connection() {
  if (process.env.CONN_BRIDGE_URL && process.env.CONN_TOKEN) {
    return { url: process.env.CONN_BRIDGE_URL, token: process.env.CONN_TOKEN };
  }
  const s = state.find(callerCwd());
  if (!s) throw new Error('no conn window open for this folder. Run `conn .` first.');
  return { url: s.url, token: s.token };
}

// Answers { result, caused }: the window adds what a page-changing call left
// in the console and the network, so the agent need not ask in a call of its own.
// `signal` is the MCP request's: cancelling it closes the connection, which
// the window takes as the caller giving up.
async function call(tool, args = {}, signal) {
  const { url, token } = connection();
  const headers = { 'content-type': 'application/json', 'x-conn-token': token, 'x-conn-cwd': callerCwd(), 'x-conn-report': '1' };
  // Which chat this server speaks for. The app sets it when it starts the
  // server for a chat; a server started from a shell has none, and the window
  // falls back to the chat on screen. Chat keys built from folder names are
  // not header-safe as they are.
  if (process.env.CONN_CHAT) headers['x-conn-chat'] = encodeURIComponent(process.env.CONN_CHAT);
  // The window holds a batch's steps to Claude Code's PreToolUse hooks when it
  // is the client.
  if (claudeCode()) headers['x-conn-claude-code'] = '1';
  const res = await fetch(`${url}/tool/${tool}`, { method: 'POST', headers, body: JSON.stringify(args), signal });
  const body = await res.json().catch(() => ({ error: `bad response (${res.status})` }));
  if (!res.ok || body.error) throw new Error(body.error || `request failed (${res.status})`);
  return { result: body.result, caused: body.caused };
}

// The instructions go out before the client gives its name, so they follow
// the command line alone and leave the batch out wherever it might be withheld.
const server = new McpServer(
  { name: 'conn', version: '0.1.0' },
  { instructions: [
    'Controls the preview browser pane next to this terminal.',
    'browser_snapshot returns [ref=eN] handles that browser_click and other actions take.',
    ...(ownRules ? [] : ['Put steps you can plan ahead in one browser_batch call; any browser tool is a step there, named bare.']),
    'Action results list console errors and failed requests seen by the time they return; later ones show in browser_console.',
  ].join(' ') },
);

// Claude Code says its name when it connects. CLAUDECODE in the environment
// would not do: it is inherited, so Codex started from a shell inside a Claude
// session has it too.
const claudeCode = () => server.server.getClientVersion()?.name === 'claude-code';

const wrap = (fn) => async (args, extra) => {
  try { return await fn(args || {}, extra?.signal); }
  catch (e) { return { content: [{ type: 'text', text: `error: ${e.message}` }], isError: true }; }
};

const table = browserTools(z);
let batch;
for (const t of table) {
  const tool = server.registerTool(t.name, { title: t.title, description: t.description, inputSchema: t.schema }, wrap(async (a, signal) => {
    // Checked here against each tool's schema, then run by the window one step
    // at a time, each under its own route and its own permission check.
    if (t.format === 'batch') {
      const steps = planBatch(a.actions, z);
      const { result } = await call('batch', { actions: steps.map((st) => ({ tool: st.name, ...st.args })) }, signal);
      return batchContent(result, fs.readFileSync);
    }
    const { result, caused } = await call(t.route ? t.route(a) : t.bridgeTool, t.map ? t.map(a) : a, signal);
    return toolContent(t, result, fs.readFileSync, { args: a, caused });
  }));
  if (t.format === 'batch') batch = tool;
}
// Reading the chat this server was started for. A server started from a shell
// belongs to no chat, so it is not offered there.
if (process.env.CONN_CHAT) {
  server.registerTool(threadTool.NAME, { description: threadTool.DESCRIPTION, inputSchema: threadTool.schema(z) }, wrap(async (a, signal) => {
    const { result } = await call('thread_read', a, signal);
    return { content: [{ type: 'text', text: String(result ?? '') }] };
  }));
}

// A client lists the tools only once it has said it is initialized, so the
// batch is gone before Claude Code looks.
server.server.oninitialized = () => {
  if (ownRules && claudeCode()) batch.remove();
};

server.connect(new StdioServerTransport()).catch((e) => {
  process.stderr.write(`conn mcp: ${e.message}\n`);
  process.exit(1);
});
