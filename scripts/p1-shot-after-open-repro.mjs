/* A batch that opens a page and then looks at it, with the browser pane
   closed: the navigate brings the pane into the box, and the next step runs
   while the window is still growing it from no size to the column's width.
   A screenshot then failed with "Current display surface not available for
   capture", and a snapshot read a 1x1 viewport in which every element looks
   hidden. Twelve trials of each, half with the pane fully closed first and
   half reopened as it closes, must all come back whole: a picture of the
   page, and an outline that lists the coupon field. Needs a built renderer:
   `npx vite build`. */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const drive = await import(pathToFileURL(path.join(ROOT, '.claude/skills/verify/drive.mjs')).href);
const TRIALS = 12;

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
};
const J = JSON.stringify;

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
    const run = (name, args = {}) => hs.get(name).handler(args, {});
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await run('browser_navigate', { url: ${J(url)} });
    const trials = [];
    for (const look of ['screenshot', 'snapshot']) {
      for (let i = 0; i < ${TRIALS}; i++) {
        await run('browser_show', { open: false });
        // Long enough for the pane to have left the box, as it has a model turn later.
        if (i % 2) await sleep(400);
        const r = await run('browser_batch', { actions: [{ tool: 'navigate', url: ${J(url)} }, { tool: look }] });
        trials.push({ look, text: r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\\n'), images: r.content.filter((b) => b.type === 'image').length });
      }
    }
    return trials;
  })()`, { main: true, awaitPromise: true });

  for (const look of ['screenshot', 'snapshot']) {
    const runs = out.filter((t) => t.look === look);
    const bad = runs.filter((t) => (look === 'screenshot'
      ? !(t.images === 1 && /2\. \d+x\d+ sent, (\d+)x(\d+) saved to /.exec(t.text)?.slice(1).every((n) => n > 100))
      : !(/viewport: (\d+)x(\d+)/.exec(t.text)?.slice(1).every((n) => n > 100) && /textbox "Coupon code"/.test(t.text))));
    console.log(`${look}: ${runs.length - bad.length} of ${runs.length} whole`);
    for (const t of bad.slice(0, 3)) console.log(`  ${t.text.split('\n').slice(1, 5).join(' | ')}`);
    check(`${look}-after-navigate-in-a-closed-pane`, bad.length === 0, `${bad.length} of ${runs.length} failed`);
  }
} finally {
  server?.kill();
  await drive.stop(s);
}

if (failures.length) {
  console.log(`\n${failures.length} FAIL(s): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\np1-shot-after-open-repro: all passed');
process.exit(0);
