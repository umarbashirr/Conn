/* A recording keeps three stills beside the video, and the agent is sent
   them as images. The model needs them no wider than a screenshot it is
   sent, 800 px, but the files are the person's: a recording made from the
   pane's own button lands in ~/Videos/Conn, and its stills were being
   rewritten at 800 px there too. With the pane in its own window, 864 px
   wide: the library's stills and the agent's stills on disk stay 864 wide,
   and only the images the agent is sent are 800. Needs a built renderer:
   `npx vite build`. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const drive = await import(pathToFileURL(path.join(ROOT, '.claude/skills/verify/drive.mjs')).href);

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
};
const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const s = await drive.boot({ root: ROOT, xvfb: true });
let server;
try {
  server = spawn(process.execPath, ['server.mjs'], { cwd: s.project, stdio: ['ignore', 'pipe', 'inherit'] });
  const url = await new Promise((res, rej) => {
    server.stdout.on('data', (d) => { const m = /Local: (\S+)/.exec(String(d)); if (m) res(m[1]); });
    server.on('exit', () => rej(new Error('the shop server exited')));
  });
  await drive.invoke(s, 'navigate', { url });
  await drive.evaluate(s, "window.conn.browser.action('detach', undefined, 'mn1')", { awaitPromise: true });
  await sleep(800);
  const sizes = (files) => drive.evaluate(s, `${J(files)}.map((f) => electron.nativeImage.createFromPath(f).getSize().width)`, { main: true });

  await drive.evaluate(s, "window.conn.browser.action('record', { action: 'start' }, 'mn1')", { awaitPromise: true });
  await sleep(1500);
  const library = await drive.evaluate(s, "window.conn.browser.action('record', { action: 'stop' }, 'mn1')", { awaitPromise: true });
  const libraryWidths = await sizes(library.keyframes);
  console.log(`library: ${library.path}, video ${library.width} wide, stills ${libraryWidths.join(' ')}`);
  check('library-recording-lands-in-videos', library.path.startsWith(path.join(s.home, 'Videos', 'Conn')), library.path);
  check('library-stills-keep-the-frame-size', library.width > 800 && libraryWidths.every((w) => w === library.width), `${libraryWidths} vs ${library.width}`);
  const shelf = fs.readdirSync(path.dirname(library.path));
  check('library-holds-only-the-persons-files', shelf.length === 4 && !shelf.some((f) => f.includes('.sent.')), shelf.join(' '));

  const agent = await drive.evaluate(s, `(async () => {
    const a = globalThis.__agent;
    a.mode = 'auto';
    const hs = new Map(a.browserHandlers(req('zod').z).map((h) => [h.name, h]));
    await hs.get('browser_record').handler({ action: 'start' }, {});
    await new Promise((r) => setTimeout(r, 1500));
    const r = await hs.get('browser_record').handler({ action: 'stop' }, {});
    const text = r.content.find((b) => b.type === 'text').text;
    return { result: JSON.parse(text), sent: r.content.filter((b) => b.type === 'image').map((b) => electron.nativeImage.createFromBuffer(Buffer.from(b.data, 'base64')).getSize().width) };
  })()`, { main: true, awaitPromise: true });
  const agentWidths = await sizes(agent.result.keyframes);
  console.log(`agent: video ${agent.result.width} wide, stills on disk ${agentWidths.join(' ')}, sent ${agent.sent.join(' ')}`);
  check('agent-stills-on-disk-keep-the-frame-size', agent.result.width > 800 && agentWidths.every((w) => w === agent.result.width), `${agentWidths} vs ${agent.result.width}`);
  check('agent-is-sent-three-stills-at-800', agent.sent.length === 3 && agent.sent.every((w) => w === 800), J(agent.sent));
} finally {
  server?.kill();
  await drive.stop(s);
}

if (failures.length) {
  console.log(`\n${failures.length} FAIL(s): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\np2-record-stills-repro: all passed');
process.exit(0);
