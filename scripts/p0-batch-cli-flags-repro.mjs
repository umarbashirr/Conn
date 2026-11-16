/* The claude CLI weighs a browser_batch call against its rules and hooks,
   never the steps inside it, and the window weighs the steps against the
   settings files it can read. Rules, hooks and the skills that carry them
   given to the CLI on its own command line are in no such file, so a step
   inside a batch would slip past them. The conn MCP server reads the command
   line of the agent that started it and offers Claude Code no batch when it
   carries one. Checked with a stand-in parent whose command line carries each
   such flag, and end to end with the claude on PATH against the stand-in
   Messages API in .claude/skills/verify. Claude Code started without them,
   and other agents, keep their batches. Boots the app on the shop fixture.
   Needs a built renderer: `npx vite build`. Linux only. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = process.env.CONN_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const drive = await import(pathToFileURL(path.join(ROOT, '.claude/skills/verify/drive.mjs')).href);
const { serve } = await import(pathToFileURL(path.join(ROOT, '.claude/skills/verify/claude-api.mjs')).href);

const J = JSON.stringify;
const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? `: ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

const SERVER = path.join(ROOT, 'mcp/server.js');
// Starts the server as its child and stands in for the agent, so the server's
// parent has the command line given after `--`.
const RELAY = `const c = require('child_process').spawn(process.execPath, [${J(SERVER)}], { stdio: 'inherit' });
process.on('SIGTERM', () => c.kill()); c.on('exit', (code) => process.exit(code ?? 1));`;
const EVALUATE = 'mcp__conn__browser_evaluate';
const FLAGS = [
  ['--disallowedTools', EVALUATE], ['--disallowed-tools', EVALUATE], [`--disallowedTools=${EVALUATE}`],
  ['--settings', J({ permissions: { deny: [EVALUATE] } })], ['--settings=/tmp/settings.json'],
  ['--plugin-dir', '/tmp/plugin'], ['--plugin-dir-no-mcp', '/tmp/plugin'], ['--plugin-url', 'https://example.invalid/p.zip'],
  ['--agents', J({ guard: { description: 'd', prompt: 'p' } })], ['--add-dir', '/tmp/more'],
  ['--managed-settings', '{}'], ['--managed-settings-in-initialize'], ['--project-config-root', '/tmp/root'],
];
// What Claude Code's command line holds besides, none of it a rule.
const PLAIN = ['-p', 'go', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions', '--mcp-config', '{}', '--tools', 'Bash'];

const s = await drive.boot({ root: ROOT, xvfb: true });
let shop;
const clients = [];
try {
  shop = spawn(process.execPath, ['server.mjs'], { cwd: s.project, stdio: ['ignore', 'pipe', 'inherit'] });
  const url = await new Promise((res, rej) => {
    shop.stdout.on('data', (d) => { const m = /Local: (\S+)/.exec(String(d)); if (m) res(m[1]); });
    shop.on('exit', () => rej(new Error('the shop server exited')));
  });
  await drive.invoke(s, 'navigate', { url });
  // The chat on screen judges each step the bridge runs. Auto lets them run
  // without a card, as a single call the CLI had already approved would be.
  await drive.evaluate(s, `globalThis.__agent.mode = 'auto'`, { main: true });

  const base ={ ...process.env, HOME: s.home, CONN_CWD: s.project };
  delete base.CLAUDECODE;
  const reader = new Client({ name: 'p0-batch-cli-flags-repro', version: '0' });
  clients.push(reader);
  await reader.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], cwd: s.project, env: base }));
  const page = async (code) => (await reader.callTool({ name: 'browser_evaluate', arguments: { code } })).content.map((b) => b.text).join('');
  const connect = async (name, args) => {
    const mcp = new Client({ name, version: '0' });
    clients.push(mcp);
    await mcp.connect(new StdioClientTransport({ command: process.execPath, args: ['-e', RELAY, '--', ...args], cwd: s.project, env: base }));
    const { tools } = await mcp.listTools();
    return { mcp, names: tools.map((t) => t.name), instructions: mcp.getInstructions() || '' };
  };
  const batchRuns = async (mcp, mark) => {
    const r = await mcp.callTool({ name: 'browser_batch', arguments: { actions: [{ tool: 'evaluate', code: `window.${mark} = 2; 2` }] } });
    return !r.isError && (await page(`'${mark}=' + window.${mark}`)).includes(`${mark}=2`);
  };

  for (const flag of FLAGS) {
    const { names, instructions } = await connect('claude-code', [...PLAIN, ...flag]);
    const label = flag[0].includes('=') ? `${flag[0].split('=')[0]}=` : flag[0];
    check(`claude-code-started-with-${label}-is-offered-no-batch`,
      !names.includes('browser_batch') && !instructions.includes('browser_batch') && names.includes('browser_evaluate'), J({ names: names.length, batch: names.includes('browser_batch'), instructions }));
  }
  {
    const { mcp, names, instructions } = await connect('claude-code', PLAIN);
    check('claude-code-started-without-them-is-offered-the-batch', names.includes('browser_batch') && instructions.includes('browser_batch'), J(names));
    check('claude-code-started-without-them-runs-a-batch', await batchRuns(mcp, '__plain'));
  }
  {
    const { mcp, names } = await connect('codex-mcp-client', [...PLAIN, '--add-dir', '/tmp/more', '--settings', '{}']);
    check('another-agent-is-offered-the-batch-whatever-its-flags', names.includes('browser_batch'), J(names));
    check('another-agent-runs-a-batch', await batchRuns(mcp, '__other'));
  }

  // The claude on PATH, started from a terminal in the project, the way a
  // person would, with Conn's MCP server.
  const claude = async (prompt, flags) => {
    const api = await serve({ project: s.project });
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC)/.test(k)));
    Object.assign(env, { HOME: s.home, ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.port}`, ANTHROPIC_API_KEY: 'sk-ant-conn-verify', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
    const config = J({ mcpServers: { conn: { command: process.execPath, args: [SERVER] } } });
    const out = await new Promise((done) => {
      const c = spawn('claude', ['-p', prompt, '--mcp-config', config, '--strict-mcp-config', '--permission-mode', 'bypassPermissions', '--output-format', 'stream-json', '--verbose', ...flags], { cwd: s.project, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let text = '';
      c.stdout.on('data', (d) => { text += d; });
      c.stderr.on('data', (d) => { text += d; });
      c.on('exit', () => done(text));
    });
    api.server.close();
    const results = out.split('\n').flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } })
      .flatMap((m) => (m.type === 'user' ? m.message.content : [])).filter((b) => b.type === 'tool_result')
      .map((b) => (typeof b.content === 'string' ? b.content : b.content.map((x) => x.text).join('')));
    return { said: /"result":"([^"]*)"/.exec(out)?.[1] ?? out.slice(-300), results };
  };
  {
    const r = await claude(`tool mcp__conn__browser_batch {"actions":[{"tool":"state"},{"tool":"evaluate","code":"window.__term_batched = 2; 2"}]} ;; tool ${EVALUATE} {"code":"window.__term_single = 1; 1"} ;; say: batch done`,
      ['--disallowedTools', EVALUATE]);
    const left = await page('`term_batched=${window.__term_batched ?? null} term_single=${window.__term_single ?? null}`');
    console.log(`  claude -p --disallowedTools ${EVALUATE}: page ${left}; tool results ${J(r.results)}`);
    check('terminal-claude-disallowing-evaluate-never-runs-it-in-a-batch', left.includes('term_batched=null'), left);
    check('terminal-claude-disallowing-evaluate-never-runs-it-alone', left.includes('term_single=null'), left);
    check('terminal-claude-disallowing-evaluate-has-no-batch-tool', /No such tool available: mcp__conn__browser_batch/.test(r.results[0] || ''), J(r.results[0]));
  }
  {
    const r = await claude('tool mcp__conn__browser_batch {"actions":[{"tool":"evaluate","code":"window.__term_plain = 3; 3"}]} ;; say: batch done', []);
    const left = await page('`term_plain=${window.__term_plain ?? null}`');
    console.log(`  claude -p with no such flag: page ${left}; tool results ${J(r.results)}`);
    check('terminal-claude-without-them-runs-a-batch', left.includes('term_plain=3'), J(r));
  }
} finally {
  for (const c of clients) await c.close().catch(() => {});
  shop?.kill();
  await drive.stop(s);
}

if (failures.length) {
  console.log(`\n${failures.length} FAIL(s): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\np0-batch-cli-flags-repro: all passed');
process.exit(0);
