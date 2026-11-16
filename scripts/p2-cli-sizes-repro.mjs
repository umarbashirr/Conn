/* The conn CLI prints a page the way it always has, whole up to its old
   limits, while the agents get the smaller defaults that keep a result cheap
   to read again on every turn. Both read the same kind of page: 240,000
   characters of text, 700 buttons, 60 console errors and 60 failed requests.

   CLI, old sizes: text 20,000 chars, html 200,000, snapshot 600 lines,
   console and network 50 rows. Agents, through the in-process Claude tools
   and through mcp/server.js: text 8,000, html 20,000, snapshot 400 lines,
   console and network 20 rows. Needs a built renderer: `npx vite build`. */
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const drive = await import(pathToFileURL(path.join(ROOT, '.claude/skills/verify/drive.mjs')).href);

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
};
const J = JSON.stringify;

const BUILD = `(async () => {
  document.body.insertAdjacentHTML('afterbegin', '<button>b</button>'.repeat(700));
  document.body.insertAdjacentHTML('beforeend', '<p>' + 'lorem ipsum '.repeat(20000) + '</p>');
  for (let i = 0; i < 60; i++) console.error('page error ' + i);
  await Promise.all(Array.from({ length: 60 }, (_, i) => fetch('http://127.0.0.1:1/gone-' + i).catch(() => {})));
  return 'built';
})()`;
const truncatedAt = (t) => Number(/truncated at (\d+) of \d+ characters/.exec(t)?.[1] || 0);
const lines = (t) => t.split('\n').filter((l) => l.startsWith('- ')).length;

const s = await drive.boot({ root: ROOT, xvfb: true });
let server;
let client;
try {
  server = spawn(process.execPath, ['server.mjs'], { cwd: s.project, stdio: ['ignore', 'pipe', 'inherit'] });
  const url = await new Promise((res, rej) => {
    server.stdout.on('data', (d) => { const m = /Local: (\S+)/.exec(String(d)); if (m) res(m[1]); });
    server.on('exit', () => rej(new Error('the shop server exited')));
  });
  await drive.invoke(s, 'state');
  // Auto, so the CLI's calls run without a card nobody is there to answer.
  await drive.evaluate(s, "globalThis.__agent.mode = 'auto'", { main: true });

  const env = { ...process.env, HOME: s.home };
  for (const k of ['CONN_BRIDGE_URL', 'CONN_TOKEN', 'CONN_CHAT', 'CONN_CWD']) delete env[k];
  const conn = (...args) => JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'cli/conn.js'), ...args, '--json'], { cwd: s.project, env, encoding: 'utf8', maxBuffer: 1 << 26 }));
  conn('go', url);
  conn('eval', BUILD);
  const cli = { text: conn('text'), html: conn('html'), snapshot: conn('snapshot'), console: conn('console'), network: conn('network') };
  console.log(`conn: text cut at ${truncatedAt(cli.text)}, html ${cli.html.length} chars, snapshot ${lines(cli.snapshot)} lines, console ${cli.console.length} rows, network ${cli.network.length} rows`);
  check('conn-text-keeps-20000', truncatedAt(cli.text) === 20000, truncatedAt(cli.text));
  check('conn-html-keeps-200000', truncatedAt(cli.html) === 200000, `${cli.html.length} chars, cut at ${truncatedAt(cli.html)}`);
  check('conn-snapshot-keeps-600-lines', lines(cli.snapshot) === 600, lines(cli.snapshot));
  check('conn-console-keeps-50-rows', cli.console.length === 50, cli.console.length);
  check('conn-network-keeps-50-rows', cli.network.length === 50, cli.network.length);

  const agent = await drive.evaluate(s, `(async () => {
    const a = globalThis.__agent;
    const hs = new Map(a.browserHandlers(req('zod').z).map((h) => [h.name, h]));
    const run = async (name, args = {}) => (await hs.get(name).handler(args, {})).content[0].text;
    await run('browser_tab_new', { url: ${J(url)} });
    await run('browser_evaluate', { code: ${J(BUILD)} });
    return { text: await run('browser_text'), html: await run('browser_html'), snapshot: await run('browser_snapshot'),
      console: await run('browser_console'), network: await run('browser_network') };
  })()`, { main: true, awaitPromise: true });
  const rows = (t) => t.split('\n').filter(Boolean).length;
  console.log(`claude tools: text cut at ${truncatedAt(agent.text)}, html cut at ${truncatedAt(agent.html)}, snapshot ${lines(agent.snapshot)} lines, console ${rows(agent.console)} rows, network ${rows(agent.network)} rows`);
  check('claude-text-8000', truncatedAt(agent.text) === 8000, truncatedAt(agent.text));
  check('claude-html-20000', truncatedAt(agent.html) === 20000, truncatedAt(agent.html));
  check('claude-snapshot-400-lines', lines(agent.snapshot) === 400, lines(agent.snapshot));
  check('claude-console-20-rows', rows(agent.console) === 20, rows(agent.console));
  check('claude-network-20-rows', rows(agent.network) === 20, rows(agent.network));

  client = new Client({ name: 'p2-cli-sizes-repro', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'mcp/server.js')], env: { ...env, CONN_CWD: s.project } }));
  const mcp = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content[0].text;
  const viaMcp = { text: await mcp('browser_text'), console: await mcp('browser_console') };
  console.log(`mcp tools: text cut at ${truncatedAt(viaMcp.text)}, console ${rows(viaMcp.console)} rows`);
  check('mcp-text-8000', truncatedAt(viaMcp.text) === 8000, truncatedAt(viaMcp.text));
  check('mcp-console-20-rows', rows(viaMcp.console) === 20, rows(viaMcp.console));
} finally {
  await client?.close().catch(() => {});
  server?.kill();
  await drive.stop(s);
}

if (failures.length) {
  console.log(`\n${failures.length} FAIL(s): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\np2-cli-sizes-repro: all passed');
process.exit(0);
