'use strict';
/* The design canvas, end to end in the real app. A project with two frames in
   .conn/canvas/ opens; "Design a UI" puts a $canvas badge in the chat box and
   the Canvas tab on screen; the board draws both frames from their JSON; it
   pans and zooms; a drag and a resize land in the files; an agent-style edit
   redraws without moving the viewport or dropping the selection; broken files
   show why; the selection rides into the prompt; and every export produces a
   file that is what it claims to be.

   Input goes through CDP as real mouse and wheel events. The save dialog and
   the agent are answered from the main process over the Node inspector, so
   nothing waits on a person and no agent runs. Runs on a throwaway HOME. Needs
   a built renderer: `npx vite build` first. */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9335;
const INSPECT = 9336;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
};

const LANDING = (headline) => ({
  type: 'frame', name: 'Landing', x: 0, y: 0, width: 1280, height: 820, fill: '#f8fafc', layout: { direction: 'column' },
  children: [
    {
      type: 'frame', name: 'Header', width: 'fill', fill: '#ffffff', stroke: { color: '#e2e8f0', width: 1 },
      layout: { direction: 'row', padding: [16, 32], align: 'center', justify: 'space-between' },
      children: [
        {
          type: 'frame', name: 'Brand', layout: { direction: 'row', gap: 8, align: 'center' },
          children: [
            { type: 'vector', name: 'Logo', width: 24, height: 24, viewBox: '0 0 24 24', paths: [{ d: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z', stroke: '#2563eb', strokeWidth: 2 }] },
            { type: 'text', name: 'Brand name', text: 'Brewline', fontWeight: 600, color: '#0f172a' },
          ],
        },
        {
          type: 'frame', name: 'CTA', fill: '#2563eb', radius: 8, layout: { direction: 'row', padding: [8, 16] },
          children: [{ type: 'text', text: 'Start free', fontSize: 14, fontWeight: 500, color: '#ffffff' }],
        },
      ],
    },
    {
      type: 'frame', name: 'Hero', width: 'fill', height: 'fill', layout: { direction: 'column', gap: 24, padding: [64, 32] },
      children: [
        { type: 'text', name: 'Headline', text: `${headline}, ordered ahead of the queue`, width: 560, fontSize: 48, fontWeight: 700, lineHeight: 56, color: '#0f172a' },
        {
          type: 'frame', name: 'Cards', layout: { direction: 'row', gap: 16 },
          children: [
            {
              type: 'frame', name: 'Card one', width: 280, radius: 12, layout: { direction: 'column', padding: 24 },
              fill: { type: 'linear', angle: 90, stops: [{ at: 0, color: '#fbbf24' }, { at: 1, color: '#f43f5e' }] },
              shadows: [{ x: 0, y: 8, blur: 24, spread: -4, color: '#0f172a33' }],
              children: [{ type: 'text', text: 'Card one', color: '#ffffff', fontWeight: 600 }],
            },
            {
              type: 'frame', name: 'Card two', width: 280, fill: '#ffffff', radius: [12, 12, 0, 0], stroke: { color: '#e2e8f0', width: 1 }, clip: true,
              layout: { direction: 'column', gap: 12, padding: 24 },
              children: [
                { type: 'text', text: 'Card two' },
                { type: 'line', width: 'fill', stroke: { color: '#e2e8f0', width: 1 } },
                { type: 'ellipse', width: 12, height: 12, fill: '#22c55e' },
              ],
            },
          ],
        },
      ],
    },
  ],
});

const PRICING = {
  type: 'frame', name: 'Pricing', x: 1440, y: 0, width: 390, height: 600, fill: '#ffffff',
  children: [
    { type: 'text', name: 'Title', x: 24, y: 24, text: 'Pricing', fontSize: 28, fontWeight: 700 },
    { type: 'rect', name: 'Plan', x: 24, y: 80, width: 342, height: 120, fill: '#eef2ff', radius: 16, opacity: 0.8 },
  ],
};

const textsOf = (node) => [...(node.type === 'text' ? [node.text] : []), ...(node.children || []).flatMap(textsOf)];
const squash = (s) => s.replace(/\s+/g, ' ').trim();

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-canvas-'));
  const home = path.join(base, 'home');
  const proj = path.join(base, 'shop');
  const out = path.join(base, 'exports');
  const canvas = path.join(proj, '.conn', 'canvas');
  for (const d of [home, canvas, out]) fs.mkdirSync(d, { recursive: true });
  const write = (file, doc) => fs.writeFileSync(path.join(canvas, file), typeof doc === 'string' ? doc : JSON.stringify(doc, null, 2));
  write('landing.json', LANDING('Coffee'));
  write('pricing.json', PRICING);
  fs.mkdirSync(path.join(home, '.conn'), { recursive: true });
  fs.writeFileSync(path.join(home, '.conn', 'open-projects.json'), JSON.stringify([proj]));
  const readFrame = (file) => JSON.parse(fs.readFileSync(path.join(canvas, file), 'utf8'));
  return { base, home, proj, canvas, out, write, readFrame };
}

async function target(port, pick) {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const hit = list.find(pick);
      if (hit) return hit.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error(`nothing to debug on ${port}`);
}

function connect(url) {
  const ws = new WebSocket(url);
  let seq = 0;
  const waiting = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++seq;
    waiting.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const run = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails));
    return res.result?.result?.value;
  };
  const evaluate = (fn, ...args) => run(`(${fn})(...${JSON.stringify(args)})`);
  return new Promise((resolve) => { ws.onopen = () => resolve({ ws, send, run, evaluate }); });
}

async function until(page, fn, arg, ms = 8000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await page.evaluate(fn, arg);
    if (last) return last;
    await sleep(150);
  }
  return last;
}

async function untilFile(fn, ms = 5000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { last = fn(); } catch { last = null; }
    if (last) return last;
    await sleep(150);
  }
  return last;
}

// ------------------------------------------------------------------ input

const SHIFT = 8;
const CTRL = 2;

const mouse = (page, type, x, y, extra = {}) => page.send('Input.dispatchMouseEvent', {
  type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra,
});

async function click(page, p, modifiers = 0) {
  await mouse(page, 'mouseMoved', p.x, p.y, { button: 'none', buttons: 0, modifiers });
  await mouse(page, 'mousePressed', p.x, p.y, { modifiers });
  await mouse(page, 'mouseReleased', p.x, p.y, { modifiers });
  await sleep(120);
}

async function drag(page, from, to, modifiers = 0) {
  await mouse(page, 'mouseMoved', from.x, from.y, { button: 'none', buttons: 0, modifiers });
  await mouse(page, 'mousePressed', from.x, from.y, { modifiers });
  for (let i = 1; i <= 6; i++) {
    await mouse(page, 'mouseMoved', from.x + ((to.x - from.x) * i) / 6, from.y + ((to.y - from.y) * i) / 6, { modifiers });
    await sleep(16);
  }
  await mouse(page, 'mouseReleased', to.x, to.y, { modifiers });
  await sleep(150);
}

const wheel = (page, p, deltaX, deltaY, modifiers = 0) =>
  page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: p.x, y: p.y, deltaX, deltaY, modifiers }).then(() => sleep(120));

async function key(page, k, code, vk) {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
  await sleep(150);
}

// ------------------------------------------------------------------ board reads

function boardState() {
  const world = document.querySelector('#canvas-view [data-canvas-world]');
  const board = document.querySelector('#canvas-view [data-canvas-board]');
  if (!world || !board) return null;
  const m = world.style.transform.match(/translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/);
  const frames = {};
  for (const el of document.querySelectorAll('#canvas-view [data-frame]')) {
    const r = el.firstElementChild.getBoundingClientRect();
    frames[el.dataset.frame] = { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  }
  const b = board.getBoundingClientRect();
  return {
    v: m && { x: +m[1], y: +m[2], zoom: +m[3] },
    board: { x: b.left, y: b.top, w: b.width, h: b.height },
    frames,
    selected: document.querySelectorAll('#canvas-view .border-2').length,
    header: document.querySelector('#canvas-view')?.firstElementChild.textContent,
    errors: document.querySelector('#canvas-view [data-canvas-errors]')?.textContent || '',
  };
}

async function exportVia(page, label) {
  return page.evaluate(async (want) => {
    const trigger = [...document.querySelectorAll('#canvas-view button')].find((b) => b.textContent.trim() === 'Export');
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    const menu = '[data-slot="dropdown-menu-content"] [role="menuitem"]';
    for (let i = 0; i < 20 && !document.querySelector(menu); i++) await new Promise((r) => setTimeout(r, 50));
    const items = [...document.querySelectorAll(menu)];
    const item = items.find((m) => m.textContent.trim() === want);
    if (!item) return items.map((m) => m.textContent.trim()).join(' | ') || 'menu did not open';
    item.click();
    await new Promise((r) => setTimeout(r, 500));
    return true;
  }, label).then((res) => check(`export-menu-${label}`, res === true, res));
}

async function renderJsx(code) {
  const { transformSync } = await import('rolldown/experimental');
  const { parseAst } = await import('rolldown/parseAst');
  parseAst(code, { lang: 'jsx' });
  const out = transformSync('design.jsx', code, { jsx: { runtime: 'classic' } });
  if (out.errors.length) throw new Error(out.errors.map((e) => e.message).join('\n'));
  const React = require(path.join(ROOT, 'node_modules', 'react'));
  const { renderToStaticMarkup } = require(path.join(ROOT, 'node_modules', 'react-dom', 'server'));
  const exports = {};
  const warnings = [];
  const error = console.error;
  console.error = (...a) => warnings.push(a.join(' '));
  try {
    new Function('React', 'exports', out.code.replace(/export function (\w+)/g, 'exports.$1 = function $1'))(React, exports);
    const html = Object.fromEntries(Object.entries(exports).map(([name, C]) => [name, renderToStaticMarkup(React.createElement(C))]));
    return { html, warnings };
  } finally {
    console.error = error;
  }
}

const textOfHtml = (html) => squash(html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&'));

async function main() {
  const fx = fixture();
  const electron = require(path.join(ROOT, 'node_modules', 'electron'));
  const app = spawn(electron, [
    `--inspect=${INSPECT}`, ROOT, `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(fx.base, 'userdata')}`, '--no-sandbox',
  ], { env: { ...process.env, HOME: fx.home, CONN_CWD: fx.proj }, stdio: 'ignore' });

  try {
    const main = await connect(await target(INSPECT, (t) => t.type === 'node'));
    await main.run(`(() => {
      const req = process.getBuiltinModule('module').createRequire(${JSON.stringify(path.join(ROOT, 'src/main/index.js'))});
      const { dialog, ipcMain } = req('electron');
      const path = req('path');
      dialog.showSaveDialog = async (_win, o) => ({ canceled: false, filePath: path.join(${JSON.stringify(fx.out)}, path.basename(o.defaultPath)) });
      ipcMain.removeHandler('agent:send');
      ipcMain.handle('agent:send', (_e, a) => { globalThis.__sent = a.text; return { error: 'captured by the canvas repro' }; });
      return true;
    })()`);

    const page = await connect(await target(PORT, (t) => t.type === 'page' && /index\.html/.test(t.url)));
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    await page.evaluate(async () => {
      for (let i = 0; i < 60 && !window.connChat; i++) await new Promise((r) => setTimeout(r, 250));
      await new Promise((r) => setTimeout(r, 1000));
    });

    // ---------------------------------------------------------------- opens

    await page.evaluate(() => window.connChat.design());
    const tabs = await until(page, () => {
      const t = [...document.querySelectorAll('section#right [role="tab"]')].map((x) => x.textContent.trim());
      return t.includes('Canvas') && t;
    });
    check('canvas-tab-opens', Array.isArray(tabs), `tabs=${tabs}`);
    const badge = await until(page, () => document.querySelector('#agent-root [contenteditable="true"] .tok-conn')?.dataset.raw || null, null, 2000);
    check('design-inserts-canvas-mention', badge === '$canvas', `badge=${badge}`);
    await page.evaluate(() => window.connChat.design());
    await sleep(200);
    const badges = await page.evaluate(() => document.querySelectorAll('#agent-root [contenteditable="true"] .tok-conn').length);
    check('design-twice-inserts-once', badges === 1, `badges=${badges}`);

    // ---------------------------------------------------------------- draws

    const read = () => page.run(`(${boardState})()`);
    const drawn = await (async () => {
      for (let i = 0; i < 60; i++) {
        const s = await read();
        if (s?.v && s.v.zoom !== 1 && Object.keys(s.frames).length === 2 && s.frames['landing.json']?.w > 0) return s;
        await sleep(150);
      }
      return read();
    })();
    check('board-renders-frames-from-json', drawn && Object.keys(drawn.frames).length === 2, JSON.stringify(drawn?.frames));

    const styled = await page.evaluate(() => {
      const root = document.querySelector('#canvas-view [data-frame="landing.json"]').firstElementChild;
      const all = [...root.querySelectorAll('div')];
      const find = (t) => all.find((d) => d.firstChild?.nodeType === 3 && d.textContent === t);
      const cardOne = find('Card one').parentElement;
      const header = root.firstElementChild;
      const headline = all.find((d) => d.textContent.startsWith('Coffee'));
      const cs = (el) => getComputedStyle(el);
      return {
        gradient: cs(cardOne).backgroundImage,
        shadow: cs(cardOne).boxShadow,
        headerFlex: cs(header).display + ' ' + cs(header).justifyContent,
        headerWidth: header.getBoundingClientRect().width / root.getBoundingClientRect().width,
        headlineLines: Math.round(headline.getBoundingClientRect().height / (56 * (root.getBoundingClientRect().width / 1280))),
        svg: !!root.querySelector('svg path[stroke="#2563eb"]'),
        pricingTitle: getComputedStyle([...document.querySelectorAll('#canvas-view [data-frame="pricing.json"] div')].find((d) => d.firstChild?.nodeType === 3 && d.textContent === 'Pricing')).position,
      };
    });
    check('gradient-fill', /linear-gradient/.test(styled.gradient), styled.gradient);
    check('shadow', /rgba\(15, 23, 42, 0\.2/.test(styled.shadow), styled.shadow);
    check('auto-layout', styled.headerFlex === 'flex space-between' && Math.abs(styled.headerWidth - 1) < 0.01, JSON.stringify(styled));
    check('text-wraps-at-width', styled.headlineLines >= 2, `lines=${styled.headlineLines}`);
    check('vector-draws', styled.svg);
    check('absolute-children', styled.pricingTitle === 'absolute', styled.pricingTitle);

    const labels = await page.evaluate(() => document.querySelector('#canvas-view [data-canvas-board]').textContent);
    check('frame-labels', labels.includes('Landing') && labels.includes('Pricing'), labels);
    const inView = (s, f) => s.frames[f].x >= s.board.x - 1 && s.frames[f].x + s.frames[f].w <= s.board.x + s.board.w + 1;
    check('opens-fitted', drawn.v.zoom <= 1 && inView(drawn, 'landing.json') && inView(drawn, 'pricing.json'), JSON.stringify(drawn.v));

    // ---------------------------------------------------------------- pan, zoom

    const center = { x: Math.round(drawn.board.x + drawn.board.w / 2), y: Math.round(drawn.board.y + drawn.board.h / 2) };
    await wheel(page, center, 40, 30);
    const panned = await read();
    check('wheel-pans', Math.abs(panned.v.x - (drawn.v.x - 40)) < 0.5 && Math.abs(panned.v.y - (drawn.v.y - 30)) < 0.5, `${JSON.stringify(drawn.v)} -> ${JSON.stringify(panned.v)}`);

    const at = { x: Math.round(panned.frames['landing.json'].x + 100), y: Math.round(panned.frames['landing.json'].y + 80) };
    const boardPt = (s) => ({ x: (at.x - s.board.x - s.v.x) / s.v.zoom, y: (at.y - s.board.y - s.v.y) / s.v.zoom });
    await wheel(page, at, 0, -60, CTRL);
    const zoomed = await read();
    const [p0, p1] = [boardPt(panned), boardPt(zoomed)];
    check('ctrl-wheel-zooms', zoomed.v.zoom > panned.v.zoom * 1.2, `${panned.v.zoom} -> ${zoomed.v.zoom}`);
    check('zoom-keeps-point-under-cursor', Math.abs(p0.x - p1.x) < 0.5 && Math.abs(p0.y - p1.y) < 0.5, `${JSON.stringify(p0)} vs ${JSON.stringify(p1)}`);
    check('zoom-percent-shown', zoomed.header.includes(`${Math.round(zoomed.v.zoom * 100)}%`), zoomed.header);

    // An empty-board drag is a marquee, so pan with space held.
    await page.evaluate(() => document.querySelector('#canvas-view [data-canvas-board]').focus());
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
    const beforeSpace = await read();
    await drag(page, center, { x: center.x - 50, y: center.y + 20 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
    const spaced = await read();
    check('space-drag-pans', Math.abs(spaced.v.x - (beforeSpace.v.x - 50)) < 1 && Math.abs(spaced.v.y - (beforeSpace.v.y + 20)) < 1, `${JSON.stringify(beforeSpace.v)} -> ${JSON.stringify(spaced.v)}`);

    await page.evaluate(() => document.querySelector('#canvas-view [data-canvas-board]').focus());
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: '!', code: 'Digit1', windowsVirtualKeyCode: 49, modifiers: SHIFT });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: '!', code: 'Digit1', windowsVirtualKeyCode: 49, modifiers: SHIFT });
    await sleep(150);
    const refit = await read();
    check('shift-1-fits', inView(refit, 'landing.json') && inView(refit, 'pricing.json'), JSON.stringify(refit.v));

    // ---------------------------------------------------------------- select

    await click(page, { x: refit.frames['landing.json'].cx, y: refit.frames['landing.json'].cy });
    let s = await read();
    check('click-selects', s.selected === 1, `selected outlines ${s.selected}`);
    const chipOne = await until(page, () => [...document.querySelectorAll('#agent-root [data-slot="badge"]')].map((b) => b.textContent).find((t) => t.includes('Landing')) || null, null, 2000);
    check('selection-chip-in-composer', !!chipOne, 'no Landing chip');

    await click(page, { x: s.frames['pricing.json'].cx, y: s.frames['pricing.json'].cy }, SHIFT);
    s = await read();
    check('shift-click-adds', s.selected === 2 && s.header.includes('2 selected'), s.header);
    check('selection-chip-counts', await page.evaluate(() => document.querySelector('#agent-root').textContent.includes('2 frames')));

    await click(page, { x: s.board.x + 8, y: s.board.y + s.board.h - 8 });
    s = await read();
    check('empty-click-clears', s.selected === 0, `selected ${s.selected}`);

    const tl = { x: s.frames['landing.json'].x - 10, y: s.frames['landing.json'].y + s.frames['landing.json'].h + 10 };
    await drag(page, tl, { x: s.frames['pricing.json'].x + 10, y: s.frames['pricing.json'].y + 10 });
    s = await read();
    check('marquee-selects', s.selected === 2, `selected ${s.selected}`);

    // ---------------------------------------------------------------- prompt

    await click(page, { x: s.frames['landing.json'].cx, y: s.frames['landing.json'].cy });
    await page.evaluate(() => document.querySelector('#agent-root [contenteditable="true"]').focus());
    await page.send('Input.insertText', { text: 'make this darker' });
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    const sent = await (async () => {
      for (let i = 0; i < 40; i++) {
        const t = await main.run('globalThis.__sent || null');
        if (t) return t;
        await sleep(150);
      }
      return '';
    })();
    check('prompt-names-selected-frame', sent.includes('[conn canvas selection]') && sent.includes('.conn/canvas/landing.json  (Landing)') && !sent.includes('pricing.json'), sent.slice(0, 400));
    check('prompt-carries-schema-brief', sent.split('[conn canvas] $canvas').length === 2 && sent.includes('"type":"frame"') && sent.includes('vector {viewBox'), sent.slice(0, 200));
    check('prompt-places-new-frames-clear', /placed at x 1990, y 0/.test(sent), (sent.match(/placed at[^,]*,[^,]*/) || [''])[0]);
    check('prompt-ends-with-request', sent.trim().endsWith('make this darker'), sent.slice(-80));
    check('selection-survives-send', await page.evaluate(() => document.querySelector('#agent-root').textContent.includes('Landing')));

    // ---------------------------------------------------------------- move, resize

    s = await read();
    const z = s.v.zoom;
    await drag(page, { x: s.frames['landing.json'].cx, y: s.frames['landing.json'].cy }, { x: s.frames['landing.json'].cx + 100, y: s.frames['landing.json'].cy + 50 });
    const moved = await untilFile(() => { const f = fx.readFrame('landing.json'); return f.x !== 0 ? f : null; });
    check('drag-persists-to-file', moved && Math.abs(moved.x - 100 / z) <= 1 && Math.abs(moved.y - 50 / z) <= 1, `x=${moved?.x} y=${moved?.y} want ${100 / z}, ${50 / z}`);
    check('drag-keeps-content', moved && moved.children?.length === 2 && moved.name === 'Landing', 'file content changed');

    s = await read();
    await click(page, { x: s.frames['pricing.json'].cx, y: s.frames['pricing.json'].cy });
    s = await read();
    const se = { x: s.frames['pricing.json'].x + s.frames['pricing.json'].w, y: s.frames['pricing.json'].y + s.frames['pricing.json'].h };
    await drag(page, se, { x: se.x + 60, y: se.y + 40 });
    const sized = await untilFile(() => { const f = fx.readFrame('pricing.json'); return f.width !== 390 ? f : null; });
    check('resize-persists-to-file', sized && Math.abs(sized.width - (390 + 60 / z)) <= 1 && Math.abs(sized.height - (600 + 40 / z)) <= 1 && sized.x === 1440, JSON.stringify(sized && { x: sized.x, w: sized.width, h: sized.height }));
    await sleep(700);
    s = await read();
    check('no-snap-back', Math.abs(s.frames['pricing.json'].w - sized.width * s.v.zoom) < 1.5, `${s.frames['pricing.json'].w} vs ${sized.width * s.v.zoom}`);

    // ---------------------------------------------------------------- live reload

    const vBefore = s.v;
    fx.write('pricing.json', { ...fx.readFrame('pricing.json'), children: [{ ...PRICING.children[0], text: 'Plans and pricing' }, PRICING.children[1]] });
    const reloaded = await until(page, () => [...document.querySelectorAll('#canvas-view [data-frame="pricing.json"] div')].some((d) => d.textContent === 'Plans and pricing') || null, null, 4000);
    s = await read();
    check('agent-edit-redraws', reloaded === true, 'text never changed');
    check('agent-edit-keeps-viewport', JSON.stringify(s.v) === JSON.stringify(vBefore), `${JSON.stringify(vBefore)} -> ${JSON.stringify(s.v)}`);
    check('agent-edit-keeps-selection', s.selected === 1 && s.header.includes('1 selected'), s.header);

    // ---------------------------------------------------------------- errors

    fx.write('pricing.json', '{ "type": "frame", "name": "Pricing", ');
    const broken = await until(page, () => document.querySelector('#canvas-view [data-canvas-errors]')?.textContent || null, null, 4000);
    check('invalid-json-shows-error', /pricing\.json is not valid JSON/.test(broken || ''), broken);
    s = await read();
    check('invalid-json-keeps-last-frame', !!s.frames['pricing.json'] && /last version that worked/.test(broken || ''), JSON.stringify(Object.keys(s.frames)));

    fx.write('pricing.json', { ...PRICING, children: [{ type: 'rect', fills: '#fff' }, { type: 'txt' }] });
    const invalid = await until(page, () => {
      const t = document.querySelector('#canvas-view [data-canvas-errors]')?.textContent || '';
      return t.includes('Unrecognized') ? t : null;
    }, null, 4000);
    check('schema-error-is-readable', /children\[0\]: Unrecognized key: "fills"/.test(invalid || '') && /children\[1\]\.type: Invalid discriminator value/.test(invalid || ''), invalid);

    fx.write('broken-new.json', '[');
    const lone = await until(page, () => (document.querySelector('#canvas-view [data-canvas-errors]')?.textContent || '').includes('broken-new.json') || null, null, 4000);
    check('never-valid-file-listed', lone === true, 'no error for broken-new.json');
    fs.rmSync(path.join(fx.canvas, 'broken-new.json'));
    fx.write('pricing.json', PRICING);
    const healed = await until(page, () => !document.querySelector('#canvas-view [data-canvas-errors]') || null, null, 4000);
    check('fixed-file-clears-error', healed === true, 'errors still shown');

    // ---------------------------------------------------------------- duplicate, delete

    await until(page, () => document.querySelector('#canvas-view [data-frame="pricing.json"]') || null, null, 3000);
    await sleep(600);
    s = await read();
    await click(page, { x: s.frames['pricing.json'].cx, y: s.frames['pricing.json'].cy });
    await page.evaluate(() => document.querySelector('#canvas-view button[title="Duplicate"]').click());
    const copy = await untilFile(() => (fs.existsSync(path.join(fx.canvas, 'pricing-copy.json')) ? fx.readFrame('pricing-copy.json') : null));
    const landingNow = fx.readFrame('landing.json');
    check('duplicate-writes-new-file', copy && copy.name === 'Pricing copy' && copy.children.length === 2, JSON.stringify(copy && { name: copy.name }));
    check('duplicate-lands-clear', copy && copy.x >= Math.max(landingNow.x + landingNow.width, 1440 + 390), `x=${copy?.x}`);
    const copySelected = await until(page, () => (document.querySelector('#canvas-view')?.firstElementChild.textContent.includes('3 frames, 1 selected') ? true : null), null, 3000);
    check('duplicate-is-selected', copySelected === true, 'copy not selected');
    await page.evaluate(() => document.querySelector('#canvas-view [data-canvas-board]').focus());
    await key(page, 'Delete', 'Delete', 46);
    const gone = await untilFile(() => !fs.existsSync(path.join(fx.canvas, 'pricing-copy.json')));
    check('delete-moves-to-trash', gone === true, 'pricing-copy.json still there');

    // ---------------------------------------------------------------- export

    await until(page, () => document.querySelectorAll('#canvas-view [data-frame]').length === 2 || null, null, 3000);
    await page.evaluate(() => document.querySelector('#canvas-view [data-canvas-board]').focus());
    await key(page, 'Escape', 'Escape', 27);
    await page.evaluate(() => {
      window.__copied = null;
      navigator.clipboard.writeText = async (t) => { window.__copied = t; };
    });

    const allTexts = [...textsOf(LANDING('Coffee')), ...textsOf(PRICING)];
    await exportVia(page, 'Copy React + Tailwind');
    const jsx = await page.evaluate(() => window.__copied || '');
    check('react-one-component-per-frame', /export function Landing\(\)/.test(jsx) && /export function Pricing\(\)/.test(jsx), jsx.slice(0, 120));
    check('react-uses-tailwind', /className="relative w-\[1280px\] h-\[820px\]/.test(jsx) && jsx.includes('bg-[linear-gradient(90deg,_#fbbf24_0%,_#f43f5e_100%)]') && jsx.includes('justify-between'), jsx.slice(0, 300));
    try {
      const { html, warnings } = await renderJsx(jsx);
      const all = Object.values(html).map(textOfHtml).join(' ');
      check('react-export-renders', Object.keys(html).length === 2 && Object.values(html).every(Boolean), Object.keys(html).join());
      check('react-export-has-all-text', allTexts.every((t) => all.includes(squash(t))), all);
      check('react-no-warnings', !warnings.length, warnings.join('\n'));
    } catch (e) {
      check('react-export-renders', false, e.message);
    }

    await exportVia(page, 'Copy for Figma');
    const svg = await page.evaluate(() => {
      const text = window.__copied || '';
      const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
      return {
        text,
        parsed: !doc.querySelector('parsererror'),
        width: doc.documentElement.getAttribute('width'),
        texts: [...doc.querySelectorAll('text')].map((t) => [...t.querySelectorAll('tspan')].map((s) => s.textContent).join(' ')),
        headlineLines: [...doc.querySelectorAll('text')].find((t) => t.textContent.startsWith('Coffee'))?.querySelectorAll('tspan').length,
        stops: [...doc.querySelectorAll('linearGradient stop')].map((st) => st.getAttribute('stop-color')),
        shadows: doc.querySelectorAll('filter feGaussianBlur').length,
        spread: doc.querySelectorAll('filter feMorphology[operator="erode"]').length,
        clips: doc.querySelectorAll('clipPath').length,
        layers: ['Landing', 'Header', 'CTA', 'Card_one', 'Logo', 'Pricing'].filter((id) => !doc.getElementById(id)),
        corners: !!doc.querySelector('path[d*="A12 12"]'),
      };
    });
    fs.writeFileSync(path.join(fx.out, 'clipboard.svg'), svg.text);
    check('svg-parses', svg.parsed && svg.text.startsWith('<svg'), svg.text.slice(0, 120));
    check('svg-contains-all-text', allTexts.every((t) => svg.texts.some((x) => squash(x) === squash(t))), JSON.stringify(svg.texts));
    check('svg-keeps-line-breaks', svg.headlineLines >= 2, `tspans=${svg.headlineLines}`);
    const L = fx.readFrame('landing.json');
    const wide = Math.max(L.x + L.width, PRICING.x + PRICING.width) - Math.min(L.x, PRICING.x);
    check('svg-spans-exported-frames', Number(svg.width) === wide, `width=${svg.width} want ${wide}`);
    check('svg-gradient-stops', svg.stops.join() === '#fbbf24,#f43f5e', svg.stops.join());
    check('svg-shadow-with-spread', svg.shadows >= 1 && svg.spread === 1, `blur=${svg.shadows} erode=${svg.spread}`);
    check('svg-clips', svg.clips >= 3, `clipPaths=${svg.clips}`);
    check('svg-named-layers', !svg.layers.length, `missing ${svg.layers}`);
    check('svg-per-corner-radius', svg.corners, 'no per-corner path');
    check('svg-srgb-only', !/oklch|oklab|currentColor|#[0-9a-f]{8}"/i.test(svg.text), 'found a colour Figma may not read');

    s = await read();
    await click(page, { x: s.frames['pricing.json'].cx, y: s.frames['pricing.json'].cy });
    for (const label of ['Save React + Tailwind…', 'Save HTML…', 'Save SVG for Figma…']) await exportVia(page, label);
    await sleep(400);
    const saved = (f) => (fs.existsSync(path.join(fx.out, f)) ? fs.readFileSync(path.join(fx.out, f), 'utf8') : '');
    check('saves-selection-only', /export function Pricing\(\)/.test(saved('pricing.jsx')) && !saved('pricing.jsx').includes('Landing'), saved('pricing.jsx').slice(0, 80));
    check('html-export-standalone', saved('pricing.html').startsWith('<!doctype html>') && saved('pricing.html').includes('Pricing') && !/<script/.test(saved('pricing.html')), `${saved('pricing.html').length} bytes`);
    check('svg-export-saved', saved('pricing.svg').startsWith('<svg') && saved('pricing.svg').includes('>Pricing<'), 'pricing.svg missing');

    if (process.env.CONN_SHOT) {
      await page.evaluate(() => document.querySelectorAll('[data-sonner-toaster]').forEach((t) => t.remove()));
      await sleep(300);
      const { result } = await page.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(process.env.CONN_SHOT, Buffer.from(result.data, 'base64'));
      console.log(`screenshot ${process.env.CONN_SHOT}`);
    }

    page.ws.close();
    main.ws.close();
  } finally {
    const exited = new Promise((r) => app.once('exit', r));
    app.kill();
    const stuck = setTimeout(() => app.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(stuck);
    if (process.env.CONN_KEEP) console.log(`kept ${fx.base}`);
    else fs.rmSync(fx.base, { recursive: true, force: true, maxRetries: 5 });
  }

  console.log(failures.length ? `\n${failures.length} failed` : '\nall passed');
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
