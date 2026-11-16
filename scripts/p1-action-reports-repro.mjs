/* An action's result lists the console errors and failed requests it set
   off, and each one once, under the step it came after. Driven through the
   in-process Claude tools on the shop page, with a server whose every answer
   is a 500.

   - fill, select and evaluate list the requests they start, including one a
     render later, the way a framework's effect starts it.
   - hover, scroll, wait, viewport, highlight and tab_new with a url report
     too: each can change or load a page.
   - In a batch, an error a fill causes 30 ms later is listed under the fill,
     not under the click after it.
   - An error that lands after one action's result and before the next
     action is listed by the next one, marked as coming after the previous
     step, and by no later one.
   Needs a built renderer: `npx vite build`. */
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

const api = http.createServer((req, res) => {
  const q = new URL(req.url, 'http://x').searchParams;
  setTimeout(() => {
    if (q.has('page')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<!doctype html><title>loud</title><script>console.error("LOAD-ERR")</script><p>loud</p>');
    }
    res.writeHead(500, { 'access-control-allow-origin': '*' });
    res.end('no');
  }, Number(q.get('ms') || 0));
});
await new Promise((r) => api.listen(0, '127.0.0.1', r));
const API = `http://127.0.0.1:${api.address().port}/`;

const s = await drive.boot({ root: ROOT, xvfb: true });
let server;
try {
  server = spawn(process.execPath, ['server.mjs'], { cwd: s.project, stdio: ['ignore', 'pipe', 'inherit'] });
  const url = await new Promise((res, rej) => {
    server.stdout.on('data', (d) => { const m = /Local: (\S+)/.exec(String(d)); if (m) res(m[1]); });
    server.on('exit', () => rej(new Error('the shop server exited')));
  });
  await drive.invoke(s, 'state');
  const calls = (list) => drive.evaluate(s, `(async () => {
    const a = globalThis.__agent;
    a.mode = 'auto';
    const hs = new Map(a.browserHandlers(req('zod').z).map((h) => [h.name, h]));
    const out = [];
    for (const [name, args, pause] of ${J(list)}) {
      const r = await hs.get(name).handler(args, {});
      out.push(r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\\n'));
      if (pause) await new Promise((res) => setTimeout(res, pause));
    }
    return out;
  })()`, { main: true, awaitPromise: true });
  const on = (sel, ev, body) => ['browser_evaluate', { code: `document.querySelector(${J(sel)}).addEventListener(${J(ev)}, () => { ${body} }, { once: true }); 1` }];
  const fetch500 = (tag, ms = 100) => `fetch(${J(`${API}?ms=${ms}&${tag}=1`)}).catch(() => {})`;
  const lists = (text, tag) => text.includes(`&${tag}=1`);

  const [, , fill] = await calls([['browser_navigate', { url }], on('#coupon', 'input', fetch500('fill')), ['browser_fill', { target: '#coupon', value: 'a' }]]);
  check('fill-lists-the-request-it-started', lists(fill, 'fill'), fill);

  const [, later] = await calls([on('#coupon', 'input', `requestAnimationFrame(() => ${fetch500('effect')})`), ['browser_fill', { target: '#coupon', value: 'b' }]]);
  check('fill-lists-a-request-its-render-starts', lists(later, 'effect'), later);

  const [, , select] = await calls([
    ['browser_evaluate', { code: `document.body.insertAdjacentHTML('beforeend', '<select id="size"><option>S</option><option>L</option></select>'); 1` }],
    on('#size', 'change', fetch500('select')),
    ['browser_select', { target: '#size', value: 'L' }],
  ]);
  check('select-lists-the-request-it-started', lists(select, 'select'), select);

  const [evaluated] = await calls([['browser_evaluate', { code: `(${fetch500('evaluate')}, 2)` }]]);
  check('evaluate-lists-the-request-it-started', evaluated.startsWith('2') && lists(evaluated, 'evaluate'), evaluated);

  const [, hover] = await calls([on('#apply', 'mouseover', `console.error('HOVER-ERR'); ${fetch500('hover')}`), ['browser_hover', { target: '#apply' }]]);
  check('hover-reports', hover.includes('HOVER-ERR') && lists(hover, 'hover'), hover);

  const [, scroll] = await calls([
    ['browser_evaluate', { code: `document.body.style.height = '5000px'; addEventListener('scroll', () => console.error('SCROLL-ERR'), { once: true }); 1` }],
    ['browser_scroll', { dy: 300 }],
  ]);
  check('scroll-reports', scroll.includes('SCROLL-ERR'), scroll);

  const [, wait] = await calls([['browser_evaluate', { code: `setTimeout(() => console.error('WAIT-ERR'), 150); 1` }], ['browser_wait', { ms: 400 }]]);
  check('wait-reports-what-came-during-it', wait.includes('WAIT-ERR') && !wait.includes('after the previous step'), wait);

  const [, viewport] = await calls([['browser_evaluate', { code: `addEventListener('resize', () => console.error('RESIZE-ERR'), { once: true }); 1` }], ['browser_viewport', { width: 390, height: 700 }], ['browser_viewport', {}]]);
  check('viewport-reports', viewport.includes('RESIZE-ERR'), viewport);

  const [, highlight] = await calls([
    ['browser_evaluate', { code: `new MutationObserver((m, o) => { o.disconnect(); console.error('MUTATION-ERR'); }).observe(document.documentElement, { childList: true, subtree: true }); 1` }],
    ['browser_highlight', { target: '#apply' }],
  ]);
  check('highlight-reports', highlight.includes('MUTATION-ERR'), highlight);

  const [tab] = await calls([['browser_tab_new', { url: `${API}?page=1` }]]);
  check('tab-new-with-a-url-reports-the-load', tab.includes('LOAD-ERR'), tab);

  const [, , batch] = await calls([
    ['browser_navigate', { url }],
    on('#coupon', 'input', `setTimeout(() => console.error('EFFECT-ERR-FROM-FILL'), 30)`),
    ['browser_batch', { actions: [{ tool: 'fill', target: '#coupon', value: 'q' }, { tool: 'click', target: '#apply' }] }],
  ]);
  const [fillStep, clickStep] = batch.split(/\n(?=2\. )/);
  check('batch-error-is-under-the-fill', fillStep.includes('EFFECT-ERR-FROM-FILL') && !clickStep.includes('EFFECT-ERR-FROM-FILL'), batch);

  const [, , next, after] = await calls([
    ['browser_navigate', { url }],
    ['browser_evaluate', { code: `setTimeout(() => console.error('LATE-ERR'), 400); 3` }, 900],
    ['browser_click', { target: '#apply' }],
    ['browser_click', { target: '#apply' }],
  ]);
  check('a-late-error-is-told-by-the-next-action', /LATE-ERR/.test(next) && /after the previous step/.test(next), next);
  check('and-only-once', !after.includes('LATE-ERR'), after);
} finally {
  server?.kill();
  api.close();
  await drive.stop(s);
}

if (failures.length) {
  console.log(`\n${failures.length} FAIL(s): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\np1-action-reports-repro: all passed');
process.exit(0);
