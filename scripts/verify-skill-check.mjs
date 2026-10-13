/* The verify skill, run for real. Two instances boot at once on throwaway
   HOMEs, one on the screen and one under Xvfb, and must not share a port or a
   data dir. Each must paint a window the skill can photograph, and say, perm
   and click must reach the app and its main process. With the preview open on
   the shop page, a shot and a recording must hold the page's pixels inside
   #paneslot, and a shot must not when the preview is hidden or left out.
   `sessions` lists what was booted, and stop refuses any folder a boot did not
   make, or a pid that does not lead this session's process group. After stop no
   process may still name either instance's folder, by command line,
   environment or working directory. Needs a built renderer: `npx vite build`
   first. */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, bounds, click, decided, evaluate, invoke, key, perm, record, say, sessions as listed, shot, stop } from '../.claude/skills/verify/drive.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
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

    for (const s of [a, b]) await stop(s);
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
    for (const dir of decoys) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    fs.rmSync(out, { recursive: true, force: true, maxRetries: 5 });
  }

  console.log(failures.length ? `\n${failures.length} failed` : '\nall passed');
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
