'use strict';
// How every agent CLI is started, so the Windows rules live in one place.
//
// npm's global install on Windows is a batch wrapper (claude.cmd, codex.cmd,
// opencode.cmd ...), and since CVE-2024-27980 Node refuses to spawn a .cmd or
// .bat without a shell: the spawn throws EINVAL. Going through cmd.exe instead
// mangles JSON and quoted arguments, and stopping the chat then kills cmd.exe
// while the agent under it keeps running. So read the wrapper and run what it
// points at: a native .exe directly, or a .js under node.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const WIN = process.platform === 'win32';
const isJs = (p) => /\.[cm]?js$/i.test(p || '');
const isBatch = (p) => /\.(cmd|bat)$/i.test(p || '');

function unwrapShim(p) {
  if (!isBatch(p)) return p;
  let text = '';
  try { text = fs.readFileSync(p, 'utf8'); } catch { return p; }
  const dir = path.dirname(p);
  for (const m of text.matchAll(/"%~?dp0%?\\?([^"%]+\.(?:exe|js|mjs|cjs))"/gi)) {
    const target = path.join(dir, ...m[1].split(/[\\/]/));
    if (/(^|[\\/])node\.exe$/i.test(target)) continue;
    try { if (fs.existsSync(target)) return fs.realpathSync(target); } catch {}
  }
  return p;
}

// What to hand spawn() for this binary and these arguments. `shell` is set only
// for a wrapper nobody could read, which is the old behaviour and still better
// than an EINVAL.
function launchSpec(bin, args = []) {
  const real = unwrapShim(bin);
  if (isJs(real)) return { command: 'node', args: [real, ...args], shell: false };
  if (isBatch(real)) return { command: `"${real}"`, args, shell: true };
  return { command: real, args, shell: false };
}

// A command line for one of the app's own terminals. PowerShell, the Windows
// default, needs & to run a quoted path; POSIX shells take it as is.
function commandLine(bin, args = []) {
  const spec = launchSpec(bin, args);
  const command = spec.shell ? spec.command.slice(1, -1) : spec.command;
  if (WIN) {
    const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
    return `& ${[command, ...spec.args].map(q).join(' ')}`;
  }
  const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
  return [command, ...spec.args].map(q).join(' ');
}

// Stop a child and everything it started. Windows has no process groups, and
// child.kill() there ends the one process, so an agent's own workers and
// language servers outlive the chat. taskkill /T takes the tree.
function killTree(child) {
  if (!child?.pid) return;
  try {
    if (WIN) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    else process.kill(-child.pid, 'SIGTERM');
  } catch {}
}

module.exports = { unwrapShim, launchSpec, commandLine, killTree, isJs };
