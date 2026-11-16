/* What Conn's browser tools cost the model, measured rather than guessed, and
   checked against what they cost before browser_batch and the small
   screenshots (4ec715b). No model and no network beyond localhost.

   - Always-on: the definitions sent with every Claude request (name,
     description and JSON schema of each always-loaded tool), the instructions
     appended to the system prompt, and the whole tool list the conn MCP server
     gives other agents.
   - A fixed scenario on the shop fixture through the agent's real tool
     handlers: open the page, read it, fill SAVE10, click Apply, wait for
     #message.ok, read the text, screenshot. Once as seven single calls, once
     as one batch. The batch's saving is model calls, each a turn that reads
     the whole conversation again; its text is the single calls' own plus a
     number per step, so it is set against today's single calls as well as
     against the calls before this branch.
   - A screenshot at the median pane size seen in real transcripts, 1280x929.
   - What the prose names: the instructions, the MCP server's own and the
     $browser mention may name a tool as browser_<name> only when it is
     always loaded. Naming one that loads on demand steers Claude to a
     ToolSearch round trip before the call; the rest are named bare, as
     browser_batch steps, which run any tool without loading it.

   Images are counted as the model reads them: w*h/750 tokens after fitting
   the long side to 1568. Needs a built renderer: `npx vite build`. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = process.env.CONN_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const { z } = require('zod');
const { browserTools, INSTRUCTIONS, ALWAYS_LOADED } = require(path.join(ROOT, 'src/shared/browser-tools.js'));
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

// Measured at 4ec715b with the same method, so the comparison is like for like.
const BEFORE = {
  alwaysLoaded: 3104,      // the ten always-loaded tools, $schema key included
  instructions: 1065,
  mcpList: 9745,           // tools/list from mcp/server.js, 28 tools
  scenarioCalls: 7,
  scenarioChars: 741,
  medianShotTokens: 1585,  // 1280x929 PNG
};

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures.push(name);
};
const J = JSON.stringify;
const fit = (w, h) => { const k = Math.min(1, 1568 / Math.max(w, h)); return [Math.round(w * k), Math.round(h * k)]; };
const tokens = ({ width, height }) => { const [a, b] = fit(width, height); return Math.round((a * b) / 750); };

// --- always-on ---------------------------------------------------------------

const defSize = (t) => {
  const schema = z.toJSONSchema(z.object(t.schema));
  return t.name.length + t.description.length + J(schema).length;
};
const table = browserTools(z);
const always = table.filter((t) => ALWAYS_LOADED.has(t.name)).reduce((n, t) => n + defSize(t), 0);
console.log(`always-loaded definitions: ${ALWAYS_LOADED.size} tools, ${always} chars (before ${BEFORE.alwaysLoaded})`);
console.log(`appended instructions: ${INSTRUCTIONS.length} chars (before ${BEFORE.instructions})`);
check('always-loaded-no-larger', always <= BEFORE.alwaysLoaded);
check('instructions-no-longer', INSTRUCTIONS.length <= BEFORE.instructions);

const client = new Client({ name: 'browser-cost-check', version: '0' });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(ROOT, 'mcp/server.js')],
  // Listing needs no window; nothing here is ever called.
  env: { ...process.env, CONN_BRIDGE_URL: 'http://127.0.0.1:9', CONN_TOKEN: 'unused' },
}));
const { tools: listed } = await client.listTools();
const listChars = J(listed).length;
const serverInstructions = client.getInstructions() || '';
await client.close();
console.log(`conn MCP server: ${listed.length} tools, tools/list ${listChars} chars (before ${BEFORE.mcpList}), instructions ${serverInstructions.length} chars`);
check('mcp-tool-list-no-larger', listChars <= BEFORE.mcpList);

// --- what the prose names --------------------------------------------------------

const mentionBlock = async (provider) => {
  const { rolldown } = await import('rolldown');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-mentions-'));
  try {
    const bundle = await rolldown({ input: path.join(ROOT, 'src/renderer/ui/lib/conn-mentions.js'), platform: 'node', logLevel: 'silent' });
    await bundle.write({ file: path.join(dir, 'mentions.cjs'), format: 'cjs' });
    return require(path.join(dir, 'mentions.cjs')).MENTIONS.browser.block({ provider });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};
const onDemand = (text) => [...new Set(text.match(/browser_[a-z_]+/g) || [])].filter((n) => !ALWAYS_LOADED.has(n));
for (const [where, text] of [
  ['instructions', INSTRUCTIONS],
  ['mcp-instructions', serverInstructions],
  ['claude-mention', await mentionBlock('claude')],
  ['acp-mention', await mentionBlock('cursor')],
]) {
  const named = onDemand(text);
  check(`${where}-names-only-always-loaded-tools`, named.length === 0, named.length ? `names ${named.join(', ')}, which load on demand` : '');
}

// --- the scenario, through the real handlers -----------------------------------

const drive = await import(pathToFileURL(path.join(ROOT, '.claude/skills/verify/drive.mjs')).href);
const s = await drive.boot({ root: ROOT, xvfb: true });
let server;
try {
  server = spawn(process.execPath, ['server.mjs'], { cwd: s.project, stdio: ['ignore', 'pipe', 'inherit'] });
  const url = await new Promise((res, rej) => {
    server.stdout.on('data', (d) => { const m = /Local: (\S+)/.exec(String(d)); if (m) res(m[1]); });
    server.on('exit', () => rej(new Error('the shop server exited')));
  });
  await drive.invoke(s, 'state'); // starts the chat the handlers belong to

  // Each call goes through AgentSession.browserHandlers, the functions the SDK
  // server runs, so the text and pictures are exactly what the model gets.
  // Auto mode, as a single call the CLI had already approved would be.
  const call = (calls) => drive.evaluate(s, `(async () => {
    const { nativeImage } = electron;
    const a = globalThis.__agent;
    a.mode = 'auto';
    const hs = new Map(a.browserHandlers(req('zod').z).map((h) => [h.name, h]));
    const out = [];
    for (const [name, args] of ${J(calls)}) {
      const r = await hs.get(name).handler(args, { _meta: { 'claudecode/toolUseId': 'cost-' + out.length } });
      out.push({
        name, isError: !!r.isError,
        text: r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\\n'),
        images: r.content.filter((b) => b.type === 'image').map((b) => ({ mime: b.mimeType, ...nativeImage.createFromBuffer(Buffer.from(b.data, 'base64')).getSize() })),
      });
    }
    return out;
  })()`, { main: true, awaitPromise: true });

  const steps = [
    ['navigate', { url }],
    ['snapshot', {}],
    ['fill', { target: '#coupon', value: 'SAVE10' }],
    ['click', { target: '#apply' }],
    ['wait', { selector: '#message.ok', timeout: 3000 }],
    ['text', {}],
    ['screenshot', {}],
  ];
  const sum = (results) => ({
    calls: results.length,
    chars: results.reduce((n, r) => n + r.text.length, 0),
    images: results.flatMap((r) => r.images).map((i) => `${i.width}x${i.height} ${i.mime} ~${tokens(i)} tokens`),
    failed: results.some((r) => r.isError),
  });

  const single = sum(await call(steps.map(([tool, args]) => [`browser_${tool}`, args])));
  const batched = await call([['browser_batch', { actions: steps.map(([tool, args]) => ({ tool, ...args })) }]]);
  const batch = sum(batched);
  console.log(`scenario as single calls: ${single.calls} calls, ${single.chars} result chars, images ${J(single.images)} (before ${BEFORE.scenarioCalls} calls, ${BEFORE.scenarioChars} chars)`);
  console.log(`scenario as one batch: ${batch.calls} call, ${batch.chars} result chars, images ${J(batch.images)}`);
  console.log(`model calls: ${single.calls} single, ${batch.calls} batched; that is the batch's saving`);
  console.log(`result text: the batch ${batch.chars} chars, the same steps as single calls today ${single.chars} (${batch.chars - single.chars >= 0 ? '+' : ''}${batch.chars - single.chars}, its step numbers), single calls before this branch ${BEFORE.scenarioChars}`);
  console.log(`--- the batch result the model reads ---\n${batched[0].text}\n---`);
  check('scenario-runs', !single.failed && !batch.failed);
  check('batch-confirms-the-coupon', /SAVE10 applied: \$4\.00 off/.test(batched[0].text));
  check('batch-is-one-call', batch.calls === 1);
  check('batch-text-smaller-than-before', batch.chars < BEFORE.scenarioChars, `${batch.chars} < ${BEFORE.scenarioChars}`);
  check('batch-sends-its-screenshot', batch.images.length === 1);

  // The median pane in real transcripts was 1280x929; emulate it for one shot.
  await drive.invoke(s, 'setViewport', { width: 1280, height: 929 });
  const [low, high] = await call([['browser_screenshot', {}], ['browser_screenshot', { detail: 'high' }]]);
  await drive.invoke(s, 'clearViewport');
  const lowTokens = tokens(low.images[0]);
  console.log(`median-size screenshot: default ${low.images[0].width}x${low.images[0].height} ${low.images[0].mime} ~${lowTokens} tokens (before ~${BEFORE.medianShotTokens}), detail high ${high.images[0].width}x${high.images[0].height} ~${tokens(high.images[0])} tokens`);
  console.log(`  note: ${low.text}`);
  check('default-shot-at-most-650-tokens', lowTokens <= 650, `${lowTokens}`);
  check('default-shot-is-jpeg', low.images[0].mime === 'image/jpeg');
  check('high-detail-is-larger', tokens(high.images[0]) > lowTokens);
  const saved = /(\d+)x(\d+) saved to (.+)$/m.exec(low.text);
  check('full-png-kept', !!saved && saved[1] === '1280' && saved[3].endsWith('.png'), low.text);

  // Defaults for reading a long page: a page's worth, and a note that says how
  // much there was.
  await drive.invoke(s, 'evaluate', { code: `document.body.insertAdjacentHTML('beforeend', '<p>' + 'lorem ipsum '.repeat(5000) + '</p>')` });
  const [text, html] = await call([['browser_text', {}], ['browser_html', {}]]);
  console.log(`long page: text ${text.text.length} chars, html ${html.text.length} chars`);
  check('text-default-8000', /truncated at 8000 of \d+ characters/.test(text.text) && text.text.length < 8200);
  check('html-default-20000', /truncated at 20000 of \d+ characters/.test(html.text) && html.text.length < 20200);
} finally {
  server?.kill();
  await drive.stop(s);
}

if (failures.length) {
  console.log(`\n${failures.length} FAIL(s): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nbrowser-cost-check: all passed');
process.exit(0);
