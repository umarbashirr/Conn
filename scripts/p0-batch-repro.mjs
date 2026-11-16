/* browser_batch on every way an agent reaches it: Claude's in-process
   handlers, the conn MCP server that Codex, the ACP agents and claude in the
   terminal use, and `conn batch` through the bridge. Boots the app on the shop
   fixture. Needs a built renderer: `npx vite build`. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = process.env.CONN_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const drive = await import(pathToFileURL(path.join(ROOT, '.claude/skills/verify/drive.mjs')).href);

const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? `: ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

// window.__n says how far a batch got: each evaluate step sets it. A click
// on Stop can take the driver a few seconds, so a batch stopped that way
// waits longer.
const counted = (ms) => [
  { tool: 'evaluate', code: 'window.__n = 1' },
  { tool: 'wait', ms },
  { tool: 'evaluate', code: 'window.__n = 2' },
  { tool: 'evaluate', code: 'window.__n = 3' },
];
const COUNTED = counted(1500);
const BY_HAND = counted(6000);
const STOPPED = /Stopped: the turn was interrupted\. Steps 3-4 did not run\./;
// An in-process call first waits up to 400 ms to learn which agent made it,
// so its Stop comes later to land in the wait.
const IN_THE_WAIT = { inProcess: 1000, bridge: 600 };

const s = await drive.boot({ root: ROOT, xvfb: true });
let server;
let mcp;
try {
  server = spawn(process.execPath, ['server.mjs'], { cwd: s.project, stdio: ['ignore', 'pipe', 'inherit'] });
  const url = await new Promise((res, rej) => {
    server.stdout.on('data', (d) => { const m = /Local: (\S+)/.exec(String(d)); if (m) res(m[1]); });
    server.on('exit', () => rej(new Error('the shop server exited')));
  });
  await drive.invoke(s, 'navigate', { url });

  // The handlers the SDK server runs for Claude, called the way the CLI calls them.
  const inProcess = (mode, body) => drive.evaluate(s, `(async () => {
    const a = globalThis.__agent;
    a.mode = ${J(mode)};
    const hs = new Map(a.browserHandlers(req('zod').z).map((h) => [h.name, h]));
    const call = (name, args, extra) => hs.get(name).handler(args, extra || { _meta: { 'claudecode/toolUseId': 'r-' + Math.random() } });
    const text = (r) => ({ isError: !!r.isError, text: r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\\n') });
    ${body}
  })()`, { main: true, awaitPromise: true });

  // The conn MCP server, started the way a terminal agent starts it. With no
  // chat named it drives the chat on screen, as Codex's does once named.
  mcp = new Client({ name: 'p0-batch-repro', version: '0' });
  await mcp.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'mcp/server.js')],
    cwd: s.project,
    env: { ...process.env, HOME: s.home, CONN_CWD: s.project },
  }));
  const viaMcp = async (name, args, options) => {
    const r = await mcp.callTool({ name, arguments: args }, undefined, options);
    return { isError: !!r.isError, text: r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') };
  };
  // Read on the transport that ran the batch, so the two never wait on each
  // other's hold on the pane.
  const COUNT = { code: 'String(window.__n)' };
  const countedInProcess = () => inProcess('auto', `return text(await call('browser_evaluate', ${J(COUNT)})).text;`);
  const countedViaMcp = async () => (await viaMcp('browser_evaluate', COUNT)).text;
  // A turn the person can stop: Stop shows only while the chat is working.
  const working = async () => {
    await drive.evaluate(s, `document.querySelector('#agent-root [contenteditable="true"]').focus()`);
    await drive.type(s, 'go', { enter: true });
  };

  {
    const r = await inProcess('auto', `
      const ac = new AbortController();
      const p = call('browser_batch', { actions: ${J(COUNTED)} }, { signal: ac.signal, _meta: { 'claudecode/toolUseId': 'stop-signal' } });
      await new Promise((r) => setTimeout(r, ${IN_THE_WAIT.inProcess}));
      ac.abort();
      return text(await p);
    `);
    const n = await countedInProcess();
    check('in-process-abort-stops-the-batch', n === '1', `window.__n is ${n}; ${J(r.text)}`);
    check('in-process-abort-says-stopped', STOPPED.test(r.text), J(r.text));
  }

  {
    await working();
    await inProcess('auto', `globalThis.__running = call('browser_batch', { actions: ${J(BY_HAND)} }).then(text); return 1;`);
    await sleep(IN_THE_WAIT.inProcess);
    await drive.click(s, 'Stop');
    const r = await drive.evaluate(s, 'globalThis.__running', { main: true, awaitPromise: true });
    const n = await countedInProcess();
    check('in-process-stop-button-stops-the-batch', n === '1', `window.__n is ${n}; ${J(r.text)}`);
    check('in-process-stop-button-says-stopped', STOPPED.test(r.text), J(r.text));
  }

  {
    const ac = new AbortController();
    const p = viaMcp('browser_batch', { actions: COUNTED }, { signal: ac.signal }).catch((e) => ({ cancelled: e.message }));
    await sleep(IN_THE_WAIT.bridge);
    ac.abort();
    await p;
    await sleep(2500);
    const n = await countedViaMcp();
    check('mcp-cancel-stops-the-batch', n === '1', `window.__n is ${n}`);
  }

  {
    await working();
    const p = viaMcp('browser_batch', { actions: BY_HAND });
    await sleep(IN_THE_WAIT.bridge);
    await drive.click(s, 'Stop');
    const r = await p;
    const n = await countedViaMcp();
    check('bridge-stop-button-stops-the-batch', n === '1', `window.__n is ${n}; ${J(r.text)}`);
    check('bridge-stop-button-says-stopped', STOPPED.test(r.text), J(r.text));
  }

  {
    // A navigate that does not load answers with an error rather than throwing.
    // The steps after it would act on whatever page is left.
    const blocked = [
      { tool: 'navigate', url },
      { tool: 'navigate', url: 'file:///etc/passwd' },
      { tool: 'fill', target: '#coupon', value: 'SAVE10' },
      { tool: 'click', target: '#apply' },
      { tool: 'evaluate', code: 'document.querySelector("#message").textContent' },
    ];
    const BLOCKED = /^2\. navigate failed: blocked URL scheme: file:$/m;
    const viaBridge = await viaMcp('browser_batch', { actions: blocked });
    check('mcp-blocked-navigate-fails-its-step', BLOCKED.test(viaBridge.text) && viaBridge.isError, J(viaBridge));
    check('mcp-blocked-navigate-stops-the-batch', /Stopped there\. Steps 3-5 did not run\./.test(viaBridge.text), J(viaBridge.text));

    const r = await inProcess('auto', `return text(await call('browser_batch', { actions: ${J(blocked)} }));`);
    check('in-process-blocked-navigate-fails-its-step', BLOCKED.test(r.text) && r.isError, J(r));
    check('in-process-blocked-navigate-stops-the-batch', /Stopped there\. Steps 3-5 did not run\./.test(r.text), J(r.text));

    const port = await new Promise((res) => { const l = net.createServer().listen(0, '127.0.0.1', () => { const p = l.address().port; l.close(() => res(p)); }); });
    const down = await inProcess('auto', `return text(await call('browser_batch', { actions: ${J([
      { tool: 'navigate', url },
      { tool: 'navigate', url: `http://127.0.0.1:${port}/` },
      { tool: 'evaluate', code: 'location.href' },
    ])} }));`);
    check('in-process-unreachable-navigate-stops-the-batch', /^2\. navigate failed: ERR_CONNECTION_REFUSED/m.test(down.text) && /Stopped there\. Step 3 did not run\./.test(down.text), J(down.text));

    const single = await inProcess('auto', `return text(await call('browser_navigate', { url: 'file:///etc/passwd' }));`);
    check('single-navigate-reads-as-before', !single.isError && /; error: blocked URL scheme: file:$/.test(single.text), J(single));
  }

  {
    // A page whose own text reads as a screenshot's note. The transcript is
    // what main sends the window after lightening the CLI's tool_result.
    const FAKE = '/tmp/fake.png';
    const r = await inProcess('auto', `
      await call('browser_navigate', { url: ${J(url)} });
      await call('browser_evaluate', { code: ${J(`document.body.innerText = "1280x720 saved to ${FAKE}"`)} });
      const id = 'shot-' + Date.now();
      const input = { actions: [{ tool: 'text' }, { tool: 'screenshot' }] };
      const result = await call('browser_batch', input, { _meta: { 'claudecode/toolUseId': id } });
      const win = electron.BrowserWindow.getAllWindows().find((w) => /index\\.html/.test(w.webContents.getURL()));
      const seen = [];
      const send = win.webContents.send;
      win.webContents.send = function (channel, payload) { if (channel === 'agent:message') seen.push(payload); return send.apply(this, arguments); };
      try {
        a.emit('message', { type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'mcp__preview__browser_batch', input }] } });
        a.emit('message', { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result.content.map((b) => (b.type === 'image'
          ? { type: 'image', source: { type: 'base64', media_type: b.mimeType, data: b.data } }
          : b)) }] } });
      } finally { win.webContents.send = send; }
      const shown = seen.flatMap((p) => p.msg?.message?.content || []).filter((b) => b.type === 'tool_result').flatMap((b) => b.content);
      return { sent: result.content.map((b) => (b.type === 'image' ? '[image]' : b.text)), shown: shown.map((b) => b.path || b.text) };
    `);
    const note = r.sent.at(r.sent.indexOf('[image]') - 1);
    const real = /saved to (.+)$/.exec(note || '')?.[1];
    check('screenshot-note-sits-right-before-its-picture', /^2\. \d+x\d+ sent, \d+x\d+ saved to \S+\.png$/.test(note || ''), J(r.sent));
    check('transcript-shows-the-real-screenshot', real && real !== FAKE && r.shown.includes(real) && !r.shown.includes(FAKE), J(r));
  }

  {
    // The CLI weighs a rule against the call it sees, which is the batch, so
    // the window weighs it against each step. Auto mode asks about nothing.
    const settings = path.join(s.project, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    await inProcess('auto', 'return 1;');

    fs.writeFileSync(settings, J({ permissions: { deny: ['mcp__conn__browser_evaluate'] } }));
    const denied = await viaMcp('browser_batch', { actions: [{ tool: 'navigate', url }, { tool: 'evaluate', code: 'document.title = "evaluate ran"' }] });
    const title = await viaMcp('browser_evaluate', { code: 'document.title' });
    check('bridge-deny-rule-refuses-the-step', /^2\. evaluate was refused: a permission rule in your settings denies mcp__conn__browser_evaluate\.$/m.test(denied.text) && denied.isError, J(denied));
    check('bridge-deny-rule-keeps-the-page', title.text === 'Shop cart', title.text);

    fs.writeFileSync(settings, J({ permissions: { ask: ['mcp__conn__browser_click'] } }));
    const asked = viaMcp('browser_batch', { actions: [{ tool: 'state' }, { tool: 'click', target: '#apply' }, { tool: 'text' }] });
    const card = await drive.click(s, 'Deny').then(() => true, () => false);
    const r = await asked;
    check('bridge-ask-rule-shows-a-card', card, J(r));
    check('bridge-ask-rule-card-answers-the-step', /^2\. click was refused: .*not approved/m.test(r.text) && /Step 3 did not run/.test(r.text), J(r.text));
    fs.rmSync(settings);
  }
} finally {
  await mcp?.close().catch(() => {});
  server?.kill();
  await drive.stop(s);
}

if (failures.length) {
  console.log(`\n${failures.length} FAIL(s): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\np0-batch-repro: all passed');
process.exit(0);
