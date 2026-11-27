/* Issue #70 through the real Claude CLI, with a local stand-in model and
   a tiny MCP server. No account, browser window or model tokens are used.
   The server uses Conn's real hook reader and batch planner; tool bodies
   only record whether they ran. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { serve } from '../.claude/skills/verify/claude-api.mjs';

const require = createRequire(import.meta.url);
const ROOT = process.env.CONN_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const J = JSON.stringify;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-nested-cli-'));
const project = path.join(tmp, 'project');
const home = path.join(tmp, 'home');
const config = path.join(home, '.claude');
const evidence = path.join(tmp, 'evidence.jsonl');
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
let api;
try {
  write(path.join(project, 'packages/x/entry.txt'), 'Load the nested skills here.');
  write(path.join(tmp, 'hook.cjs'), `require('fs').appendFileSync(${J(evidence)}, JSON.stringify({hook:true})+'\\n'); process.exit(2);`);
  write(path.join(project, 'packages/x/.claude/skills/nested-guard/SKILL.md'), `---
name: nested-guard
description: Watches the browser for nested-hooks-cli-repro.
hooks:
  PreToolUse:
    - matcher: "mcp__conn__browser_evaluate"
      hooks:
        - type: command
          command: 'node ${J(path.join(tmp, 'hook.cjs'))}'
---
Call the tool you are asked to.
`);
  const server = path.join(tmp, 'mcp.cjs');
  write(server, `
const fs = require('fs');
const { z } = require(${J(require.resolve('zod'))});
const { McpServer } = require(${J(require.resolve('@modelcontextprotocol/sdk/server/mcp.js'))});
const { StdioServerTransport } = require(${J(require.resolve('@modelcontextprotocol/sdk/server/stdio.js'))});
const { hookWatch } = require(${J(path.join(ROOT, 'src/main/permission-rules.js'))});
const { browserTools, planBatch } = require(${J(path.join(ROOT, 'src/shared/browser-tools.js'))});
const record = (data) => fs.appendFileSync(${J(evidence)}, JSON.stringify(data)+'\\n');
const s = new McpServer({ name: 'conn', version: '0' });
for (const name of ['browser_evaluate', 'browser_batch']) {
  const tool = browserTools(z).find((t) => t.name === name);
  s.registerTool(name, { description: tool.description, inputSchema: tool.schema }, async (args) => {
    if (name === 'browser_batch') {
      const watch = hookWatch(${J(project)});
      try { planBatch(args.actions, z, (t) => watch('mcp__conn__' + t)); }
      catch (e) { record({refused:e.message}); return {isError:true, content:[{type:'text',text:e.message}]}; }
    }
    record({ran:name});
    return {content:[{type:'text',text:'ok'}]};
  });
}
s.connect(new StdioServerTransport());
`);
  write(path.join(config, 'settings.json'), '{}');
  const mcp = path.join(tmp, 'mcp.json');
  write(mcp, J({ mcpServers: { conn: { command: process.execPath, args: [server] } } }));
  api = await serve({ project });
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC)/.test(k)));
  Object.assign(env, { HOME: home, CLAUDE_CONFIG_DIR: config,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.port}`, ANTHROPIC_API_KEY: 'sk-ant-conn-verify',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
  const prompt = [
    'read packages/x/entry.txt',
    `tool Skill ${J({ skill: 'nested-guard' })}`,
    `tool mcp__conn__browser_evaluate ${J({ code: '1' })}`,
    `tool mcp__conn__browser_batch ${J({ actions: [{ tool: 'evaluate', code: '1' }] })}`,
    'say: ran',
  ].join('\n');
  const output = await new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', prompt, '--mcp-config', mcp, '--strict-mcp-config', '--dangerously-skip-permissions'], {
      cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Claude CLI exceeded 90 seconds')); }, 90000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', () => { clearTimeout(timer); resolve(out); });
  });
  assert.match(output, /^ran$/m, output);
  const events = fs.readFileSync(evidence, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(events.some((e) => e.hook), 'the real CLI ran the nested skill hook');
  assert.ok(!events.some((e) => e.ran), 'neither the single call nor any batch step ran');
  assert.ok(events.some((e) => /skill nested-guard.*Nothing ran\./.test(e.refused || '')), 'the batch refusal names the nested skill');
  console.log('PASS real CLI blocks the single call; Conn refuses the batch and names the nested skill');
} finally {
  api?.server.closeAllConnections();
  api?.server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
