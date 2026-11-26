#!/usr/bin/env node
/* Every scripts/*-check.* and scripts/check-*.mjs, one after another, the way
   the handoff harness runs the app: under xvfb-run (so a check that boots "on
   the screen" lands on a hidden display), with HOME and CONN_CWD in a
   throwaway conn-verify-* folder, and PATH on the harness's shims (real claude
   and codex, stub ACP agents, no provider tokens). Meanwhile every process
   that leaves the machine is noted, and an agent process doing so fails the
   run. Prints one line per check and the totals.

   ONLY=a,b runs just the checks whose file names contain one of those. */
import { SHIMS, cleanupShims, providerAddresses } from './handoff-harness.mjs';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const scripts = fs.readdirSync(path.join(ROOT, 'scripts'))
  .filter((n) => /-check\.(m?js)$/.test(n) || /^check-.*\.mjs$/.test(n))
  .filter((n) => !process.env.ONLY || process.env.ONLY.split(',').some((x) => n.includes(x)))
  .sort();
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-verify-suite-'));
const providers = await providerAddresses();
const seen = new Map();
const sample = () => {
  let out = '';
  try { out = execFileSync('ss', ['-tnpH'], { encoding: 'utf8' }); } catch { return; }
  for (const line of out.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || /^(127\.|\[::1\]|\[::ffff:127\.)/.test(cols[4])) continue;
    for (const m of line.matchAll(/\("([^"]+)",pid=(\d+)/g)) {
      let env = '';
      try { env = fs.readFileSync(`/proc/${m[2]}/environ`, 'utf8'); } catch {}
      let cmd = '';
      try { cmd = fs.readFileSync(`/proc/${m[2]}/cmdline`, 'utf8'); } catch {}
      // This run's processes: started on the shim PATH, under this HOME, or a
      // conn-verify / throwaway HOME one of the checks made.
      if (!(env.includes(SHIMS) || env.includes(`HOME=${home}`) || cmd.includes(ROOT) || /HOME=\/tmp\//.test(env))) continue;
      const peer = cols[4];
      const bare = peer.replace(/^\[|\](?=:)/g, '').replace(/:\d+$/, '').replace(/^::ffff:/, '');
      const bad = (m[1] !== 'electron' && m[1] !== 'git-remote-http') || providers.has(bare);
      seen.set(`${m[1]} ${peer}`, { proc: m[1], peer, host: providers.get(bare) || null, bad });
    }
  }
};
const timer = setInterval(sample, 300);

const results = [];
for (const name of scripts) {
  const env = { ...process.env, HOME: home, CONN_CWD: home };
  const started = Date.now();
  const code = await new Promise((resolve) => {
    const log = fs.openSync(path.join(home, `${name}.log`), 'w');
    const c = spawn('xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24', process.execPath, path.join('scripts', name)], { cwd: ROOT, env, stdio: ['ignore', log, log] });
    const kill = setTimeout(() => c.kill('SIGKILL'), 900000);
    c.on('exit', (c2) => { clearTimeout(kill); resolve(c2); });
  });
  results.push({ name, code, s: Math.round((Date.now() - started) / 1000) });
  console.log(`${code === 0 ? 'PASS' : 'FAIL'} ${name} (${results.at(-1).s}s)${code === 0 ? '' : ` log ${path.join(home, `${name}.log`)}`}`);
}
clearInterval(timer);
const off = [...seen.values()];
const bad = off.filter((x) => x.bad);
console.log(`NOTE off the machine: ${JSON.stringify(off.map((x) => `${x.proc} ${x.peer}${x.host ? ` (${x.host})` : ''}`))}`);
console.log(`${bad.length ? 'FAIL' : 'PASS'} no agent and no provider API was reached off the machine${bad.length ? ` ${JSON.stringify(bad)}` : ''}`);
const failed = results.filter((r) => r.code !== 0);
console.log(`\n${results.length - failed.length} of ${results.length} passed${failed.length ? `; failed: ${failed.map((r) => r.name).join(', ')}` : ''}. Logs in ${home}`);
cleanupShims();
process.exit(failed.length || bad.length ? 1 : 0);
