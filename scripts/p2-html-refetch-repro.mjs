/* Reading a page's HTML must not touch the page. The read used to clone the
   document inside the live page, and every cloned <img> loaded again, so each
   browser_html fetched the page's images once more and logged a failed
   request where one failed. Here an image on a counting server must be
   fetched once however many times the HTML is read, and the network log must
   not grow. Needs a built renderer: `npx vite build`. */
import { spawn } from 'node:child_process';
import http from 'node:http';
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

let hits = 0;
const images = http.createServer((req, res) => {
  hits += 1;
  res.writeHead(500, { 'access-control-allow-origin': '*' });
  res.end('no');
});
await new Promise((r) => images.listen(0, '127.0.0.1', r));
const img = `http://127.0.0.1:${images.address().port}/pic.png`;

const s = await drive.boot({ root: ROOT, xvfb: true });
let server;
try {
  server = spawn(process.execPath, ['server.mjs'], { cwd: s.project, stdio: ['ignore', 'pipe', 'inherit'] });
  const url = await new Promise((res, rej) => {
    server.stdout.on('data', (d) => { const m = /Local: (\S+)/.exec(String(d)); if (m) res(m[1]); });
    server.on('exit', () => rej(new Error('the shop server exited')));
  });
  await drive.invoke(s, 'state');
  const out = await drive.evaluate(s, `(async () => {
    const a = globalThis.__agent;
    a.mode = 'auto';
    const hs = new Map(a.browserHandlers(req('zod').z).map((h) => [h.name, h]));
    const run = async (name, args = {}) => (await hs.get(name).handler(args, {})).content[0].text;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await run('browser_navigate', { url: ${J(url)} });
    await run('browser_evaluate', { code: ${J(`const i = document.createElement('img'); i.src = ${J(img)}; document.body.appendChild(i); 1`)} });
    await run('browser_click', { target: '#apply' });
    await sleep(500);
    const pointer = await run('browser_evaluate', { code: "!!document.getElementById('__conn-cursor')" });
    const before = await run('browser_network');
    const html = [];
    for (let i = 0; i < 3; i++) { html.push(await run('browser_html')); await sleep(300); }
    return { pointer, before, after: await run('browser_network'), html };
  })()`, { main: true, awaitPromise: true });
  const failedRows = (t) => t.split('\n').filter((l) => l.includes(img)).length;
  console.log(`image fetched ${hits} times; failed rows before ${failedRows(out.before)}, after ${failedRows(out.after)}`);
  check('html-still-has-the-image', out.html.every((h) => h.includes(img)), out.html[0].slice(0, 200));
  check('html-leaves-conn-out', out.pointer.startsWith('true') && out.html.every((h) => !h.includes('__conn-cursor')), `pointer on the page: ${out.pointer}`);
  check('image-fetched-once', hits === 1, `${hits} fetches`);
  check('network-log-does-not-grow', failedRows(out.before) === 1 && failedRows(out.after) === 1, `${failedRows(out.before)} then ${failedRows(out.after)}`);
} finally {
  server?.kill();
  images.close();
  await drive.stop(s);
}

if (failures.length) {
  console.log(`\n${failures.length} FAIL(s): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\np2-html-refetch-repro: all passed');
process.exit(0);
