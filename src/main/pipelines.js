'use strict';
/* Pipelines on disk: the files that define them, and the runs.

   A pipeline is a YAML file in a project's .conn/pipelines/ or in
   ~/.conn/pipelines/. Each is read and checked whole every time the list is
   asked for, so an edit shows up on the next open without a restart, and a
   file with a mistake in it is listed with the reason rather than skipped.

   A run is one JSON file in ~/.conn/runs/, written by the window driving it
   after every step. One file per run, so two windows running pipelines never
   write the same file. */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const projects = require('./projects');
const { checkPipeline } = require('../shared/pipeline');

const PROJECT_DIR = path.join('.conn', 'pipelines');
const MAX_FILE = 200_000;
const MAX_RUNS = 50;
const RUN_ID = /^[a-z0-9][a-z0-9-]{5,63}$/;
const MAX_RUN_BYTES = 2_000_000;

const userDir = () => path.join(projects.DIR, 'pipelines');
const runsDir = () => path.join(projects.DIR, 'runs');

const EXAMPLE = `# A Conn pipeline. Each stage runs in a chat of its own, in order.
# {{input}} is what you type at launch; {{plan}} is the plan stage's reply.
# Docs: https://github.com/umarbashirr/Conn/blob/main/docs/guide.md#pipelines
name: Feature
description: Plan, build, review and fix a change in its own worktree
input: What should be built?
worktree: true
stages:
  - id: plan
    prompt: |
      Plan this change. Read the code you need first.
      Reply with a short numbered plan and nothing else.

      {{input}}
    mode: plan
    gate: true

  - id: build
    prompt: |
      Implement this plan. Keep the change focused and run the tests.

      {{plan}}
    mode: auto

  - id: review
    prompt: |
      Review the uncommitted changes in this folder for bugs, missed cases
      and anything the plan asked for that is not done. Reply with a list of
      findings, or "No findings."
    mode: plan

  - id: fix
    prompt: |
      Fix these review findings. If there are none, say so and stop.

      {{review}}
    mode: auto
    same: build
`;

function readOne(file, scope) {
  const name = path.basename(file).replace(/\.ya?ml$/i, '');
  const base = { id: `${scope}:${name}`, scope, file, name };
  let text;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    if (st.size > MAX_FILE) return { ...base, ok: false, error: 'The file is larger than 200 KB.' };
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { ...base, ok: false, error: `Could not read it: ${e.message}` };
  }
  let raw;
  try {
    raw = yaml.load(text);
  } catch (e) {
    return { ...base, ok: false, error: `The YAML does not parse: ${e.reason || e.message}${e.mark ? ` (line ${e.mark.line + 1})` : ''}` };
  }
  const res = checkPipeline(raw);
  return res.ok ? { ...base, ok: true, pipeline: res.pipeline } : { ...base, ok: false, error: res.error };
}

function readDir(dir, scope) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /\.ya?ml$/i.test(n)).sort(); } catch { return []; }
  return names.map((n) => readOne(path.join(dir, n), scope)).filter(Boolean);
}

/* Every pipeline a folder can run: its own first, then yours. A project file
   and one of yours with the same name are both listed, marked by where each
   came from, since they may well differ. */
function list(dir) {
  const own = dir ? readDir(path.join(dir, PROJECT_DIR), 'project') : [];
  return [...own, ...readDir(userDir(), 'user')];
}

// Writes the example into ~/.conn/pipelines, or leaves one already there alone.
function writeExample() {
  const dir = userDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'feature.yml');
  if (!fs.existsSync(file)) fs.writeFileSync(file, EXAMPLE);
  return { ok: true, file, dir };
}

// ------------------------------------------------------------------ runs

// A window that may still be driving a run. Same test the bridge files use.
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/* Saving a run marks it as this window's. The window that saved it last is
   the one driving it, and no other window touches it while that one is up. */
function saveRun(run, { pid = process.pid } = {}) {
  if (!run || typeof run !== 'object' || typeof run.id !== 'string' || !RUN_ID.test(run.id)) return { error: 'not a run' };
  const theirs = readRun(run.id);
  if (theirs && theirs.owner !== pid && alive(theirs.owner)) return { error: 'another window is running that pipeline' };
  const body = JSON.stringify({ ...run, owner: pid });
  if (body.length > MAX_RUN_BYTES) return { error: 'that run is too large to keep' };
  const dir = runsDir();
  fs.mkdirSync(dir, { recursive: true });
  // Written beside and renamed over, so a crash mid-write cannot leave half a run.
  const file = path.join(dir, `${run.id}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, file);
  prune(dir);
  return { ok: true };
}

// The newest MAX_RUNS stay. A run older than that is history nobody opens.
function prune(dir) {
  let names;
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return; }
  if (names.length <= MAX_RUNS) return;
  const aged = names.map((n) => {
    try { return { n, t: fs.statSync(path.join(dir, n)).mtimeMs }; } catch { return { n, t: 0 }; }
  }).sort((a, b) => b.t - a.t);
  for (const { n } of aged.slice(MAX_RUNS)) { try { fs.unlinkSync(path.join(dir, n)); } catch {} }
}

const isRun = (run) => !!run && typeof run.id === 'string' && RUN_ID.test(run.id) && Array.isArray(run.stages) && !!run.pipeline;

function readRun(id) {
  try {
    const run = JSON.parse(fs.readFileSync(path.join(runsDir(), `${id}.json`), 'utf8'));
    return isRun(run) ? run : null;
  } catch {
    return null;
  }
}

/* The runs this window may show and drive: its own, and any whose window has
   gone, which are this window's to pick up. A run another live window is
   driving is that window's, and its chats are on the Board through it. */
function listRuns({ pid = process.pid } = {}) {
  const dir = runsDir();
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const n of names) {
    const run = readRun(n.slice(0, -'.json'.length));
    if (!run) continue;
    if (run.owner !== pid && alive(run.owner)) continue;
    out.push(run);
  }
  return out.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)).slice(0, MAX_RUNS);
}

function removeRun(id, { pid = process.pid } = {}) {
  if (typeof id !== 'string' || !RUN_ID.test(id)) return { error: 'not a run' };
  const theirs = readRun(id);
  if (theirs && theirs.owner !== pid && alive(theirs.owner)) return { error: 'another window is running that pipeline' };
  try { fs.unlinkSync(path.join(runsDir(), `${id}.json`)); } catch {}
  return { ok: true };
}

module.exports = { list, writeExample, saveRun, listRuns, removeRun, userDir, runsDir, PROJECT_DIR, EXAMPLE };
