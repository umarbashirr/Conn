import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boot, click, decided, evaluate, perm, say, shot, stop } from '../.claude/skills/verify/drive.mjs';

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

    for (const s of [a, b]) await stop(s);
    for (const s of [a, b]) {
      check(`no-process-holds-${path.basename(s.dir)}`, holders(s.dir).length === 0, holders(s.dir).join(','));
      check(`session-dir-removed-${path.basename(s.dir)}`, !fs.existsSync(s.dir), s.dir);
    }
    sessions.length = 0;
  } finally {
    for (const s of sessions) await stop(s).catch(() => {});
    fs.rmSync(out, { recursive: true, force: true, maxRetries: 5 });
  }

  console.log(failures.length ? `\n${failures.length} failed` : '\nall passed');
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
