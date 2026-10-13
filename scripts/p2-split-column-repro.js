'use strict';
/* A page above a terminal in the right column. The preview is a native view
   laid over the window at the box the renderer last sent, and that box has to
   be `#paneslot` at every height of the split, or the page and the frame
   around it come apart while the handle moves. The terminal has to fill its
   own box at every height too, or its last rows, the prompt among them, sit
   under the slot's edge. Opens a page and a terminal, drags the handle between
   them to three heights with real mouse events, and reads both boxes after
   each. Then drags the terminal shut and brings it back with the keyboard.

   Boots through the verify skill, so the ports come from the OS and no lock
   is needed. Needs a built renderer: `npx vite build` first. */
const http = require('http');

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const GEOMETRY = `(() => {
  const box = (q) => {
    const el = document.querySelector(q);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, hidden: !!el.hidden };
  };
  const host = document.querySelector('#terms .term-host.active');
  const screen = host?.querySelector('.xterm-screen');
  const rows = host ? host.querySelectorAll('.xterm-rows > div').length : 0;
  return {
    right: box('section#right'),
    slot: box('#paneslot'),
    terms: box('#terms'),
    handle: box('section#right [data-slot="resizable-handle"][aria-orientation="horizontal"]'),
    strips: document.querySelectorAll('section#right [data-strip] [role="tablist"]').length,
    grid: screen && rows ? { rows, cell: screen.getBoundingClientRect().height / rows, box: parseFloat(getComputedStyle(host).height) } : null,
    text: host?.querySelector('.xterm-rows')?.innerText || '',
  };
})()`;

// As many rows as the host's box holds, which is the count xterm's fit addon
// asks for. A grid fit to an earlier box has more or fewer.
const fills = (grid) => !!grid && grid.rows === Math.max(1, Math.floor(grid.box / grid.cell + 1e-6));
const gridOf = (g) => (g.grid ? `${g.grid.rows} rows of ${g.grid.cell.toFixed(1)}px in a ${Math.round(g.grid.box)}px box` : 'no terminal');

async function main() {
  const { boot, bounds, drag, evaluate, invoke, key, stop, type } = await import('../.claude/skills/verify/drive.mjs');

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
    await type(s, 'seq 1 80; echo SPLIT-MARK', { enter: true });
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
      const x = g.handle.x + g.handle.width / 2;
      for (const frac of [0.3, 0.75, 0.5]) {
        g = await evaluate(s, GEOMETRY);
        const to = g.right.y + g.right.height * frac;
        await drag(s, x, g.handle.y + g.handle.height / 2, x, to);
        await sleep(300);
        const after = await evaluate(s, GEOMETRY);
        const b = await bounds(s);
        check(`handle-moves-to-${frac}`, Math.abs(after.handle.y - to) < 12, `asked ${Math.round(to)}, handle at ${Math.round(after.handle.y)}`);
        check(`bounds-follow-paneslot-at-${frac}`, b.match, JSON.stringify({ ipc: b.ipc, paneslot: b.paneslot, nativeViewMatch: b.nativeViewMatch }));
        check(`terminal-stays-below-the-page-at-${frac}`, !after.terms.hidden && after.terms.y >= after.slot.y + after.slot.height - 2, JSON.stringify({ slot: after.slot, terms: after.terms }));
        check(`terminal-fills-its-box-at-${frac}`, fills(after.grid), gridOf(after));
      }

      /* Past the bottom slot's floor the drag puts the slot away, and the store
         has to hear of it, or the page parks short of the column's foot. For a
         moment before the release the shell's box has no height, and a fit
         then squeezes whatever runs in it to one row. */
      g = await evaluate(s, GEOMETRY);
      await drag(s, x, g.handle.y + g.handle.height / 2, x, g.right.y + g.right.height - 4);
      await sleep(300);
      g = await evaluate(s, GEOMETRY);
      let b = await bounds(s);
      check('a-drag-past-the-floor-puts-the-terminal-away', g.terms.hidden && g.right.y + g.right.height - (g.slot.y + g.slot.height) < 2, JSON.stringify({ right: g.right, slot: g.slot, terms: g.terms }));
      check('bounds-follow-paneslot-with-the-terminal-away', b.match, JSON.stringify({ ipc: b.ipc, paneslot: b.paneslot }));
      const away = await evaluate(s, `document.querySelectorAll('#terms .term-host .xterm-rows > div').length`);
      check('the-shell-is-not-squeezed-to-one-row-while-it-is-away', away > 1, `${away} rows after the drag`);

      await key(s, 'Ctrl+`');
      await sleep(500);
      g = await evaluate(s, GEOMETRY);
      b = await bounds(s);
      check('the-terminal-comes-back-with-its-scrollback', !g.terms.hidden && g.terms.height > 60 && /SPLIT-MARK/.test(g.text), JSON.stringify({ terms: g.terms, text: g.text.slice(-120) }));
      const typing = await evaluate(s, `document.activeElement?.closest('#terms') ? 'the terminal' : document.activeElement?.tagName.toLowerCase() || 'nothing'`);
      check('the-terminal-takes-the-keys-when-it-comes-back', typing === 'the terminal', `the keys go to ${typing}`);
      check('the-terminal-fills-its-box-when-it-comes-back', fills(g.grid), gridOf(g));
      check('bounds-follow-paneslot-when-it-comes-back', b.match, JSON.stringify({ ipc: b.ipc, paneslot: b.paneslot }));
    }
  } finally {
    await stop(s);
    site.close();
  }

  console.log(failures.length ? `\n${failures.length} failed` : '\nall passed');
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
