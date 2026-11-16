#!/usr/bin/env node
'use strict';
// MCP front end to the preview pane, so an agent in the terminal can see and
// drive the page instead of guessing at it. The tools are the shared table in
// src/shared/browser-tools.js; this file only carries them over stdio.
const fs = require('fs');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

const state = require('../cli/state');
const { browserTools, toolContent, planBatch, batchContent } = require('../src/shared/browser-tools');

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
async function call(tool, args = {}) {
  const { url, token } = connection();
  const headers = { 'content-type': 'application/json', 'x-conn-token': token, 'x-conn-cwd': callerCwd(), 'x-conn-report': '1' };
  // Which chat this server speaks for. The app sets it when it starts the
  // server for a chat; a server started from a shell has none, and the window
  // falls back to the chat on screen. Chat keys built from folder names are
  // not header-safe as they are.
  if (process.env.CONN_CHAT) headers['x-conn-chat'] = encodeURIComponent(process.env.CONN_CHAT);
  const res = await fetch(`${url}/tool/${tool}`, { method: 'POST', headers, body: JSON.stringify(args) });
  const body = await res.json().catch(() => ({ error: `bad response (${res.status})` }));
  if (!res.ok || body.error) throw new Error(body.error || `request failed (${res.status})`);
  return { result: body.result, caused: body.caused };
}

const server = new McpServer(
  { name: 'conn', version: '0.1.0' },
  { instructions: 'Controls the preview browser pane next to this terminal. browser_snapshot returns [ref=eN] handles that browser_click and browser_fill accept. Put steps you can plan ahead in one browser_batch call. Action results list the console errors and failed requests seen by the time they return; later ones show in browser_console and browser_network.' },
);

const wrap = (fn) => async (args) => {
  try { return await fn(args || {}); }
  catch (e) { return { content: [{ type: 'text', text: `error: ${e.message}` }], isError: true }; }
};

const table = browserTools(z);
for (const t of table) {
  server.registerTool(t.name, { title: t.title, description: t.description, inputSchema: t.schema }, wrap(async (a) => {
    // Checked here against each tool's schema, then run by the window one step
    // at a time, each under its own route and its own permission check.
    if (t.format === 'batch') {
      const steps = planBatch(a.actions, { table, z });
      const { result } = await call('batch', { actions: steps.map((st) => ({ tool: st.name, ...st.args })) });
      return batchContent(result, fs.readFileSync);
    }
    const { result, caused } = await call(t.route ? t.route(a) : t.bridgeTool, t.map ? t.map(a) : a);
    return toolContent(t, result, fs.readFileSync, { args: a, caused });
  }));
}

server.connect(new StdioServerTransport()).catch((e) => {
  process.stderr.write(`conn mcp: ${e.message}\n`);
  process.exit(1);
});
