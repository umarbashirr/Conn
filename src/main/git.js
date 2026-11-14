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

// Where git keeps the main checkout's .git, so every worktree of a repository
// lands under the same main folder rather than nesting inside another worktree.
async function commonRoot(dir) {
  const res = await new Promise((resolve) => {
    execFile('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: dir, timeout: 20000, windowsHide: true },
      (err, stdout) => resolve(err ? null : stdout.trim()));
  });
  return res ? path.dirname(res) : null;
}

// The same place Claude Code puts its worktrees, so a chat started in one by
// the CLI and a chat started here share the folder and the rail section.
const WORKTREES = path.join('.claude', 'worktrees');

// Keep the worktree folders out of the main checkout's git status without
// touching a tracked .gitignore.
function excludeWorktrees(common) {
  const file = path.join(common, '.git', 'info', 'exclude');
  const line = `/${WORKTREES.split(path.sep).join('/')}/`;
  try {
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (text.split('\n').some((l) => l.trim() === line)) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`);
  } catch { /* a read-only .git still gets its worktree, just a noisier status */ }
}

// A new branch from what `dir` has checked out, in its own folder. The folder
// name is the branch name with slashes flattened, so feat/x and feat-x clash
// and the second is refused rather than silently renamed.
async function addWorktree(dir, name) {
  if (!gitDir(dir)) return { ok: false, error: 'This folder is not a git repository.' };
  const next = typeof name === 'string' ? name.trim() : '';
  const why = branchNameError(next);
  if (why) return { ok: false, error: why };
  if (branches(dir).includes(next)) return { ok: false, error: 'That branch already exists.' };
  const common = await commonRoot(dir);
  if (!common) return { ok: false, error: 'Could not find the repository root.' };
  const target = path.join(common, WORKTREES, next.replace(/\//g, '-'));
  if (fs.existsSync(target)) return { ok: false, error: `${target} already exists.` };
  excludeWorktrees(common);
  const res = await gitRun(['worktree', 'add', '-b', next, target, 'HEAD'], dir);
  if (res.missing) return { ok: false, error: 'git is not installed.' };
  if (res.code !== 0) return { ok: false, error: said(res.stderr) };
  return { ok: true, dir: target, branch: next };
}

function gitOut(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 20000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout) => resolve(err ? null : stdout));
  });
}

// Every worktree of the repository `dir` belongs to, the main checkout first,
// read from git rather than from the folder, so ones made by `claude
// --worktree` or by hand in a terminal show too. Each linked one carries how
// far it has moved from the branch the main checkout is on, and how many files
// it has not committed.
async function listWorktrees(dir) {
  if (!gitDir(dir)) return { ok: false, error: 'This folder is not a git repository.', worktrees: [] };
  const text = await gitOut(['worktree', 'list', '--porcelain'], dir);
  if (text == null) return { ok: false, error: 'git worktree list failed.', worktrees: [] };
  const list = [];
  let cur = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('worktree ')) list.push(cur = { dir: path.resolve(line.slice(9)), branch: null, head: '', detached: false, prunable: false });
    else if (!cur) continue;
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5, 12);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'detached') cur.detached = true;
    else if (line.startsWith('prunable')) cur.prunable = true;
  }
  list.forEach((w, i) => { w.main = i === 0; });
  const base = list[0]?.branch || null;
  await Promise.all(list.map(async (w) => {
    if (w.main || w.prunable) return;
    const [counts, status] = await Promise.all([
      base && w.branch ? gitOut(['rev-list', '--left-right', '--count', `${base}...${w.branch}`], dir) : null,
      gitOut(['status', '--porcelain'], w.dir),
    ]);
    const m = /^(\d+)\s+(\d+)/.exec(counts || '');
    if (m) { w.behind = Number(m[1]); w.ahead = Number(m[2]); }
    w.dirty = status == null ? null : status.split('\n').filter(Boolean).length;
  }));
  return { ok: true, base, worktrees: list };
}

// Takes the folder away and keeps the branch, so the commits made there are
// still one `git switch` away. Uncommitted files stop it unless `force`.
async function removeWorktree(dir, target, force) {
  const { worktrees } = await listWorktrees(dir);
  const w = worktrees.find((x) => x.dir === path.resolve(target || ''));
  if (!w) return { ok: false, error: 'That is not a worktree of this repository.' };
  if (w.main) return { ok: false, error: 'The main checkout cannot be removed.' };
  const res = await gitRun(['worktree', 'remove', ...(force ? ['--force'] : []), w.dir], worktrees[0].dir);
  if (res.code !== 0) {
    const dirty = /contains modified or untracked files|is dirty/.test(res.stderr);
    return { ok: false, dirty, error: dirty ? 'It has uncommitted changes.' : said(res.stderr) };
  }
  return { ok: true, branch: w.branch };
}

module.exports = { addWorktree, branch, branches, gitDir, listWorktrees, removeWorktree, useBranch };
