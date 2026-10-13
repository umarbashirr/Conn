'use strict';
/* A page above a terminal in the right column. The preview is a native view
   laid over the window at the box the renderer last sent, and that box has to
   be `#paneslot` at every height of the split, or the page and the frame
   around it come apart while the handle moves. Opens a page and a terminal,
   drags the handle between them to three heights with real mouse events, and
   reads the box after each.

   Boots through the verify skill, so the ports come from the OS and no lock
   is needed. Needs a built renderer: `npx vite build` first. */
const http = require('http');

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* drive.mjs opens a connection per command and closes it after. A drag is
   one pointer held down across many moves, so it keeps a connection of its
   own for the whole gesture. */
async function pageOf(s) {
  const list = await (await fetch(`http://127.0.0.1:${s.cdp}/json/list`)).json();
  const hit = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
  const ws = new WebSocket(hit.webSocketDebuggerUrl);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
  let seq = 0;
  const waiting = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg.result); waiting.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise((ok) => {
    const id = ++seq;
    waiting.set(id, ok);
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { send, close: () => ws.close() };
}

const mouse = (c, type, x, y, rest) => c.send('Input.dispatchMouseEvent', { type, x, y, ...rest });

async function drag(c, from, to) {
  await mouse(c, 'mouseMoved', from.x, from.y, { button: 'none', buttons: 0 });
  await mouse(c, 'mousePressed', from.x, from.y, { button: 'left', buttons: 1, clickCount: 1 });
  const steps = 12;
  for (let i = 1; i <= steps; i += 1) {
    await mouse(c, 'mouseMoved', from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps, { button: 'left', buttons: 1 });
    await sleep(16);
  }
  await mouse(c, 'mouseReleased', to.x, to.y, { button: 'left', buttons: 0, clickCount: 1 });
}

const GEOMETRY = `(() => {
  const box = (q) => {
    const el = document.querySelector(q);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, hidden: !!el.hidden };
  };
  return {
    right: box('section#right'),
    slot: box('#paneslot'),
    terms: box('#terms'),
    handle: box('section#right [data-slot="resizable-handle"][aria-orientation="horizontal"]'),
    strips: document.querySelectorAll('section#right [role="tablist"]').length,
  };
})()`;

async function main() {
  const { boot, bounds, evaluate, invoke, key, stop } = await import('../.claude/skills/verify/drive.mjs');

  const site = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>split</title><body style="background:#e8f0ff"><h1>Split column</h1></body>');
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${site.address().port}/`;

  const s = await boot({ xvfb: true });
  try {
    await invoke(s, 'navigate', { url });
    await key(s, 'Ctrl+Shift+T');
    await sleep(500);

    let g = await evaluate(s, GEOMETRY);
    check('page-and-terminal-both-on-screen', g.slot?.height > 100 && !!g.terms && !g.terms.hidden && g.terms.height > 60, JSON.stringify({ slot: g.slot, terms: g.terms }));
    check('one-tab-strip-per-slot', g.strips === 2, `${g.strips} strips under section#right`);
    check('a-handle-between-the-slots', !!g.handle && g.handle.width > 100 && g.handle.y > g.slot?.y, JSON.stringify(g.handle));
    const before = await bounds(s);
    check('bounds-match-paneslot-before-any-drag', before.match, JSON.stringify({ ipc: before.ipc, paneslot: before.paneslot }));

    if (!g.handle) {
      check('drags', false, 'no handle to drag');
    } else {
      const c = await pageOf(s);
      for (const frac of [0.3, 0.75, 0.5]) {
        g = await evaluate(s, GEOMETRY);
        const from = { x: g.handle.x + g.handle.width / 2, y: g.handle.y + g.handle.height / 2 };
        const to = { x: from.x, y: g.right.y + g.right.height * frac };
        await drag(c, from, to);
        await sleep(300);
        const after = await evaluate(s, GEOMETRY);
        const b = await bounds(s);
        check(`handle-moves-to-${frac}`, Math.abs(after.handle.y - to.y) < 12, `asked ${Math.round(to.y)}, handle at ${Math.round(after.handle.y)}`);
        check(`bounds-follow-paneslot-at-${frac}`, b.match, JSON.stringify({ ipc: b.ipc, paneslot: b.paneslot, nativeViewMatch: b.nativeViewMatch }));
        check(`terminal-stays-below-the-page-at-${frac}`, !after.terms.hidden && after.terms.y >= after.slot.y + after.slot.height - 2, JSON.stringify({ slot: after.slot, terms: after.terms }));
      }
      c.close();
    }
  } finally {
    await stop(s);
    site.close();
  }

  console.log(failures.length ? `\n${failures.length} failed` : '\nall passed');
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
