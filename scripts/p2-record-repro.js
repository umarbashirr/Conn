'use strict';
/* The `record` browser tool, driven the way an agent drives it, in the real
   app on a throwaway HOME. Checks that the video is of the preview pane (right
   size, right length, the page's own pixels in it), that it works with the pane
   closed and survives a screenshot of a hidden pane, that the limits and the
   file naming hold, that no permission card is raised, and that nothing outlives
   the app. Needs a built renderer (`npx vite build`), ffmpeg and ffprobe on the
   PATH for reading the result back, and a display: `xvfb-run -a node
   scripts/p2-record-repro.js`. */
const { execFileSync, spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
};

// Every pixel of the viewport is the state's colour, bar a button in the middle.
// Wherever a frame is the wrong size or blank, a corner says so.
const COLORS = [[220, 40, 40], [40, 180, 60], [50, 80, 230], [235, 200, 30]];
// Changes colour by itself, so a recording of it shows life without a click.
const TICKER = `<!doctype html><title>ticker</title>
<body style="margin:0"><script>
  const colors = ${JSON.stringify(COLORS)};
  let i = 0;
  setInterval(() => { document.body.style.background = 'rgb(' + colors[i++ % colors.length] + ')'; }, 400);
</script>`;
const PAGE = `<!doctype html><title>recorded</title>
<body style="margin:0;overflow:hidden">
<div id="bg" style="position:fixed;inset:0"></div>
<button id="next" style="position:fixed;left:50%;top:50%;width:160px;height:60px;margin:-30px 0 0 -80px;font-size:20px">Next</button>
<script>
  const colors = ${JSON.stringify(COLORS)};
  window.__i = Number(location.search.slice(1)) || 0;
  const paint = () => { document.getElementById('bg').style.background = 'rgb(' + colors[window.__i % colors.length] + ')'; };
  document.getElementById('next').addEventListener('click', () => { window.__i += 1; paint(); });
  paint();
</script>`;

async function target(port, pick) {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json();
      const hit = list.find(pick);
      if (hit) return hit.webSocketDebuggerUrl;
    } catch {}
    await sleep(500);
  }
  throw new Error(`nothing on ${port}`);
}

async function endpoints(app, userData) {
  let err = '';
  app.stderr.on('data', (d) => { err += d; });
  const file = path.join(userData, 'DevToolsActivePort');
  for (let i = 0; i < 120; i++) {
    const inspector = err.match(/Debugger listening on (ws:\/\/\S+)/)?.[1];
    const cdp = fs.existsSync(file) && Number(fs.readFileSync(file, 'utf8').split('\n')[0]);
    if (inspector && cdp) return { inspector, cdp };
    if (app.exitCode !== null || app.signalCode !== null) {
      throw new Error(`app exited (${app.exitCode ?? app.signalCode}) before its debug ports:\n${err.slice(-500)}`);
    }
    await sleep(250);
  }
  throw new Error(`no debug endpoints: ${err.slice(-300)}`);
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

async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(150);
  }
  return last;
}

const even = (n) => n - (n % 2);

function probe(file) {
  const out = JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-count_packets', '-show_entries', 'format=duration,format_name:stream=codec_name,width,height,nb_read_packets',
    '-show_entries', 'packet=pts_time', '-of', 'json', file,
  ], { encoding: 'utf8', maxBuffer: 1 << 26 }));
  const s = out.streams[0];
  let duration = Number(out.format.duration);
  // A WebM written by MediaRecorder has no duration in its header.
  if (!Number.isFinite(duration)) duration = Math.max(...out.packets.map((p) => Number(p.pts_time)));
  return { codec: s.codec_name, width: s.width, height: s.height, duration, container: out.format.format_name };
}

// The colour at (x, y) of the frame `at` seconds in; negative counts from the end.
function pixel(file, at, x, y) {
  const seek = at < 0 ? ['-sseof', String(at)] : ['-ss', String(at)];
  const r = spawnSync('ffmpeg', ['-v', 'error', ...seek, '-i', file, '-frames:v', '1',
    '-vf', `crop=2:2:${x}:${y},scale=1:1`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 20 });
  return r.stdout.length === 3 ? [...r.stdout] : null;
}

const near = (a, b, tol = 40) => !!a && a.every((v, i) => Math.abs(v - b[i]) <= tol);

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'build', 'renderer', 'index.html'))) throw new Error('no renderer build: run `npx vite build` first');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-record-'));
  const home = path.join(base, 'home');
  const proj = path.join(base, 'shop');
  // The recordings folder lives in the temp dir; keep this run's out of the machine's.
  const tmp = path.join(base, 'tmp');
  fs.mkdirSync(tmp);
  for (const d of [path.join(home, '.conn'), proj]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(home, '.conn', 'open-projects.json'), JSON.stringify([proj]));
  // Ask is the mode in which every page change raises a card, so a recording
  // that raised none was let through as looking.
  fs.writeFileSync(path.join(home, '.conn', 'settings.json'), JSON.stringify({ agent: { provider: 'claude', mode: 'ask' } }));

  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end(req.url.startsWith('/ticker') ? TICKER : PAGE);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${site.address().port}/`;

  const electron = require(path.join(ROOT, 'node_modules', 'electron'));
  const userData = path.join(base, 'userdata');
  const app = spawn(electron, [
    '--inspect=0', ROOT, '--remote-debugging-port=0', `--user-data-dir=${userData}`, '--no-sandbox',
  ], { env: { ...process.env, HOME: home, TMPDIR: tmp, CONN_CWD: proj }, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  const exited = new Promise((r) => app.once('exit', r));
  let appErr = '';
  app.stderr.on('data', (d) => { appErr += d; });

  try {
    const { inspector, cdp } = await endpoints(app, userData);
    const shell = await connect(await target(cdp, (t) => t.type === 'page' && /index\.html/.test(t.url)));
    const main = await connect(inspector);
    await main.run(`(() => {
      const req = process.getBuiltinModule('module').createRequire(${JSON.stringify(path.join(ROOT, 'src/main/index.js'))});
      const { AgentSession } = req('./agent');
      const { BrowserWindow } = req('electron');
      globalThis.__electron = req('electron');
      globalThis.__command = (c) => BrowserWindow.getAllWindows().find((w) => /index\\.html/.test(w.webContents.getURL())).webContents.send('app:command', c);
      AgentSession.prototype.start = async function start() {
        globalThis.__agent = this;
        this.sessionId = '7a7a7a7a-0000-4000-8000-000000000007';
        setTimeout(() => this.emit('ready', { sessionId: this.sessionId }), 0);
      };
      AgentSession.prototype.send = function send() {};
      AgentSession.prototype.models = async function models() { return []; };
      return true;
    })()`);

    await shell.evaluate(async () => {
      for (let i = 0; i < 60 && !window.connChat; i++) await new Promise((r) => setTimeout(r, 250));
      await new Promise((r) => setTimeout(r, 1000));
      window.__cards = [];
      window.conn.agent.onPermission((p) => window.__cards.push(p.tool));
      document.querySelector('[contenteditable="true"]')?.focus();
    });
    await shell.send('Input.insertText', { text: 'record the page' });
    await shell.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await shell.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    check('claude-session-stood-in', await until(() => main.run('!!globalThis.__agent')), 'no AgentSession was started');

    const invoke = (tool, args = {}) => main.run(`globalThis.__agent.invoke(${JSON.stringify(tool)}, ${JSON.stringify(args)}, { id: 'main', label: 'the main thread' })
      .catch((e) => ({ thrown: String(e && e.message || e) }))`);
    const page = (fn) => invoke('evaluate', { code: fn });
    const encoders = () => main.run(`__electron.BrowserWindow.getAllWindows().filter((w) => /encoder/i.test(w.webContents.getURL())).length`);
    const pane = (open) => main.run(`globalThis.__command({ name: 'preview', open: ${open} })`);
    const cards = () => shell.run('window.__cards.slice()');

    await pane(true);
    const nav = await invoke('navigate', { url: origin });
    check('page-loaded', !nav.thrown && !nav.error, JSON.stringify(nav));

    // 1. A recording of the open pane, with page-changing clicks in it.
    const started = await invoke('record', { action: 'start' });
    check('start-returns-recording', started.ok === true && started.recording === true && started.maxSeconds === 60, JSON.stringify(started));
    const t0 = Date.now();
    const twice = await invoke('record', { action: 'start' });
    check('second-start-is-an-error', /already|recording/i.test(twice.thrown || ''), JSON.stringify(twice));
    check('one-encoder-window-while-recording', (await encoders()) === 1, `encoders=${await encoders()}`);
    for (let i = 0; i < 4; i++) { await sleep(1000); await invoke('click', { target: '#next' }); }
    await sleep(1000);
    const wall = (Date.now() - t0) / 1000;
    const size = await page('[innerWidth, innerHeight]');
    const done = await invoke('record', { action: 'stop' });
    check('stop-returns-a-file', !!done.path && fs.existsSync(done.path), JSON.stringify(done));
    check('encoder-window-gone-after-stop', started.ok === true && (await encoders()) === 0, `started=${started.ok} encoders=${await encoders()}`);
    let info = null;
    if (done.path && fs.existsSync(done.path)) {
      info = probe(done.path);
      console.log(`  ${done.path}  ${fs.statSync(done.path).size} bytes  ${JSON.stringify(info)}  result=${JSON.stringify({ ...done, keyframes: undefined })}`);
      check('codec-is-h264-or-webm', (/mp4/.test(info.container) && info.codec === 'h264') || (/webm/.test(info.container) && /vp[89]/.test(info.codec)), JSON.stringify(info));
      check('extension-matches-format', done.path.endsWith(`.${done.format}`) && ['mp4', 'webm'].includes(done.format), `${done.path} ${done.format}`);
      check('duration-within-20-percent-of-wall-time', Math.abs(info.duration - wall) <= wall * 0.2, `ffprobe ${info.duration}s, wall ${wall}s`);
      check('reported-seconds-match-wall-time', Math.abs(done.seconds - wall) <= wall * 0.2, `reported ${done.seconds}s, wall ${wall}s`);
      check('size-is-the-panes-rounded-to-even', info.width === even(size[0]) && info.height === even(size[1]) && done.width === info.width && done.height === info.height,
        `video ${info.width}x${info.height}, result ${done.width}x${done.height}, pane ${size}`);
      check('frames-counted', done.frames > 0, JSON.stringify(done.frames));
      check('video-shows-the-page', near(pixel(done.path, 0.3, 4, 4), COLORS[0]) && near(pixel(done.path, -0.3, 4, 4), COLORS[0]), `first ${pixel(done.path, 0.3, 4, 4)} last ${pixel(done.path, -0.3, 4, 4)}`);
      // Four clicks, so the colours go 0, 1, 2, 3, 0. When each lands depends on
      // how busy the machine is; the order does not.
      const seen = [];
      for (let t = 0.1; t < info.duration - 0.2; t += 0.2) {
        const px = pixel(done.path, t, 4, 4);
        const at = COLORS.findIndex((c) => near(px, c));
        if (at >= 0 && seen[seen.length - 1] !== at) seen.push(at);
      }
      check('video-follows-the-clicks', seen.join() === '0,1,2,3,0', `colours in order: ${seen.join()}`);
    }
    const keys = done.keyframes || [];
    const magic = (f) => fs.readFileSync(f).subarray(0, 4).toString('hex');
    check('three-keyframes-on-disk', keys.length === 3 && keys.every((f) => fs.existsSync(f) && path.dirname(f) === path.dirname(done.path)), JSON.stringify(keys));
    check('keyframes-are-images', keys.length === 3 && keys.every((f) => /^(ffd8ff|89504e47)/.test(magic(f))), keys.map(magic).join());
    check('first-and-last-keyframe-differ', keys.length === 3 && !fs.readFileSync(keys[0]).equals(fs.readFileSync(keys[2])), 'identical bytes');
    check('recording-in-the-recordings-dir', /conn-recordings/.test(done.path || ''), done.path);
    const dir = path.dirname(done.path || path.join(base, 'no-recording-made', 'x'));
    fs.mkdirSync(dir, { recursive: true });

    const none = await invoke('record', { action: 'stop' });
    check('stop-with-nothing-recording-is-an-error', /not recording|nothing/i.test(none.thrown || ''), JSON.stringify(none));
    const bad = await invoke('record', { action: 'pause' });
    check('unknown-action-is-an-error', /start.*stop/i.test(bad.thrown || ''), JSON.stringify(bad));

    // 1b. A navigation to another origin swaps the renderer. The video goes on.
    await invoke('record', { action: 'start' });
    await sleep(1200);
    await invoke('navigate', { url: origin.replace('127.0.0.1', 'localhost') + '?2' });
    await sleep(1500);
    const across1 = await invoke('record', { action: 'stop' });
    if (across1.path && fs.existsSync(across1.path)) {
      const v = probe(across1.path);
      const seen = [];
      for (let t = 0.2; t < v.duration - 0.2; t += 0.2) {
        const at = COLORS.findIndex((c) => near(pixel(across1.path, t, 4, 4), c));
        if (at >= 0 && seen[seen.length - 1] !== at) seen.push(at);
      }
      check('video-goes-on-across-a-cross-origin-navigation', seen.join() === '0,2', `colours in order: ${seen.join()}`);
    } else check('video-goes-on-across-a-cross-origin-navigation', false, JSON.stringify(across1));
    await invoke('navigate', { url: origin });

    // 2. The pane closed: a hidden view still has to produce frames.
    await pane(false);
    check('pane-closed', await until(async () => !(await shell.evaluate(() => document.querySelector('#paneslot')?.getBoundingClientRect().width > 50))), 'pane still open');
    await invoke('record', { action: 'start', name: 'closed-pane' });
    for (let i = 0; i < 2; i++) { await sleep(900); await invoke('click', { target: '#next' }); }
    await sleep(900);
    const closed = await invoke('record', { action: 'stop' });
    check('closed-pane-recording-has-frames', closed.frames > 0 && fs.existsSync(closed.path || ''), JSON.stringify(closed));
    if (closed.path && fs.existsSync(closed.path)) {
      const want = COLORS[(await page('window.__i')) % COLORS.length];
      check('closed-pane-video-shows-the-page', near(pixel(closed.path, -0.3, 4, 4), want), `${pixel(closed.path, -0.3, 4, 4)} wanted ${want}`);
      check('name-is-used', path.basename(closed.path).startsWith('closed-pane.'), closed.path);
    }

    // 2b. A screenshot of a hidden pane leaves its view drawn at one pixel, and a
    //     recording started after it must not take that for the page.
    await invoke('screenshot');
    await invoke('record', { action: 'start' });
    await sleep(700);
    const after = await invoke('record', { action: 'stop' });
    check('start-after-a-hidden-screenshot-has-the-right-size', after.width === done.width && after.height === done.height, `${after.width}x${after.height}, wanted ${done.width}x${done.height}: ${JSON.stringify(after)}`);

    // 3. A screenshot of a hidden pane wakes the view at 1x1 for a moment. The
    //    video must not keep a trace of that.
    await invoke('record', { action: 'start' });
    await sleep(1200);
    const shot = await invoke('screenshot');
    check('screenshot-during-recording-works', !!shot.path && fs.existsSync(shot.path), JSON.stringify(shot));
    await sleep(1500);
    const shot2 = await invoke('screenshot');
    await sleep(1500);
    const across = await invoke('record', { action: 'stop' });
    if (across.path && fs.existsSync(across.path)) {
      const v = probe(across.path);
      const want = COLORS[(await page('window.__i')) % COLORS.length];
      const bad = [];
      for (let t = 0.2; t < v.duration - 0.3; t += 0.25) {
        const tl = pixel(across.path, t, 4, 4);
        const br = pixel(across.path, t, v.width - 6, v.height - 6);
        if (!near(tl, want) || !near(br, want)) bad.push(`${t.toFixed(2)}s tl=${tl} br=${br}`);
      }
      check('screenshot-leaves-every-frame-full-size-and-not-blank', bad.length === 0 && !shot2.thrown, `${bad.length} bad frames, want ${want}: ${bad.slice(0, 4).join(' | ')}`);
      check('video-kept-the-panes-size', v.width === done.width && v.height === done.height, `${v.width}x${v.height} vs ${done.width}x${done.height}`);
    } else check('screenshot-leaves-every-frame-full-size-and-not-blank', false, JSON.stringify(across));

    // 3b. A tab behind another tab is parked too, and a page there still moves.
    const tabA = (await invoke('tabs')).current;
    await invoke('navigate', { url: `${origin}ticker` });
    await invoke('record', { action: 'start' });
    await sleep(500);
    await invoke('tabNew', { url: origin });
    await sleep(2500);
    await invoke('tabSelect', { tab: tabA });
    const parked = await invoke('record', { action: 'stop' });
    if (parked.path && fs.existsSync(parked.path)) {
      const v = probe(parked.path);
      const seen = new Set();
      for (let t = 0.2; t < v.duration - 0.2; t += 0.2) {
        const at = COLORS.findIndex((c) => near(pixel(parked.path, t, 4, 4), c));
        if (at >= 0) seen.add(at);
      }
      check('video-of-a-tab-behind-another-tab-keeps-moving', seen.size >= 3, `colours seen: ${[...seen]}`);
    } else check('video-of-a-tab-behind-another-tab-keeps-moving', false, JSON.stringify(parked));
    await invoke('navigate', { url: origin });
    await invoke('tabClose', { tab: (await invoke('tabs')).tabs.find((t) => t.id !== tabA)?.id });

    // 4. The limit.
    const limited = await invoke('record', { action: 'start', maxSeconds: 2 });
    check('max-seconds-echoed', limited.maxSeconds === 2, JSON.stringify(limited));
    await sleep(3600);
    const state = await invoke('state');
    check('state-says-not-recording-after-the-limit', state.recording === false, JSON.stringify(state));
    check('limit-stopped-it-without-a-stop-call', limited.ok === true && (await encoders()) === 0, `started=${limited.ok} encoders=${await encoders()}`);
    const kept = await invoke('record', { action: 'stop' });
    check('stop-after-the-limit-returns-the-kept-file', !!kept.path && fs.existsSync(kept.path) && Math.abs(kept.seconds - 2) <= 0.6, JSON.stringify(kept));
    const again = await invoke('record', { action: 'stop' });
    check('a-kept-file-is-handed-over-once', /not recording|nothing/i.test(again.thrown || ''), JSON.stringify(again));
    const capped = await invoke('record', { action: 'start', maxSeconds: 9999 });
    check('max-seconds-capped-at-120', capped.maxSeconds === 120, JSON.stringify(capped));
    await invoke('record', { action: 'stop' });

    // 5. Names stay inside the directory.
    for (const name of ['../../escape/x', '/etc/passwd', 'a/b/c.mp4', '..', '']) {
      await invoke('record', { action: 'start', name });
      await sleep(400);
      const r = await invoke('record', { action: 'stop' });
      check(`name-${JSON.stringify(name)}-stays-in-the-recordings-dir`, !!r.path && path.dirname(r.path) === dir && (r.keyframes || []).every((k) => path.dirname(k) === dir), JSON.stringify(r));
    }
    check('nothing-escaped', !!done.path && !fs.existsSync(path.join(dir, '..', 'escape')) && !fs.existsSync(path.join(os.tmpdir(), 'escape')), 'escape dir exists');

    // 6. Only the newest 20 recordings are kept, each with its keyframes.
    const stale = [];
    for (let i = 0; i < 25; i++) {
      const stem = path.join(dir, `old-${String(i).padStart(2, '0')}`);
      const at = new Date(Date.now() - (100 - i) * 3600e3);
      for (const f of [`${stem}.mp4`, `${stem}-first.jpg`, `${stem}-mid.jpg`, `${stem}-last.jpg`]) {
        fs.writeFileSync(f, 'x');
        fs.utimesSync(f, at, at);
      }
      stale.push(stem);
    }
    await invoke('record', { action: 'start', name: 'newest' });
    await sleep(500);
    const newest = await invoke('record', { action: 'stop' });
    const videos = fs.readdirSync(dir).filter((f) => /\.(mp4|webm)$/.test(f));
    check('prunes-to-20-videos', videos.length === 20, `${videos.length} videos: ${videos.join(' ')}`);
    check('newest-survives', !!newest.path && videos.includes(path.basename(newest.path)), JSON.stringify(newest));
    const left = fs.readdirSync(dir).filter((f) => /^old-/.test(f));
    const orphans = left.filter((f) => !f.endsWith('.mp4') && !left.includes(f.replace(/-(first|mid|last)\.jpg$/, '.mp4')));
    check('oldest-go-with-their-keyframes', !left.includes('old-00.mp4') && !left.includes('old-00-first.jpg') && orphans.length === 0, `left=${left.length} orphans=${orphans.join()}`);

    // 7. DevTools takes the debugger. It opens and closes on its own time, so
    //    each toggle waits to see it done.
    const devtoolsIs = async () => main.run(`__electron.webContents.getAllWebContents().some((w) => w.isDevToolsOpened())`);
    const devtools = async (open) => {
      // A toggle now and then does not take under xvfb, so ask again.
      for (let i = 0; i < 3 && (await devtoolsIs()) !== open; i++) {
        await invoke('devtools');
        await until(async () => (await devtoolsIs()) === open, 5000);
      }
      await sleep(800);
      return (await devtoolsIs()) === open;
    };
    check('devtools-opens', await devtools(true), 'devtools did not open');
    const blocked = await invoke('record', { action: 'start' });
    check('start-with-devtools-open-is-a-clear-error', /devtools/i.test(blocked.thrown || ''), JSON.stringify(blocked));
    check('devtools-closes', await devtools(false), 'devtools did not close');
    const back = await until(async () => (await invoke('record', { action: 'start' })).ok === true, 8000);
    check('start-works-again-once-devtools-is-closed', back, 'the pane never got its debugger back');
    await sleep(1500);
    check('devtools-opens-mid-recording', await devtools(true), `devtools did not open: ${await main.run(`JSON.stringify(__electron.webContents.getAllWebContents().map((w) => [w.getURL().slice(0, 40), w.isDevToolsOpened()]))`)}`);
    const cut = await invoke('record', { action: 'stop' });
    check('devtools-mid-recording-keeps-what-was-recorded', !!cut.path && fs.existsSync(cut.path) && cut.seconds > 0.8 && cut.endedBy === 'detached', JSON.stringify(cut));
    check('devtools-closes-again', await devtools(false), 'devtools did not close');
    await until(async () => (await invoke('setViewport', { width: 500, height: 400 })).ok === true, 8000);
    await invoke('clearViewport');

    // 8. Recording looks; it does not change the page, so Ask raises no card.
    const bridge = JSON.parse(fs.readFileSync(path.join(home, '.conn', 'bridge.json'), 'utf8'));
    const viaBridge = async (tool, body = {}, signal) => {
      const res = await fetch(`${bridge.url}/tool/${tool}`, {
        method: 'POST', signal,
        headers: { 'content-type': 'application/json', 'x-conn-token': bridge.token, 'x-conn-cwd': proj },
        body: JSON.stringify(body),
      });
      return res.json();
    };
    const before = (await cards()).length;
    const s1 = await viaBridge('record', { action: 'start' });
    await sleep(600);
    const s2 = await viaBridge('record', { action: 'stop' });
    check('bridge-record-works', s1.result?.recording === true && !!s2.result?.path, JSON.stringify([s1, s2]));
    check('no-permission-card-in-ask-mode', s1.result?.recording === true && (await cards()).length === before, `cards: ${await cards()}`);
    const probeCtl = new AbortController();
    viaBridge('click', { target: '#next' }, probeCtl.signal).catch(() => {});
    check('control-a-click-does-raise-a-card-in-ask-mode', !!(await until(async () => (await cards()).length > before, 4000)), 'the card listener saw nothing, so it proves nothing');
    probeCtl.abort();
    await shell.run("window.__cards = []");

    // 9. The command line reaches the same tool.
    const cli = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'cli', 'conn.js'), ...args], {
      env: { ...process.env, HOME: home, CONN_BRIDGE_URL: bridge.url, CONN_TOKEN: bridge.token, CONN_CWD: proj }, encoding: 'utf8',
    });
    const c1 = cli('record', 'start', 'from-cli', '--max', '7');
    check('cli-start', c1.status === 0, c1.stdout + c1.stderr);
    await sleep(700);
    const c2 = cli('record', 'stop');
    const printed = c2.stdout.trim().split('\n')[0];
    check('cli-stop-prints-the-path', c2.status === 0 && /from-cli\.(mp4|webm)$/.test(printed) && fs.existsSync(printed), c2.stdout + c2.stderr);
    const c3 = cli('record', 'stop');
    check('cli-stop-with-nothing-fails', c3.status !== 0 && /not recording|nothing/i.test(c3.stderr), c3.stdout + c3.stderr);

    // 9b. The MCP server hands the stills to the model as images.
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
    const mcp = new Client({ name: 'record-repro', version: '0.0.0' });
    await mcp.connect(new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, 'mcp', 'server.js')],
      env: { ...process.env, HOME: home, CONN_BRIDGE_URL: bridge.url, CONN_TOKEN: bridge.token, CONN_CWD: proj },
    }));
    const tools = (await mcp.listTools()).tools;
    check('mcp-lists-browser-record', tools.some((t) => t.name === 'browser_record'), tools.map((t) => t.name).join());
    const m1 = await mcp.callTool({ name: 'browser_record', arguments: { action: 'start', name: 'via-mcp' } });
    await sleep(700);
    const m2 = await mcp.callTool({ name: 'browser_record', arguments: { action: 'stop' } });
    const images = (m2.content || []).filter((b) => b.type === 'image');
    const reported = JSON.parse((m2.content || []).find((b) => b.type === 'text')?.text || '{}');
    check('mcp-start-answers-without-images', !m1.isError && !(m1.content || []).some((b) => b.type === 'image'), JSON.stringify(m1));
    check('mcp-stop-returns-the-path', /via-mcp\.(mp4|webm)$/.test(reported.path || '') && fs.existsSync(reported.path), JSON.stringify(m2).slice(0, 300));
    check('mcp-stop-returns-three-stills-as-images', images.length === 3 && images.every((b) => b.mimeType === 'image/jpeg' && Buffer.from(b.data, 'base64').subarray(0, 3).toString('hex') === 'ffd8ff'), `${images.length} images`);
    const m3 = await mcp.callTool({ name: 'browser_record', arguments: { action: 'stop' } });
    check('mcp-stop-with-nothing-is-an-error', m3.isError === true && /not recording/.test(JSON.stringify(m3)), JSON.stringify(m3));
    await mcp.close();

    // 9c. Looking, in every mode, whichever way the tool is named.
    const { decide } = require(path.join(ROOT, 'src', 'main', 'modes.js'));
    const verdicts = [];
    for (const mode of ['plan', 'ask', 'auto', 'bypass']) {
      for (const name of ['record', 'browser_record', 'mcp__preview__browser_record', 'mcp__conn__browser_record']) {
        if (decide(mode, name, { action: 'start' }).action !== 'allow') verdicts.push(`${mode} ${name}`);
      }
    }
    check('decide-lets-record-through-in-every-mode', verdicts.length === 0, verdicts.join('; '));

    // 10. Quit in the middle of a recording.
    await invoke('record', { action: 'start' });
    await sleep(800);
    check('encoder-window-up-before-quit', (await encoders()) === 1, `encoders=${await encoders()}`);
    const pgid = app.pid;
    const members = () => {
      const out = spawnSync('ps', ['-o', 'pid=,comm=', '-g', String(pgid)], { encoding: 'utf8' }).stdout.trim();
      return out ? out.split('\n').map((l) => l.trim()) : [];
    };
    check('app-has-child-processes-before-quit', members().length > 1, members().join('; '));
    // Node holds the process open until its inspector client lets go.
    await main.run('setTimeout(() => __electron.app.quit(), 200), true');
    main.ws.close();
    shell.ws.close();
    const quit = await Promise.race([exited.then(() => true), sleep(15000).then(() => false)]);
    check('app-exits-on-quit-mid-recording', quit, `still running 15 s after quit: ${appErr.slice(-600)}`);
    await sleep(1500);
    check('no-process-outlives-the-app', members().length === 0, members().join('; '));
  } finally {
    site.close();
    try { process.kill(-app.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    await exited;
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
  }

  console.log(failures.length ? `\n${failures.length} failed` : '\nall passed');
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
