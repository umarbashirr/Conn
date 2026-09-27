'use strict';
// Which branch the project folder is on, and the local branches it can move
// to. The name and the list are read from .git rather than forked: the chat
// pill asks on a timer, and a process every few seconds for one line is not
// worth it. Switching and creating do shell out, because those rewrite the
// worktree and the index, which is git's job.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { branchNameError, branchNameOk } = require('../shared/branch-name');

// A worktree or a submodule has a .git file holding "gitdir: <path>" rather
// than a directory, and that path is where HEAD actually lives.
function gitDir(dir) {
  let at = path.resolve(dir || '');
  for (;;) {
    const dot = path.join(at, '.git');
    try {
      const st = fs.statSync(dot);
      if (st.isDirectory()) return dot;
      if (st.isFile()) {
        const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dot, 'utf8'));
        if (m) return path.resolve(at, m[1].trim());
      }
    } catch {}
    const up = path.dirname(at);
    if (up === at) return null;
    at = up;
  }
}

function branch(dir) {
  const g = gitDir(dir);
  if (!g) return null;
  let head = '';
  try { head = fs.readFileSync(path.join(g, 'HEAD'), 'utf8').trim(); } catch { return null; }
  const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
  // Detached HEAD has no name to show, so show the commit it is sitting on.
  return m ? m[1] : (head ? head.slice(0, 7) : null);
}

// Every local branch, loose refs and packed ones. A name git would refuse is
// left out rather than offered as something to check out.
function branches(dir) {
  const g = gitDir(dir);
  if (!g) return [];
  const names = new Set();
  const walk = (at, prefix) => {
    let entries = [];
    try { entries = fs.readdirSync(at, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const name = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(path.join(at, ent.name), name);
      else if (ent.isFile() && branchNameOk(name)) names.add(name);
    }
  };
  walk(path.join(g, 'refs', 'heads'), '');
  try {
    const text = fs.readFileSync(path.join(g, 'packed-refs'), 'utf8');
    for (const line of text.split('\n')) {
      const m = /^[0-9a-fA-F]+\s+refs\/heads\/(\S+)$/.exec(line);
      if (m && branchNameOk(m[1])) names.add(m[1]);
    }
  } catch { /* no packed refs, or not readable */ }
  return [...names].sort((a, b) => a.localeCompare(b));
}

function gitRun(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 20000, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        code: err ? (err.code ?? 1) : 0,
        missing: err?.code === 'ENOENT',
        stderr: `${stderr || ''}\n${stdout || ''}`.trim(),
      });
    });
  });
}

const said = (text) => (text || '').split('\n').map((l) => l.trim()).filter(Boolean).pop() || 'Could not switch branch.';

// `create` makes the branch and moves onto it. Otherwise the name has to be
// one this repository already has. An old git without `switch` gets checkout.
async function useBranch(dir, name, create) {
  if (!gitDir(dir)) return { ok: false, error: 'This folder is not a git repository.' };
  const next = typeof name === 'string' ? name.trim() : '';
  const why = branchNameError(next);
  if (why) return { ok: false, error: why };
  const have = branches(dir);
  if (create) {
    if (have.includes(next)) return { ok: false, error: 'That branch already exists.' };
  } else if (!have.includes(next)) {
    return { ok: false, error: 'No such branch.' };
  }
  const modern = create ? ['switch', '-c', next] : ['switch', next];
  const older = create ? ['checkout', '-b', next] : ['checkout', next];
  let res = await gitRun(modern, dir);
  if (res.code !== 0 && /not a git command|unknown option/.test(res.stderr)) res = await gitRun(older, dir);
  if (res.missing) return { ok: false, error: 'git is not installed.' };
  if (res.code !== 0) return { ok: false, error: said(res.stderr) };
  return { ok: true, branch: branch(dir) };
}

module.exports = { branch, branches, gitDir, useBranch };
