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
function excludeWorktrees(common, line = `/${WORKTREES.split(path.sep).join('/')}/`) {
  const file = path.join(common, '.git', 'info', 'exclude');
  try {
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (text.split('\n').some((l) => l.trim() === line)) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`);
  } catch { /* a read-only .git still gets its worktree, just a noisier status */ }
}

const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock'];

const sameFile = (a, b) => {
  try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return false; }
};

// A fresh worktree has no node_modules, so its dev server and its tests fail
// until someone installs. Where the main checkout has one installed against
// the very same lockfile, the worktree borrows it through a link. A lockfile
// that differs gets nothing: a link to the wrong install fails in ways that are
// harder to read than a missing one. The root and one level down, which covers
// a mobile/ or site/ beside the app; deeper monorepos install for themselves.
function linkDependencies(main, tree) {
  const linked = [];
  const places = [''];
  try {
    for (const ent of fs.readdirSync(tree, { withFileTypes: true })) {
      if (ent.isDirectory() && !ent.name.startsWith('.') && ent.name !== 'node_modules') places.push(ent.name);
    }
  } catch { return linked; }
  for (const rel of places) {
    const from = path.join(main, rel, 'node_modules');
    const to = path.join(tree, rel, 'node_modules');
    const lock = LOCKFILES.find((f) => fs.existsSync(path.join(tree, rel, f)));
    if (!lock || !sameFile(path.join(main, rel, lock), path.join(tree, rel, lock))) continue;
    try {
      if (!fs.statSync(from).isDirectory() || fs.existsSync(to)) continue;
      // A junction on Windows needs no admin rights and no developer mode.
      fs.symlinkSync(from, to, process.platform === 'win32' ? 'junction' : 'dir');
      linked.push(rel || '.');
    } catch { /* nothing installed there, or no right to link: install by hand */ }
  }
  return linked;
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
  const linked = linkDependencies(common, target);
  // A .gitignore's `node_modules/` matches folders only, and a link is not one,
  // so it would show as a new file in the worktree's changes.
  if (linked.length) excludeWorktrees(common, 'node_modules');
  return { ok: true, dir: target, branch: next, linked };
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

// Run with the person's login shell environment, so a push finds their SSH
// agent or credential helper and gh finds its sign-in, as in a terminal.
function run(bin, args, cwd) {
  const env = require('./shell-env').env();
  return new Promise((resolve) => {
    execFile(bin, args, { cwd, env, timeout: 120000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, missing: err?.code === 'ENOENT', stdout: stdout || '', stderr: `${stderr || ''}\n${stdout || ''}`.trim() });
    });
  });
}

// The linked worktree `target` and the main checkout it belongs to, or why not.
async function pair(dir, target) {
  const { worktrees, base } = await listWorktrees(dir);
  const w = worktrees.find((x) => x.dir === path.resolve(target || ''));
  if (!w) return { error: 'That is not a worktree of this repository.' };
  if (w.main) return { error: 'That is the main checkout.' };
  if (!w.branch) return { error: 'That worktree is not on a branch.' };
  if (!base) return { error: 'The main checkout is not on a branch to merge into.' };
  return { w, main: worktrees[0], base };
}

// Merges the worktree's branch into the branch the main checkout is on, in the
// main checkout. Uncommitted work on either side stops it, because a merge
// would leave the worktree's behind and could trip over the main one's. A
// conflict is backed out, so the main checkout is never left mid-merge.
async function mergeWorktree(dir, target) {
  const p = await pair(dir, target);
  if (p.error) return { ok: false, error: p.error };
  const { w, main, base } = p;
  if (w.dirty) return { ok: false, error: `${w.dirty} uncommitted file${w.dirty === 1 ? '' : 's'} in the worktree. Commit or discard them first.` };
  const mainDirty = await gitOut(['status', '--porcelain', '--untracked-files=no'], main.dir);
  if (mainDirty == null) return { ok: false, error: 'Could not read the main checkout.' };
  if (mainDirty.trim()) return { ok: false, error: `The main checkout (${base}) has uncommitted changes.` };
  if (!w.ahead) return { ok: false, error: `Nothing to merge: ${w.branch} has no commits that ${base} lacks.` };
  const res = await run('git', ['merge', '--no-edit', w.branch], main.dir);
  if (res.code !== 0) {
    const conflict = /CONFLICT|Automatic merge failed/.test(res.stderr);
    if (conflict) await run('git', ['merge', '--abort'], main.dir);
    return { ok: false, conflict, error: conflict ? `${w.branch} conflicts with ${base}. Nothing was merged.` : said(res.stderr) };
  }
  return { ok: true, branch: w.branch, base, commits: w.ahead };
}

// Pushes the worktree's branch and opens a pull request into the base branch,
// or finds the one already open. gh signs in as whoever the terminal does.
async function openPr(dir, target) {
  const p = await pair(dir, target);
  if (p.error) return { ok: false, error: p.error };
  const { w, base } = p;
  if (!w.ahead) return { ok: false, error: `${w.branch} has no commits that ${base} lacks.` };
  const push = await run('git', ['push', '-u', 'origin', w.branch], w.dir);
  if (push.missing) return { ok: false, error: 'git is not installed.' };
  if (push.code !== 0) return { ok: false, error: said(push.stderr) };
  const existing = await run('gh', ['pr', 'view', w.branch, '--json', 'url,state', '-q', 'select(.state=="OPEN") | .url'], w.dir);
  if (existing.missing) return { ok: false, error: 'The branch is pushed, but the GitHub CLI (gh) is not installed.' };
  const url = existing.code === 0 && /https:\/\/\S+/.exec(existing.stdout)?.[0];
  if (url) return { ok: true, url, existed: true };
  const made = await run('gh', ['pr', 'create', '--fill', '--base', base, '--head', w.branch], w.dir);
  if (made.code !== 0) return { ok: false, error: said(made.stderr) };
  const link = /https:\/\/\S+/.exec(made.stdout)?.[0];
  return link ? { ok: true, url: link } : { ok: false, error: 'gh did not say where the pull request is.' };
}

module.exports = { addWorktree, mergeWorktree, openPr, branch, branches, gitDir, listWorktrees, removeWorktree, useBranch };
