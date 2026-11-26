/* The safe way to boot Conn for the handoff repros.

   - Every spawn the verify driver makes is checked before it happens: HOME and
     CONN_CWD must sit inside a throwaway conn-verify-* folder, and PATH must
     not reach the real CLIs. A spawn that fails the check throws.
   - PATH is a shim folder: claude and codex are the real CLIs (claude talks to
     the driver's stand-in API, codex to fake-responses-api.mjs through a
     config written into the throwaway HOME); copilot, cursor-agent, opencode
     and grok are stub-acp-agent.mjs. No ACP agent with a real login runs.
   - `watchNet` samples the session's processes' TCP connections and reports
     any that leave the machine.

   Import this before anything imports the verify driver. */
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports, createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.resolve(os.tmpdir());
const REAL_BIN_DIRS = [path.join(os.homedir(), '.local/bin'), path.join(os.homedir(), '.opencode/bin'), path.join(os.homedir(), '.grok/bin'), path.join(os.homedir(), '.hermes')];

export const SHIMS = fs.mkdtempSync(path.join(TMP, 'hv-shims-'));
export const STUB_LOG = path.join(SHIMS, 'stub-acp.jsonl');
const which = (name) => childProcess.execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim();
const nodeBin = process.execPath;
fs.symlinkSync(nodeBin, path.join(SHIMS, 'node'));
fs.symlinkSync(fs.realpathSync(which('claude')), path.join(SHIMS, 'claude'));
// codex.js is a node script; run it with the node above rather than whichever env finds.
fs.writeFileSync(path.join(SHIMS, 'codex'), `#!/bin/sh\nexec ${JSON.stringify(nodeBin)} ${JSON.stringify(fs.realpathSync(which('codex')))} "$@"\n`, { mode: 0o755 });
const initMs = process.env.STUB_ACP_INIT_MS || '';
for (const name of ['copilot', 'cursor-agent', 'opencode', 'grok']) {
  fs.writeFileSync(path.join(SHIMS, name), [
    '#!/bin/sh',
    `export STUB_ACP_NAME=${name} STUB_ACP_LOG=${JSON.stringify(STUB_LOG)}${initMs ? ` STUB_ACP_INIT_MS=${initMs}` : ''}${process.env.STUB_ACP_DELETE ? ` STUB_ACP_DELETE=${process.env.STUB_ACP_DELETE}` : ''}`,
    `exec ${JSON.stringify(nodeBin)} ${JSON.stringify(path.join(ROOT, 'scripts/stub-acp-agent.mjs'))} "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
}
// git and xvfb-run and the rest of the system stay reachable.
process.env.PATH = [SHIMS, '/usr/local/bin', '/usr/bin', '/bin'].join(path.delimiter);
for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_GITHUB_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CURSOR_API_KEY', 'XAI_API_KEY']) delete process.env[k];

const inThrowaway = (p) => typeof p === 'string' && path.resolve(p).startsWith(`${TMP}${path.sep}conn-verify-`);
export function assertSafeEnv(env, what) {
  const bad = [];
  if (!inThrowaway(env.HOME)) bad.push(`HOME=${env.HOME}`);
  if (what === 'app' && !inThrowaway(env.CONN_CWD)) bad.push(`CONN_CWD=${env.CONN_CWD}`);
  const dirs = String(env.PATH || '').split(path.delimiter);
  for (const d of dirs) if (REAL_BIN_DIRS.some((r) => d === r || d.startsWith(`${r}/`))) bad.push(`PATH has ${d}`);
  if (bad.length) throw new Error(`refusing to spawn ${what}: ${bad.join(', ')}`);
}

// Checked before every spawn the driver makes.
const spawn0 = childProcess.spawn;
childProcess.spawn = function checkedSpawn(cmd, args, opts) {
  const argv = Array.isArray(args) ? args : [];
  const isApp = /xvfb-run|electron/.test(String(cmd)) || argv.some((a) => /electron/.test(String(a)));
  if (isApp || opts?.env?.HOME) assertSafeEnv(opts?.env || process.env, isApp ? 'app' : String(cmd));
  if (isApp && !/xvfb-run/.test(String(cmd))) throw new Error('refusing to launch the app off Xvfb');
  return spawn0.call(this, cmd, args, opts);
};
syncBuiltinESMExports();

export const drive = await import(path.join(ROOT, '.claude/skills/verify/drive.mjs'));

/* Boot on Xvfb with the real claude CLI against the stand-in API, then point
   codex at a local fake and confirm, from inside the app, that every agent it
   would run is a local one. */
export async function safeBoot({ codexPort }) {
  const s = await drive.boot({ xvfb: true, claude: true });
  const main = (e) => drive.evaluate(s, e, { main: true });
  const env = JSON.parse(await main('JSON.stringify(process.env)'));
  assertSafeEnv(env, 'app');
  fs.mkdirSync(path.join(s.home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(s.home, '.codex/config.toml'), [
    'model_provider = "fake"', '', '[model_providers.fake]', 'name = "fake"',
    `base_url = "http://127.0.0.1:${codexPort}/v1"`, 'wire_api = "responses"', 'request_max_retries = 0', 'stream_max_retries = 0', '',
  ].join('\n'));
  // The history server may have started before the config; it lists by provider.
  await main("(() => { req('./codex-history').close(); const { Driver } = req('./driver'); const orig = Driver.prototype.current; Driver.prototype.current = function (o) { const r = orig.call(this, o); return r.models.length ? r : { ...r, models: [{ value: 'claude-opus-5-5', displayName: 'Opus 5.5 (stand-in)' }] }; }; return 1; })()");
  const shellPath = await main("req('./shell-env').ready().then(() => req('./shell-env').cached())");
  for (const d of String(shellPath).split(':')) {
    if (REAL_BIN_DIRS.some((r) => d === r || d.startsWith(`${r}/`))) throw new Error(`the app's login-shell PATH reaches ${d}`);
  }
  return s;
}

/* Every few hundred ms, the session's processes' TCP connections that leave
   the machine. An agent process (claude, codex, a stub) doing so fails the
   run, and so does any process reaching a provider's API host. The app's own
   update checks and the dictation model download are reported, not failed:
   they use no account. */
const PROVIDER_HOSTS = ['api.anthropic.com', 'api.openai.com', 'chatgpt.com', 'api.githubcopilot.com', 'api.individual.githubcopilot.com',
  'copilot-proxy.githubusercontent.com', 'api2.cursor.sh', 'api.cursor.com', 'api.x.ai', 'opencode.ai'];
const bare = (peer) => peer.replace(/^\[|\](?=:)/g, '').replace(/:\d+$/, '').replace(/^::ffff:/, '');
export async function providerAddresses() {
  const dns = await import('node:dns/promises');
  const out = new Map();
  for (const h of PROVIDER_HOSTS) {
    for (const fam of [4, 6]) {
      try { for (const a of await dns.lookup(h, { all: true, family: fam })) out.set(a.address, h); } catch {}
    }
  }
  return out;
}
export function watchNet(s, providers = new Map()) {
  const seen = new Map();
  const owned = (pid) => {
    const env = (() => { try { return fs.readFileSync(`/proc/${pid}/environ`, 'utf8'); } catch { return ''; } })();
    const cmd = (() => { try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { return ''; } })();
    return env.includes(`HOME=${s.home}\0`) || cmd.includes(s.dir) || cmd.includes(SHIMS);
  };
  const tick = () => {
    let out = '';
    try { out = childProcess.execFileSync('ss', ['-tnpH'], { encoding: 'utf8' }); } catch { return; }
    for (const line of out.split('\n')) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 5) continue;
      const peer = cols[4];
      if (/^(127\.|\[::1\]|\[::ffff:127\.)/.test(peer)) continue;
      for (const m of line.matchAll(/\("([^"]+)",pid=(\d+)/g)) {
        if (!owned(m[2])) continue;
        const host = providers.get(bare(peer)) || null;
        // git fetching a public repository over https (codex syncs its plugin list
        // at startup) uses no account; it is reported with the app's traffic.
        const agent = m[1] !== 'electron' && m[1] !== 'git-remote-http';
        seen.set(`${m[1]} -> ${peer}`, { proc: m[1], pid: m[2], peer, host, bad: agent || !!host });
      }
    }
  };
  const timer = setInterval(tick, 300);
  return { stop: () => { clearInterval(timer); const all = [...seen.values()]; return { bad: all.filter((x) => x.bad), app: all.filter((x) => !x.bad) }; } };
}

export function cleanupShims() {
  fs.rmSync(SHIMS, { recursive: true, force: true });
}

export const requireRoot = createRequire(path.join(ROOT, 'package.json'));
