#!/usr/bin/env node
// node chat-perf.mjs --root <checkout> --scenario <replay400|stream|resize|search|notify> [--runs 1]
// Prints one JSON line per run: {scenario, root, gitHead, metric, value, unit, extra}.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function args(argv) {
  const out = { runs: 1 };
  for (let i = 0; i < argv.length; i++) {
    const [name, inline] = argv[i].replace(/^--/, '').split(/=(.*)/s);
    out[name] = inline ?? argv[++i];
  }
  return out;
}

const opts = args(process.argv.slice(2));
const root = opts.root && path.resolve(opts.root);
const SCENARIO_NAMES = ['replay400', 'stream', 'resize', 'search', 'notify'];
if (!root || !SCENARIO_NAMES.includes(opts.scenario)) {
  console.error(`usage: node chat-perf.mjs --root <checkout> --scenario <${SCENARIO_NAMES.join('|')}> [--runs 1]`);
  process.exit(2);
}
const driverPath = path.join(root, '.claude/skills/verify/drive.mjs');
if (!fs.existsSync(driverPath)) { console.error(`no verify driver at ${driverPath}`); process.exit(2); }
if (!fs.existsSync(path.join(root, 'build/renderer/index.html'))) {
  console.error(`no renderer build in ${root}/build/renderer: run \`npx vite build\` in ${root} first`);
  process.exit(2);
}

const newest = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((m, e) => {
  const full = path.join(dir, e.name);
  return Math.max(m, e.isDirectory() ? newest(full) : fs.statSync(full).mtimeMs);
}, 0);
if (newest(path.join(root, 'src/renderer')) > newest(path.join(root, 'build/renderer'))) {
  console.error(`warning: ${root}/build/renderer is older than src/renderer; the numbers measure the old build`);
}

const drive = await import(pathToFileURL(driverPath).href);
const gitHead = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

const inPage = (s, expr) => drive.evaluate(s, expr, { awaitPromise: true });
const inMain = (s, expr) => drive.evaluate(s, expr, { main: true, awaitPromise: true });
const pollPage = async (s, expr, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await inPage(s, expr);
    if (v) return v;
    await sleep(100);
  }
  return null;
};
const pct = (xs, p) => {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};
const round = (n) => (n == null ? null : Math.round(n * 10) / 10);

/* Fixture transcripts, in the shape the claude CLI writes to
   ~/.claude/projects/<slug>/<id>.jsonl (see src/main/history.js). */
const slugFor = (cwd) => cwd.replace(/[/.]/g, '-');
const transcriptDir = (s) => path.join(s.home, '.claude', 'projects', slugFor(s.project));
const uuid = (n, tag = 0) => `${tag.toString(16).padStart(8, '0')}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const markdown = (i) => `### Step ${i}\n\nChecking the **cart total** in \`index.html\` before the _coupon_ applies.\n\n- parse the subtotal\n- apply \`SAVE10\`\n- redraw the summary\n\n\`\`\`js\nfunction total(items) {\n  return items.reduce((sum, it) => sum + it.price * it.qty, ${i});\n}\n\`\`\`\n\nThat leaves [the summary](https://example.com/${i}) in step with the list.`;
const TOOLS = [
  (i) => ({ name: 'Read', input: { file_path: `/srv/shop/src/cart-${i}.js` }, output: Array.from({ length: 12 }, (_, k) => `${k + 1}\tconst line${k} = ${i * k};`).join('\n') }),
  (i) => ({ name: 'Bash', input: { command: `npm test -- cart-${i}` }, output: `PASS cart-${i}.test.js\n  total\n    ok adds items (3 ms)\n    ok applies SAVE10 (1 ms)\nTests: 2 passed` }),
  (i) => ({ name: 'Edit', input: { file_path: `/srv/shop/src/cart-${i}.js`, old_string: 'qty', new_string: 'quantity' }, output: 'The file has been updated.' }),
];

/* Four messages per cycle replay to four items: a user prompt, an assistant
   text, a tool row (its result folds into it), and a closing assistant text. */
function transcript({ id, cwd, cycles, title, marker, bodyWord = '' }) {
  const lines = [];
  const at = Date.now() - cycles * 4000;
  const line = (type, content, n) => J({
    type, isSidechain: false, sessionId: id, cwd, uuid: uuid(n, 1), parentUuid: n ? uuid(n - 1, 1) : null,
    timestamp: new Date(at + n * 1000).toISOString(),
    message: type === 'user' ? { role: 'user', content } : { id: `msg_${n}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content },
  });
  for (let c = 0; c < cycles; c++) {
    const tool = TOOLS[c % TOOLS.length](c);
    const call = `toolu_${id.slice(-6)}_${c}`;
    const last = c === cycles - 1;
    lines.push(line('user', c === 0 ? title : `Next, step ${c} ${bodyWord}`, lines.length));
    lines.push(line('assistant', [{ type: 'text', text: markdown(c) }, { type: 'tool_use', id: call, name: tool.name, input: tool.input }], lines.length));
    lines.push(line('user', [{ type: 'tool_result', tool_use_id: call, content: tool.output }], lines.length));
    lines.push(line('assistant', [{ type: 'text', text: last ? `All ${cycles} steps done. ${marker}` : `Step ${c} is green. ${bodyWord}` }], lines.length));
  }
  return `${lines.join('\n')}\n`;
}

function writeTranscript(s, fields) {
  const dir = transcriptDir(s);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${fields.id}.jsonl`), transcript({ ...fields, cwd: s.project }));
}

const railHas = (s, title, ms) => pollPage(s, `(async () => { await window.connRail?.refresh(); return [...document.querySelectorAll('[title]')].some((e) => e.title === ${J(title)} && e.getBoundingClientRect().width > 0); })()`, ms);

/* A rAF loop in the page that records every frame delta and counts long
   tasks until stopped. */
const FRAMES_START = `(() => {
  const p = { deltas: [], longTasks: 0, longTaskMs: 0, running: true };
  p.obs = new PerformanceObserver((list) => { for (const e of list.getEntries()) { p.longTasks += 1; p.longTaskMs += e.duration; } });
  p.obs.observe({ type: 'longtask' });
  let last = performance.now();
  const tick = (t) => { p.deltas.push(t - last); last = t; if (p.running) requestAnimationFrame(tick); };
  requestAnimationFrame((t) => { last = t; requestAnimationFrame(tick); });
  window.__frames = p;
  return true;
})()`;
const FRAMES_STOP = `new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => {
  const p = window.__frames; p.running = false; p.obs.disconnect();
  done({ deltas: p.deltas, longTasks: p.longTasks, longTaskMs: p.longTaskMs });
})))`;

const composer = `document.querySelector('#agent-root [contenteditable="true"]')`;

// The first code block loads the highlighter, a one-off cost that would swamp what a scenario measures.
async function warm(s) {
  await drive.say(s, 'ready\n\n```js\nconst warm = 1;\n```\n\n- **list**');
  await sleep(1000);
}

const SCENARIOS = {
  async replay400(s) {
    const id = uuid(400, 0xabcdef);
    const title = 'Replay probe: four hundred items';
    const marker = 'PROBE-END-400';
    await warm(s);
    writeTranscript(s, { id, title, marker, cycles: 100 });
    if (!await railHas(s, title, 3000)) await drive.key(s, 'Ctrl+B');
    if (!await railHas(s, title, 10000)) throw new Error('the fixture chat never showed on the rail');
    // The clock starts on the click that opens the chat and stops on the frame after the last row is in the DOM.
    await inPage(s, `(() => {
      const root = document.querySelector('#agent-root');
      window.__replay = null;
      document.addEventListener('click', () => {
        const t0 = performance.now();
        const look = () => {
          if (!root.textContent.includes(${J(marker)})) return void requestAnimationFrame(look);
          requestAnimationFrame(() => requestAnimationFrame(() => {
            const text = root.textContent;
            window.__replay = { ms: performance.now() - t0, domNodes: root.querySelectorAll('*').length, prompts: text.split('Next, step').length - 1, closings: text.split('is green.').length - 1, trimmed: text.includes('earlier messages trimmed') };
          }));
        };
        look();
      }, { capture: true, once: true });
      return true;
    })()`);
    await drive.click(s, `css=[title=${J(title)}]`);
    const r = await pollPage(s, 'window.__replay', 30000);
    if (!r) throw new Error('the last replayed row never appeared');
    return { metric: 'replay400_open_to_last_row', value: round(r.ms), unit: 'ms', extra: { path: 'rail click on a fixture .jsonl', messages: 400, items: 400, promptsSeen: r.prompts, closingsSeen: r.closings, trimmed: r.trimmed, domNodes: r.domNodes } };
  },

  async stream(s) {
    await warm(s);
    const block = (i) => `Paragraph ${i} walks the **cart** and the \`SAVE10\` path.\n\n- item ${i}\n- total\n\n\`\`\`js\nconst t${i} = total(items);\n\`\`\`\n\n`;
    let text = '';
    for (let i = 0; text.length < 1500; i++) text += block(i);
    text = text.slice(0, 1500);
    const every = 50;
    await inPage(s, FRAMES_START);
    await drive.say(s, text, { stream: every, size: 40 });
    const f = await inPage(s, FRAMES_STOP);
    return {
      metric: 'stream_p95_frame', value: round(pct(f.deltas, 95)), unit: 'ms',
      extra: { longTasks: f.longTasks, longTaskMs: round(f.longTaskMs), frames: f.deltas.length, p50: round(pct(f.deltas, 50)), max: round(Math.max(...f.deltas)), chars: text.length, chunk: 40, everyMs: every },
    };
  },

  async resize(s) {
    fs.writeFileSync(path.join(s.project, 'index.html'), fs.readFileSync(path.join(s.project, 'index.html'), 'utf8').replace('Your cart', 'Your basket'));
    await drive.key(s, 'Ctrl+Shift+G');
    if (!await pollPage(s, `document.querySelector('section#right')?.innerText.includes('index.html')`, 10000)) throw new Error('Changes never listed index.html');
    const once = async (width) => {
      // Page and main share the wall clock, so both sides stamp timeOrigin + now.
      await inPage(s, `(() => {
        const rect = (sel) => { const r = document.querySelector(sel)?.getBoundingClientRect(); return r ? [r.x, r.y, r.width, r.height].map(Math.round).join(',') : 'none'; };
        let prev = rect('#agent') + '|' + rect('#right');
        let changedAt = null;
        let still = 0;
        window.__settle = null;
        const look = () => {
          const now = performance.timeOrigin + performance.now();
          const cur = rect('#agent') + '|' + rect('#right');
          if (cur !== prev) { prev = cur; changedAt = now; still = 0; } else if (innerWidth === ${width}) still += 1;
          if (innerWidth === ${width} && changedAt && still >= 3) window.__settle = { changedAt, seenAt: now, layout: cur };
          else requestAnimationFrame(look);
        };
        requestAnimationFrame(look);
        return true;
      })()`);
      const t0 = await inMain(s, `(() => { const t = performance.timeOrigin + performance.now(); electron.BrowserWindow.getAllWindows()[0].setContentSize(${width}, 900); return t; })()`);
      const r = await pollPage(s, 'window.__settle', 10000);
      if (!r) throw new Error(`the layout never settled at ${width} px`);
      return { ms: r.changedAt - t0, confirmedMs: r.seenAt - t0, layout: r.layout };
    };
    const narrow = await once(800);
    const wide = await once(1440);
    return {
      metric: 'resize_settle_sum', value: round(narrow.ms + wide.ms), unit: 'ms',
      extra: { to800: round(narrow.ms), to1440: round(wide.ms), confirmedSum: round(narrow.confirmedMs + wide.confirmedMs), layout800: narrow.layout, layout1440: wide.layout },
    };
  },

  async search(s) {
    const word = 'zephyrine';
    const titled = 5;
    for (let i = 0; i < 50; i++) {
      writeTranscript(s, {
        id: uuid(i + 1, 0x5ea7c4), cycles: 6, marker: `end ${i}`, bodyWord: word,
        title: i < titled ? `Search probe ${i} about ${word} totals` : `Search probe ${i} about the coupon form`,
      });
    }
    const viaPreload = await inPage(s, `typeof window.conn?.agent?.search === 'function'`);
    const ipcName = await inMain(s, `[...(electron.ipcMain._invokeHandlers?.keys?.() || [])].find((k) => /^agent:.*search/i.test(k)) || null`);
    if (viaPreload) {
      const r = await inPage(s, `(async () => { const t0 = performance.now(); const res = await window.conn.agent.search(${J(word)}); return { ms: performance.now() - t0, res }; })()`);
      return { metric: 'search_ms', value: round(r.ms), unit: 'ms', extra: { method: 'window.conn.agent.search', bodySearch: true, results: Array.isArray(r.res) ? r.res.length : (r.res?.results?.length ?? r.res?.matches?.length ?? null), transcripts: 50 } };
    }
    if (ipcName) {
      const r = await inMain(s, `(async () => { const h = electron.ipcMain._invokeHandlers.get(${J(ipcName)}); const t0 = performance.now(); const res = await h({ sender: electron.BrowserWindow.getAllWindows()[0].webContents }, { query: ${J(word)}, q: ${J(word)} }); return { ms: performance.now() - t0, res }; })()`);
      return { metric: 'search_ms', value: round(r.ms), unit: 'ms', extra: { method: `ipc ${ipcName}`, bodySearch: true, results: Array.isArray(r.res) ? r.res.length : (r.res?.results?.length ?? r.res?.matches?.length ?? null), transcripts: 50 } };
    }
    // Opening the palette refreshes the rail store it filters, so wait for the fixture chats to land in it.
    await drive.key(s, 'Ctrl+K');
    const input = `document.querySelector('[cmdk-input]')`;
    if (!await pollPage(s, `document.activeElement === ${input} && [...document.querySelectorAll('[cmdk-item]')].some((e) => e.textContent.includes('Search probe'))`, 10000)) throw new Error('the palette did not open with the fixture chats in it');
    await inPage(s, `(() => {
      window.__search = null;
      const rows = () => [...document.querySelectorAll('[cmdk-group]')].filter((g) => /chats/i.test(g.querySelector('[cmdk-group-heading]')?.textContent || '')).flatMap((g) => [...g.querySelectorAll('[cmdk-item]')]);
      ${input}.addEventListener('input', () => {
        const t0 = performance.now();
        const look = () => {
          const hits = rows();
          if (!(hits.length === ${titled} && hits.every((r) => r.textContent.includes(${J(word)})))) return void requestAnimationFrame(look);
          requestAnimationFrame(() => { window.__search = { ms: performance.now() - t0, results: hits.length }; });
        };
        look();
      }, { capture: true, once: true });
      return true;
    })()`);
    await drive.type(s, word);
    const r = await pollPage(s, 'window.__search', 10000);
    if (!r) throw new Error('the palette never showed the titled chats');
    return {
      metric: 'search_ms', value: round(r.ms), unit: 'ms',
      extra: { method: 'palette title filter (no transcript search IPC or preload API found)', bodySearch: false, results: r.results, expectedTitleHits: titled, bodyHitsAvailable: 50, transcripts: 50 },
    };
  },

  async notify(s) {
    await drive.say(s, 'ready');
    await inMain(s, `(() => {
      const N = electron.Notification;
      globalThis.__notified = [];
      N.isSupported = () => true;
      N.prototype.show = function show() { globalThis.__notified.push({ at: performance.now(), title: this.title, body: this.body }); };
      const win = electron.BrowserWindow.getAllWindows()[0];
      win.isFocused = () => false;
      electron.BrowserWindow.getFocusedWindow = () => null;
      return true;
    })()`);
    await inPage(s, `${composer}.focus()`);
    await drive.type(s, 'Run the long job', { enter: true });
    await inMain(s, `globalThis.__agent.emit('message', { type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'Working on it.' }] } })`);
    await sleep(5500);
    await inMain(s, `(() => { const win = electron.BrowserWindow.getAllWindows()[0]; win.blur(); win.emit('blur'); return true; })()`);
    await inPage(s, `(() => { document.hasFocus = () => false; window.dispatchEvent(new Event('blur')); return true; })()`);
    await sleep(200);
    const t0 = await inMain(s, `(() => { const t = performance.now(); globalThis.__agent.emit('message', { type: 'result', subtype: 'success', duration_ms: 5700, is_error: false }); return t; })()`);
    const end = Date.now() + 3000;
    let hit = null;
    while (!hit && Date.now() < end) { hit = await inMain(s, 'globalThis.__notified[0] || null'); if (!hit) await sleep(50); }
    if (hit) return { metric: 'notify_ms', value: round(hit.at - t0), unit: 'ms', extra: { title: hit.title, body: hit.body, turnMs: 5700 } };
    const mainSrc = path.join(root, 'src/main');
    const usesNotification = fs.readdirSync(mainSrc, { recursive: true }).filter((f) => f.endsWith('.js'))
      .some((f) => /new Notification\b/.test(fs.readFileSync(path.join(mainSrc, f), 'utf8')));
    return { metric: 'notify_ms', value: null, unit: 'ms', extra: { reason: usesNotification ? 'no Notification.show within 3000 ms of the result' : 'no notification on trunk' } };
  },
};

let current = null;
const shutdown = async () => { if (current) { const s = current; current = null; await drive.stop(s).catch((e) => console.error(`stop failed: ${e.message}`)); } };
process.on('SIGINT', () => shutdown().then(() => process.exit(130)));
process.on('SIGTERM', () => shutdown().then(() => process.exit(143)));

let failed = false;
for (let run = 0; run < Number(opts.runs); run++) {
  const row = { scenario: opts.scenario, root, gitHead, metric: null, value: null, unit: null, extra: {} };
  try {
    current = await drive.boot({ root, xvfb: true });
    Object.assign(row, await SCENARIOS[opts.scenario](current));
  } catch (e) {
    failed = true;
    row.extra = { error: e.message };
  } finally {
    await shutdown();
  }
  console.log(J(row));
}
process.exit(failed ? 1 : 0);
