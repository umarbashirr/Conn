/* A PreToolUse hook a person set on a browser tool sees that tool called
   alone, but the CLI only ever sees browser_batch, so a step inside a batch
   would slip past it. Checked on both ways Claude reaches a batch: its
   in-process handlers, and the conn MCP server when Claude Code is its
   client. An MCP server whose client is another agent, which never runs
   Claude's hooks, keeps its batches, even when CLAUDECODE leaked into its
   environment from a parent. Boots the app on the shop fixture. Needs a
   built renderer: `npx vite build`. */
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

const J = JSON.stringify;
const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? `: ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

const hook = (matcher) => ({ matcher, hooks: [{ type: 'command', command: 'echo blocked-by-hook >&2; exit 2' }] });
// The PreToolUse matchers the plugins on the machine this was written on
// install. None of them names a browser tool.
const ELSEWHERE = ['Write', 'Bash|PowerShell', 'Read|Write|Edit|MultiEdit|NotebookEdit|Grep'];
const WATCHED = /^(error: )?step 2 \(evaluate\): .*PreToolUse hook.*\. Call browser_evaluate on its own so your hook can see it\. Nothing ran\.$/;
// The fill would leave its value in the field, and the evaluate its mark on
// the page, had either run.
const STEPS = [{ tool: 'fill', target: '#coupon', value: 'HOOKED' }, { tool: 'evaluate', code: 'window.__batched = 2; 2' }];
const LEFT = { code: 'document.querySelector("#coupon").value + "|" + String(window.__batched)' };
const UNTOUCHED = '|undefined';
const RAN = 'HOOKED|2';

const s = await drive.boot({ root: ROOT, xvfb: true });
let server;
const clients = [];
try {
  server = spawn(process.execPath, ['server.mjs'], { cwd: s.project, stdio: ['ignore', 'pipe', 'inherit'] });
  const url = await new Promise((res, rej) => {
    server.stdout.on('data', (d) => { const m = /Local: (\S+)/.exec(String(d)); if (m) res(m[1]); });
    server.on('exit', () => rej(new Error('the shop server exited')));
  });
  await drive.invoke(s, 'navigate', { url });

  const inProcess = (body) => drive.evaluate(s, `(async () => {
    const a = globalThis.__agent;
    a.mode = 'auto';
    const hs = new Map(a.browserHandlers(req('zod').z).map((h) => [h.name, h]));
    const call = (name, args) => hs.get(name).handler(args, { _meta: { 'claudecode/toolUseId': 'h-' + Math.random() } });
    const text = (r) => ({ isError: !!r.isError, text: r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\\n') });
    ${body}
  })()`, { main: true, awaitPromise: true });

  // Claude Code introduces itself to an MCP server as claude-code; Codex and
  // the ACP agents by their own names.
  const connect = async (name, env) => {
    const mcp = new Client({ name, version: '0' });
    clients.push(mcp);
    await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'mcp/server.js')], cwd: s.project, env }));
    return async (tool, args) => {
      const r = await mcp.callTool({ name: tool, arguments: args });
      return { isError: !!r.isError, text: r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') };
    };
  };
  const base = { ...process.env, HOME: s.home, CONN_CWD: s.project };
  delete base.CLAUDECODE;
  const viaClaude = await connect('claude-code', base);
  const viaOther = await connect('p0-batch-hooks-repro', { ...base, CLAUDECODE: '1' });

  // Each run starts on a fresh page and ends by reading what the batch left.
  const bridged = (via) => async () => {
    await via('browser_navigate', { url });
    const out = await via('browser_batch', { actions: STEPS });
    return { ...out, left: (await via('browser_evaluate', LEFT)).text };
  };
  const runs = {
    'in-process': () => inProcess(`
      await call('browser_navigate', { url: ${J(url)} });
      const out = text(await call('browser_batch', { actions: ${J(STEPS)} }));
      return { ...out, left: text(await call('browser_evaluate', ${J(LEFT)})).text };
    `),
    'bridge-claude-code': bridged(viaClaude),
    'bridge-other-agent': bridged(viaOther),
  };
  const settings = path.join(s.project, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });

  for (const [name, run] of Object.entries(runs)) {
    const r = await run();
    check(`${name}-batch-runs-with-no-hooks`, !r.isError && r.left === RAN, J(r));
  }

  // Written after the session is up, so only a read when the batch is
  // planned can see it.
  fs.writeFileSync(settings, J({ hooks: { PreToolUse: [hook('mcp__preview__browser_evaluate'), hook('mcp__conn__browser_evaluate')] } }));
  for (const name of ['in-process', 'bridge-claude-code']) {
    const r = await runs[name]();
    check(`${name}-watched-step-refuses-the-batch`, r.isError && WATCHED.test(r.text), J(r));
    check(`${name}-watched-step-leaves-the-page`, r.left === UNTOUCHED, J(r));
  }
  {
    const r = await runs['bridge-other-agent']();
    check('bridge-other-agent-batch-runs-past-claude-hooks', !r.isError && r.left === RAN, J(r));
  }
  {
    const unwatched = [{ tool: 'fill', target: '#coupon', value: 'SAVE10' }, { tool: 'click', target: '#apply' }, { tool: 'text' }];
    const inside = await inProcess(`return text(await call('browser_batch', { actions: ${J(unwatched)} }));`);
    check('in-process-batch-without-watched-steps-runs', !inside.isError && /SAVE10 applied/.test(inside.text), J(inside));
    const bridged = await viaClaude('browser_batch', { actions: unwatched });
    check('bridge-claude-code-batch-without-watched-steps-runs', !bridged.isError && /SAVE10 applied/.test(bridged.text), J(bridged));
  }

  fs.writeFileSync(settings, J({ hooks: { PreToolUse: ELSEWHERE.map(hook) } }));
  for (const name of ['in-process', 'bridge-claude-code']) {
    const r = await runs[name]();
    check(`${name}-batch-runs-past-hooks-on-other-tools`, !r.isError && r.left === RAN, J(r));
  }
  fs.rmSync(settings);
} finally {
  for (const c of clients) await c.close().catch(() => {});
  server?.kill();
  await drive.stop(s);
}

if (failures.length) {
  console.log(`\n${failures.length} FAIL(s): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\np0-batch-hooks-repro: all passed');
process.exit(0);
