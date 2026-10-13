/* The verify skill, run for real. Two instances boot at once on throwaway
   HOMEs, one on the screen and one under Xvfb, and must not share a port or a
   data dir. Each must paint a window the skill can photograph, and say, perm
   and click must reach the app and its main process. With the preview open on
   the shop page, a shot and a recording must hold the page's pixels inside
   #paneslot, and a shot must not when the preview is hidden or left out.
   A view the app borrows to screenshot a background tab must not be drawn, and
   a drag must move the column divider. A recording whose first composite
   fails, or never arrives, must exit non-zero within its bound, print the real
   cause, and leave no ffmpeg, capture slot or partial file behind. Against a
   fake window, a recording must take its first frame before the screencast
   starts and must bound a connect or a screencast that never answers. Against
   a fake ffmpeg that closes its input, dies by a signal, or is missing, it must
   fail cleanly and never print a path for a video it did not write. `sessions` lists what was booted. stop
   refuses a folder a boot did not make and a state file without a real pid, and
   it skips the group kill when the group's leader does not name the session's
   --user-data-dir. After stop no process may still name either instance's
   folder, and an Xvfb instance's xvfb-run dir is gone. doctor must fail when
   the renderer build is missing or older than its source. Needs a built
   renderer: `npx vite build` first. */
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, bounds, click, decided, drag, evaluate, invoke, key, perm, record, say, sessions as listed, shot, stop } from '../.claude/skills/verify/drive.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DRIVE = path.join(ROOT, '.claude', 'skills', 'verify', 'drive.mjs');
const sharp = createRequire(path.join(ROOT, 'package.json'))('sharp');

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
};

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const isPng = (file) => {
  const bytes = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);
  return bytes.length > 1000 && bytes.subarray(0, 8).equals(PNG);
};

const share = async (file, r, test) => {
  const { data, info } = await sharp(file)
    .extract({ left: Math.round(r.x), top: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) })
    .raw().toBuffer({ resolveWithObject: true });
  let hits = 0;
  for (let i = 0; i < data.length; i += info.channels) if (test(data[i], data[i + 1], data[i + 2])) hits++;
  return hits / (info.width * info.height);
};
const white = (r, g, b) => r > 235 && g > 235 && b > 235;
const dark = (r, g, b) => r < 90 && g < 90 && b < 90;

const doctorOf = (root) => {
  try { return { status: 0, out: execFileSync('node', [DRIVE, 'doctor', '--root', root], { encoding: 'utf8', cwd: ROOT }) }; }
  catch (e) { return { status: e.status, out: String(e.stdout) }; }
};

const authDirsOf = (s) => fs.readdirSync('/proc').filter((pid) => /^\d+$/.test(pid)).flatMap((pid) => {
  try {
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
    const dir = /-auth (\S+)\/Xauthority/.exec(cmd)?.[1];
    return dir && fs.readFileSync(`/proc/${pid}/environ`, 'utf8').includes(`HOME=${s.home}`) ? [dir] : [];
  } catch { return []; }
});

const running = (needle) => fs.readdirSync('/proc').filter((pid) => /^\d+$/.test(pid)).filter((pid) => {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(needle); } catch { return false; }
});

/* A window that speaks just enough CDP for record: a page target, captures, and a screencast
   that sends no frames. In starved modes a capture is answered only while no screencast is
   running, as in a window with nothing to draw. */
const fakeWindow = (mode, image) => new Promise((resolve) => {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    if (req.url !== '/json/list') { res.writeHead(404).end(); return; }
    if (mode === 'connect-hangs') return;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([{ type: 'page', url: 'file:///fake/index.html', webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/page` }]));
  });
  server.on('upgrade', (req, socket) => {
    sockets.add(socket);
    const accept = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const send = (message) => {
      const body = Buffer.from(JSON.stringify(message));
      const head = body.length < 126 ? Buffer.from([0x81, body.length])
        : body.length < 65536 ? Buffer.from([0x81, 126, body.length >> 8, body.length & 255])
          : Buffer.concat([Buffer.from([0x81, 127]), (() => { const n = Buffer.alloc(8); n.writeBigUInt64BE(BigInt(body.length)); return n; })()]);
      socket.write(Buffer.concat([head, body]));
    };
    let streaming = false;
    const answer = ({ id, method }) => {
      if (method === 'Page.captureScreenshot') { if (!streaming) send({ id, result: { data: image.toString('base64') } }); return; }
      if (method === 'Page.startScreencast') { streaming = true; if (mode !== 'start-hangs') send({ id, result: {} }); return; }
      if (method === 'Page.stopScreencast') { streaming = false; if (mode !== 'stop-hangs') send({ id, result: {} }); return; }
      send({ id, result: {} });
    };
    let held = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      held = Buffer.concat([held, chunk]);
      for (;;) {
        if (held.length < 2) return;
        let length = held[1] & 127;
        let at = 2;
        if (length === 126) { if (held.length < 4) return; length = held.readUInt16BE(2); at = 4; }
        else if (length === 127) { if (held.length < 10) return; length = Number(held.readBigUInt64BE(2)); at = 10; }
        if (held.length < at + 4 + length) return;
        const mask = held.subarray(at, at + 4);
        const text = Buffer.from(held.subarray(at + 4, at + 4 + length)).map((b, i) => b ^ mask[i % 4]);
        const opcode = held[0] & 15;
        held = held.subarray(at + 4 + length);
        if (opcode === 8) { socket.end(); return; }
        if (opcode === 1) answer(JSON.parse(text.toString()));
      }
    });
    socket.on('error', () => {});
  });
  server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port,
    close: () => { for (const socket of sockets) socket.destroy(); server.closeAllConnections(); server.close(); },
  }));
});

const alive = (pid) => {
  try { return !fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /, '').startsWith('Z'); } catch { return false; }
};

const refuses = async (s) => {
  try { await stop(s); return false; } catch (e) { return /refusing/.test(e.message); }
};

const holders = (dir) => fs.readdirSync('/proc')
  .filter((pid) => /^\d+$/.test(pid))
  .filter((pid) => ['cmdline', 'environ'].some((file) => {
    try { return fs.readFileSync(`/proc/${pid}/${file}`, 'utf8').includes(dir); } catch { return false; }
  }) || (() => {
    try { return fs.readlinkSync(`/proc/${pid}/cwd`).startsWith(dir); } catch { return false; }
  })());

async function main() {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-verify-check-'));
  const sessions = [];
  const decoys = [];
  const strays = [];
  const servers = [];
  try {
    const booted = await Promise.allSettled([boot(), boot({ xvfb: true })]);
    sessions.push(...booted.filter((r) => r.status === 'fulfilled').map((r) => r.value));
    const failed = booted.find((r) => r.status === 'rejected');
    if (failed) throw failed.reason;
    const [a, b] = sessions;

    check('inspector-ports-differ', a.inspect > 0 && b.inspect > 0 && a.inspect !== b.inspect, `${a.inspect} ${b.inspect}`);
    check('cdp-ports-differ', a.cdp > 0 && b.cdp > 0 && a.cdp !== b.cdp, `${a.cdp} ${b.cdp}`);
    check('user-data-dirs-differ', a.userData !== b.userData, `${a.userData} ${b.userData}`);
    check('projects-differ', a.project !== b.project && fs.existsSync(path.join(a.project, 'index.html')), `${a.project} ${b.project}`);

    const shotA = await shot(a, path.join(out, 'a.png'));
    const shotB = await shot(b, path.join(out, 'b.png'));
    check('instance-a-paints-a-png', isPng(shotA), shotA);
    check('instance-b-paints-a-png', isPng(shotB), shotB);

    const rail = await evaluate(a, 'document.body.innerText');
    check('rail-lists-the-shop-folder', /shop/.test(rail), rail.slice(0, 200));

    await say(a, 'Run it:\n\n```bash\necho verify-ok\n```');
    const fence = await evaluate(a, `(() => {
      const el = document.querySelector('#agent-root [data-slot="shell-block"][data-language="bash"]');
      return el && { copy: !!el.querySelector('button[aria-label="Copy"]'), run: !!el.querySelector('button[aria-label="Run in terminal"]') };
    })()`);
    check('say-renders-a-bash-fence-with-copy-and-run', fence?.copy === true && fence.run === true, JSON.stringify(fence));

    await perm(a, { id: 'p1', tool: 'Edit', input: { file_path: `${a.project}/index.html`, old_string: 'a', new_string: 'b' } });
    await click(a, 'Allow');
    check('click-allow-reaches-main', (await decided(a, 'p1')) === 'allow', JSON.stringify(await decided(a)));
    check('the-other-instance-heard-nothing', (await decided(b)).length === 0, JSON.stringify(await decided(b)));

    const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(fs.readFileSync(path.join(a.project, 'index.html'))); });
    servers.push(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    await key(a, 'Ctrl+Shift+B');
    await invoke(a, 'navigate', { url: `http://127.0.0.1:${server.address().port}/` });
    await invoke(a, 'waitFor', { selector: '#apply', timeout: 5000 });
    const placed = await bounds(a);
    check('preview-sits-in-the-paneslot', placed.match && placed.nativeViewMatch, JSON.stringify(placed));
    const slot = placed.paneslot;
    const heading = await invoke(a, 'evaluate', { code: 'JSON.stringify(document.querySelector("h1").getBoundingClientRect())' });
    const h = JSON.parse(heading.value ?? heading);
    const title = { x: slot.x + h.x, y: slot.y + h.y, width: h.width, height: h.height };

    const withPreview = await shot(a, path.join(out, 'with.png'));
    const without = await shot(a, path.join(out, 'without.png'), { preview: false });
    check('shot-paints-the-page-inside-the-paneslot', await share(withPreview, slot, white) > 0.8, await share(withPreview, slot, white));
    check('shot-shows-the-heading-as-dark-text-on-white', await share(withPreview, title, dark) > 0.01 && await share(withPreview, title, white) > 0.5, JSON.stringify(title));
    check('shot-without-the-preview-shows-the-empty-slot', await share(without, slot, white) < 0.05, await share(without, slot, white));

    const hide = (shown) => evaluate(a, `electron.BrowserWindow.getAllWindows()[0].contentView.children.forEach((v) => v.setVisible(${shown}))`, { main: true });
    await hide(false);
    const hidden = await shot(a, path.join(out, 'hidden.png'));
    await hide(true);
    check('a-hidden-preview-is-not-painted', await share(hidden, slot, white) < 0.05, await share(hidden, slot, white));
    const shownAgain = await shot(a, path.join(out, 'again.png'));
    check('a-shown-preview-is-painted-again', await share(shownAgain, slot, white) > 0.8, await share(shownAgain, slot, white));

    const clip = await record(a, { seconds: 2, out: path.join(out, 'rec.mp4') });
    const frame = path.join(out, 'rec.png');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', clip, '-vf', 'select=eq(n\\,10)', '-frames:v', '1', frame]);
    const length = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', clip], { encoding: 'utf8' }));
    check('record-is-two-seconds-long', length > 1.8 && length < 2.2, length);
    check('record-paints-the-page-inside-the-paneslot', await share(frame, slot, white) > 0.8, await share(frame, slot, white));
    const first = path.join(out, 'rec-first.png');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', clip, '-vf', 'select=eq(n\\,0)', '-frames:v', '1', first]);
    check('record-opens-with-the-page-already-drawn', await share(first, slot, white) > 0.8, await share(first, slot, white));

    // A recording that cannot get its first composite must stop within its bound and say why. The hard kill
    // turns a hang into a failed check, and the bound is the larger of 15 s and the recording's length.
    const recordCli = (file, seconds = 1) => new Promise((resolve) => {
      const began = Date.now();
      const child = spawn('node', [DRIVE, 'record', '--session', a.dir, '--seconds', String(seconds), '--out', file], { cwd: ROOT });
      let err = '';
      child.stderr.on('data', (d) => { err += d; });
      const hang = setTimeout(() => child.kill('SIGKILL'), 30000);
      child.once('close', (code) => { clearTimeout(hang); resolve({ code, err: err.trim(), ms: Date.now() - began }); });
    });
    const forced = (source) => evaluate(a, `(() => { globalThis.__previewReal ??= globalThis.__preview; ${source}; return true; })()`, { main: true });
    const afterForced = async (file) => ({ ffmpeg: running(file), slots: await evaluate(a, 'Object.keys(globalThis.__seen || {})', { main: true }), file: fs.existsSync(file) });
    const noImage = path.join(out, 'no-image.mp4');
    await forced('globalThis.__preview = async () => ({ width: 1440, height: 900, layers: [{ x: 946, y: 92, width: 494, height: 789, image: null }] })');
    const nullFirst = await recordCli(noImage);
    const leftAfterNull = await afterForced(noImage);
    check('record-with-no-first-image-fails-within-its-bound-and-says-why', nullFirst.code === 1 && nullFirst.ms < 20000 && /could not capture the preview/.test(nullFirst.err), JSON.stringify(nullFirst));
    check('record-with-no-first-image-leaves-nothing-behind', leftAfterNull.ffmpeg.length === 0 && leftAfterNull.slots.length === 0 && !leftAfterNull.file, JSON.stringify(leftAfterNull));
    const throwing = path.join(out, 'throwing.mp4');
    await forced("globalThis.__preview = async () => { throw new Error('forced composite failure'); }");
    const throwFirst = await recordCli(throwing);
    const leftAfterThrow = await afterForced(throwing);
    await forced('globalThis.__preview = globalThis.__previewReal');
    check('record-with-a-failing-first-composite-prints-the-real-cause', throwFirst.code === 1 && throwFirst.ms < 20000 && /forced composite failure/.test(throwFirst.err) && !/ffmpeg failed/.test(throwFirst.err), JSON.stringify(throwFirst));
    check('record-with-a-failing-first-composite-leaves-nothing-behind', leftAfterThrow.ffmpeg.length === 0 && leftAfterThrow.slots.length === 0 && !leftAfterThrow.file, JSON.stringify(leftAfterThrow));

    const partial = path.join(out, 'partial.mp4');
    // ffmpeg creates its output only after probing its input for a few seconds, so the failure comes 9 s after the first composite.
    await forced("(() => { let began; const real = globalThis.__previewReal; globalThis.__preview = async (f) => { began ??= Date.now(); if (Date.now() - began < 9000) return real(f); throw new Error('forced late failure'); }; })()");
    const lateFail = await recordCli(partial, 14);
    const leftAfterLate = await afterForced(partial);
    await forced('globalThis.__preview = globalThis.__previewReal');
    check('record-that-fails-after-its-first-frames-says-why-and-leaves-no-partial-file', lateFail.code === 1 && /forced late failure/.test(lateFail.err) && leftAfterLate.ffmpeg.length === 0 && leftAfterLate.slots.length === 0 && !leftAfterLate.file, JSON.stringify({ lateFail, leftAfterLate }));

    const redWindow = await sharp({ create: { width: 1440, height: 900, channels: 3, background: '#c80000' } }).jpeg().toBuffer();
    const fakeSession = (port) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-verify-fakecdp-'));
      decoys.push(dir);
      fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ dir, root: ROOT, home: path.join(dir, 'home'), userData: path.join(dir, 'userdata'), project: path.join(dir, 'shop'), pid: process.pid, inspect: 1, cdp: port }));
      return dir;
    };
    const fakeBin = (script) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-bin-'));
      decoys.push(dir);
      if (script !== null) fs.writeFileSync(path.join(dir, 'ffmpeg'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
      return dir;
    };
    const recordFake = (mode, bin, seconds = 2) => new Promise((resolve) => {
      fakeWindow(mode, redWindow).then((window) => {
        const file = path.join(out, `fake-${mode}-${Math.random().toString(36).slice(2)}.mp4`);
        const began = Date.now();
        const child = spawn(process.execPath, [DRIVE, 'record', '--session', fakeSession(window.port), '--seconds', String(seconds), '--no-preview', '--bound', '3000', '--out', file], { cwd: ROOT, env: bin ? { ...process.env, PATH: fs.existsSync(path.join(bin, 'ffmpeg')) ? `${bin}:/usr/bin:/bin` : bin } : process.env });
        let printed = '';
        let err = '';
        child.stdout.on('data', (d) => { printed += d; });
        child.stderr.on('data', (d) => { err += d; });
        const hang = setTimeout(() => child.kill('SIGKILL'), 20000);
        child.once('close', (code, signal) => {
          clearTimeout(hang);
          window.close();
          resolve({ code, signal, printed: printed.trim(), err: err.trim(), ms: Date.now() - began, file, wrote: fs.existsSync(file) });
        });
      });
    });

    // The window sends no screencast frame and answers a capture only before the screencast starts, so a video of
    // it exists only if record took its first frame first.
    const starved = await recordFake('starved');
    const starvedFrame = path.join(out, 'starved.png');
    if (starved.wrote) execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', starved.file, '-vf', 'select=eq(n\\,0)', '-frames:v', '1', starvedFrame]);
    check('record-takes-its-first-frame-before-the-screencast-starts', starved.code === 0 && starved.wrote && await share(starvedFrame, { x: 600, y: 300, width: 100, height: 100 }, (r, g, b) => r > 140 && g < 70 && b < 70) > 0.9, JSON.stringify(starved));
    const noStart = await recordFake('start-hangs');
    check('record-bounds-a-screencast-that-never-starts', noStart.code === 1 && noStart.ms < 10000 && /starting the screencast did not finish within 3 s/.test(noStart.err) && !noStart.wrote, JSON.stringify(noStart));
    const noConnect = await recordFake('connect-hangs');
    check('record-bounds-a-connection-that-never-answers', noConnect.code === 1 && noConnect.ms < 10000 && /the connection to the window did not finish within 3 s/.test(noConnect.err), JSON.stringify(noConnect));
    const noStop = await recordFake('stop-hangs');
    check('record-does-not-fail-a-finished-video-over-a-stop-that-never-answers', noStop.code === 0 && noStop.wrote && noStop.ms < 12000, JSON.stringify(noStop));
    // It never reads, so frames stay buffered in Node, and the write that finds it gone gets EPIPE.
    const closedInput = await recordFake('starved', fakeBin('sleep 3'));
    check('record-survives-ffmpeg-closing-its-input', closedInput.code === 1 && /ffmpeg exited without writing the video/.test(closedInput.err) && !/Unhandled|EPIPE/.test(closedInput.err) && !closedInput.printed, JSON.stringify(closedInput));
    const diesEarly = await recordFake('starved', fakeBin('head -c 20000 > /dev/null; exit 3'), 6);
    check('record-stops-writing-and-reports-the-exit-when-ffmpeg-dies-mid-recording', diesEarly.code === 1 && /exit 3/.test(diesEarly.err) && diesEarly.ms < 4500 && !diesEarly.printed, JSON.stringify(diesEarly));
    const bySignal = await recordFake('starved', fakeBin('kill -9 $$'));
    check('record-fails-when-ffmpeg-dies-by-a-signal', bySignal.code === 1 && /killed by SIGKILL/.test(bySignal.err) && !bySignal.printed && !bySignal.wrote, JSON.stringify(bySignal));
    const noFfmpeg = await recordFake('starved', fakeBin(null));
    check('record-fails-fast-when-ffmpeg-is-missing', noFfmpeg.code === 1 && noFfmpeg.ms < 10000 && /ENOENT/.test(noFfmpeg.err) && !/Unhandled/.test(noFfmpeg.err) && !noFfmpeg.printed, JSON.stringify(noFfmpeg));

    const SUB = { id: 'task-research-1', label: 'research', type: 'general-purpose' };
    await invoke(a, 'navigate', { url: `http://127.0.0.1:${server.address().port}/` }, SUB);
    await evaluate(a, `(() => {
      const view = electron.BrowserWindow.getAllWindows()[0].contentView.children.find((v) => v.getBounds().x > 1440);
      globalThis.__borrowed = { view, parked: view.getBounds() };
      view.setBounds({ x: 0, y: 0, width: 1, height: 1 });
      view.setVisible(true);
      return true;
    })()`, { main: true });
    const boxes = await evaluate(a, 'globalThis.__previewBoxes()', { main: true });
    check('only-the-view-the-shell-placed-counts-as-the-preview', boxes.length === 1 && Math.abs(boxes[0].x - slot.x) <= 1 && Math.abs(boxes[0].width - slot.width) <= 1, JSON.stringify(boxes));
    let borrowed = null;
    try { borrowed = await shot(a, path.join(out, 'borrowed.png')); } catch (e) { borrowed = e.message; }
    await evaluate(a, '(() => { const { view, parked } = globalThis.__borrowed; view.setBounds(parked); view.setVisible(false); return true; })()', { main: true });
    const painted = borrowed && fs.existsSync(borrowed);
    check('shot-ignores-a-view-the-app-borrows-for-a-screenshot', painted && await share(borrowed, slot, white) > 0.8 && await share(borrowed, { x: 0, y: 0, width: 1, height: 1 }, white) === 0, borrowed);

    const dividers = JSON.parse(await evaluate(a, `JSON.stringify([...document.querySelectorAll('[role="separator"]')].map((e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; }))`));
    const divider = dividers.filter((d) => d.h > d.w).sort((p, q) => Math.abs(p.x - slot.x) - Math.abs(q.x - slot.x))[0];
    await drag(a, Math.round(divider.x), Math.round(divider.y), Math.round(divider.x) - 120, Math.round(divider.y));
    const widened = (await bounds(a)).paneslot;
    check('drag-moves-the-column-divider', widened.width - slot.width > 80, `${slot.width} then ${widened.width}`);

    const fakeRoot = (name, { build }) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
      decoys.push(dir);
      fs.mkdirSync(path.join(dir, 'src', 'renderer'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), '{}');
      fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
      const source = path.join(dir, 'src', 'renderer', 'app.js');
      fs.writeFileSync(source, '');
      const now = Date.now() / 1000;
      fs.utimesSync(source, now - 60, now - 60);
      if (build) {
        fs.mkdirSync(path.join(dir, 'build', 'renderer'), { recursive: true });
        const built = path.join(dir, 'build', 'renderer', 'index.html');
        fs.writeFileSync(built, '');
        fs.utimesSync(built, now + build, now + build);
      }
      return dir;
    };
    const missing = doctorOf(fakeRoot('verify-doctor-missing-', {}));
    const stale = doctorOf(fakeRoot('verify-doctor-stale-', { build: -120 }));
    const fresh = doctorOf(fakeRoot('verify-doctor-fresh-', { build: 60 }));
    check('doctor-fails-when-the-build-is-missing', missing.status === 1 && /FAIL renderer-built: build\/renderer is missing/.test(missing.out), JSON.stringify(missing));
    check('doctor-fails-when-the-build-is-older-than-the-source', stale.status === 1 && /FAIL renderer-built: build\/renderer is older than src\/renderer\/app\.js/.test(stale.out), JSON.stringify(stale));
    check('doctor-passes-a-current-build', fresh.status === 0 && /^ok +renderer-built/m.test(fresh.out), JSON.stringify(fresh));

    check('sessions-lists-both-instances', [a, b].every((s) => listed().some((l) => l.dir === s.dir)), JSON.stringify(listed().map((l) => l.dir)));

    const decoy = (name) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), name)); decoys.push(dir); return dir; };
    const noSuchPid = 2 ** 31 - 1;
    const shaped = (dir, over = {}) => ({ dir, home: path.join(dir, 'home'), userData: path.join(dir, 'userdata'), project: path.join(dir, 'shop'), pid: noSuchPid, ...over });
    const notASession = decoy('not-a-session-');
    const outer = decoy('conn-verify-outer-');
    const nested = path.join(outer, 'conn-verify-inner');
    fs.mkdirSync(nested);
    const forged = decoy('conn-verify-forged-');
    const pidless = decoy('conn-verify-pidless-');
    check('stop-refuses-a-folder-not-named-conn-verify', await refuses(shaped(notASession)) && fs.existsSync(notASession), notASession);
    check('stop-refuses-a-folder-not-directly-under-tmp', await refuses(shaped(nested)) && fs.existsSync(nested), nested);
    check('stop-refuses-a-session-whose-home-is-elsewhere', await refuses(shaped(forged, { home: `${forged}-elsewhere/home` })) && fs.existsSync(forged), forged);
    check('stop-refuses-a-session-with-no-real-pid', await refuses(shaped(pidless, { pid: 1 })) && fs.existsSync(pidless), pidless);

    const guarded = decoy('conn-verify-pidguard-');
    const leader = spawn('sh', ['-c', '(cd / && exec sleep 301) & echo $!; exec sleep 300'], { detached: true, cwd: guarded, stdio: ['ignore', 'pipe', 'ignore'] });
    const bystander = Number(await new Promise((resolve) => leader.stdout.once('data', (d) => resolve(String(d).trim()))));
    strays.push(leader.pid, bystander);
    await stop(shaped(guarded, { pid: leader.pid }));
    check('a-forged-pid-does-not-take-down-its-group', alive(bystander) && !alive(leader.pid), `bystander alive ${alive(bystander)}, leader alive ${alive(leader.pid)}`);

    const authB = authDirsOf(b);
    check('the-xvfb-instance-has-an-xvfb-run-dir', authB.length === 1 && fs.existsSync(authB[0]), JSON.stringify(authB));
    for (const s of [a, b]) await stop(s);
    check('stop-removes-the-xvfb-run-dir', authB.length === 1 && !fs.existsSync(authB[0]), JSON.stringify(authB));
    check('sessions-no-longer-lists-them', [a, b].every((s) => !listed().some((l) => l.dir === s.dir)), JSON.stringify(listed().map((l) => l.dir)));
    for (const s of [a, b]) {
      check(`no-process-holds-${path.basename(s.dir)}`, holders(s.dir).length === 0, holders(s.dir).join(','));
      check(`session-dir-removed-${path.basename(s.dir)}`, !fs.existsSync(s.dir), s.dir);
    }
    sessions.length = 0;
  } finally {
    for (const s of sessions) await stop(s).catch(() => {});
    for (const pid of strays) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    for (const server of servers) server.close();
    for (const dir of decoys) {
      const link = path.join(dir, 'node_modules');
      try { if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link); } catch { /* not a fake root */ }
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
    fs.rmSync(out, { recursive: true, force: true, maxRetries: 5 });
  }

  console.log(failures.length ? `\n${failures.length} failed` : '\nall passed');
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
