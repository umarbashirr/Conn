/* An action's result waits for the requests the action started, so it can
   say whether they failed. A stream never finishes: an EventSource, or a
   fetch whose answer is text/event-stream, held every action that opened one
   for the whole settle window, about a second. A click that opens a stream
   must return within 150 ms of the same click opening nothing, while a
   request that fails is still reported and a plain fetch that hangs still
   gets the window. Needs a built renderer: `npx vite build`. */
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

const open = new Set();
const api = http.createServer((req, res) => {
  const cors = { 'access-control-allow-origin': '*' };
  if (req.url.startsWith('/sse')) {
    res.writeHead(200, { ...cors, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write('data: hello\n\n');
    const tick = setInterval(() => res.write('data: tick\n\n'), 200);
    open.add(res);
    req.on('close', () => { clearInterval(tick); open.delete(res); });
    return;
  }
  if (req.url.startsWith('/hang')) { open.add(res); return; }
  res.writeHead(500, cors);
  res.end('no');
});
await new Promise((r) => api.listen(0, '127.0.0.1', r));
const API = `http://127.0.0.1:${api.address().port}`;

const s = await drive.boot({ root: ROOT, xvfb: true });
let server;
try {
  server = spawn(process.execPath, ['server.mjs'], { cwd: s.project, stdio: ['ignore', 'pipe', 'inherit'] });
  const url = await new Promise((res, rej) => {
    server.stdout.on('data', (d) => { const m = /Local: (\S+)/.exec(String(d)); if (m) res(m[1]); });
    server.on('exit', () => rej(new Error('the shop server exited')));
  });
  await drive.invoke(s, 'state');
  const starts = {
    nothing: '',
    eventsource: `window.__es = new EventSource(${J(`${API}/sse`)});`,
    'fetch-stream': `fetch(${J(`${API}/sse?f=1`)}).then((r) => r.body.getReader().read());`,
    'fetch-500': `fetch(${J(`${API}/500`)}).catch(() => {});`,
    'fetch-hang': `fetch(${J(`${API}/hang`)}).catch(() => {});`,
  };
  const out = await drive.evaluate(s, `(async () => {
    const a = globalThis.__agent;
    a.mode = 'auto';
    const hs = new Map(a.browserHandlers(req('zod').z).map((h) => [h.name, h]));
    const run = async (name, args = {}) => (await hs.get(name).handler(args, {})).content[0].text;
    const out = {};
    for (const [kind, start] of Object.entries(${J(starts)})) {
      const ms = [];
      for (let i = 0; i < 3; i++) {
        await run('browser_navigate', { url: ${J(url)} });
        await run('browser_evaluate', { code: "document.querySelector('#apply').addEventListener('click', () => { " + start + " }); 1" });
        const t0 = Date.now();
        out[kind + ':text'] = await run('browser_click', { target: '#apply' });
        ms.push(Date.now() - t0);
      }
      out[kind] = ms.sort((x, y) => x - y)[1];
    }
    return out;
  })()`, { main: true, awaitPromise: true });
  console.log(Object.keys(starts).map((k) => `${k} ${out[k]} ms`).join(', '));
  check('eventsource-does-not-hold-the-click', out.eventsource - out.nothing <= 150, `${out.eventsource} ms against ${out.nothing} ms`);
  check('event-stream-fetch-does-not-hold-the-click', out['fetch-stream'] - out.nothing <= 150, `${out['fetch-stream']} ms against ${out.nothing} ms`);
  check('a-failed-request-is-still-reported', /request failed: 500 GET .*\/500/.test(out['fetch-500:text']), out['fetch-500:text']);
  check('a-hung-fetch-still-gets-the-window', out['fetch-hang'] - out.nothing >= 800, `${out['fetch-hang']} ms against ${out.nothing} ms`);
} finally {
  server?.kill();
  for (const res of open) res.destroy();
  api.close();
  await drive.stop(s);
}

if (failures.length) {
  console.log(`\n${failures.length} FAIL(s): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\np2-streaming-wait-repro: all passed');
process.exit(0);
