/* Pipeline runs in this window: starting them, moving them from stage to
   stage, and the gate, Stop and Retry.

   The rules are in shared/pipeline.js. This is the half that talks to chats:
   it starts a stage's chat off screen, sends the stage's prompt, waits for
   the turn to end, reads the reply, and asks the rules what happens next.
   Every step is written to disk by main, one file per run, so a window that
   restarts shows where each run stopped and can carry it on.

   Same shape as the other stores here: a version counter for
   useSyncExternalStore, and changed() to bump it. */
'use strict';
import {
  approve, finalReply, newRun, nextStep, retry, revive, stageEnded, stageSession, stageStarted, stop,
} from '../../../shared/pipeline';
import { onTurnEnd } from '../lib/turn-events.js';
import { toast } from './toast';

const state = { runs: [], loaded: false, dialog: false };
const listeners = new Set();
let version = 0;

export const getRunsVersion = () => version;
export const runsState = () => state;

export function subscribeRuns(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function changed() {
  version += 1;
  for (const fn of listeners) fn();
}

const conn = () => window.conn;
const chats = () => window.connChat;
const runOf = (id) => state.runs.find((r) => r.id === id) || null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

// Ids main will take for a file name: lowercase, digits and dashes.
const runId = () => `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function put(run) {
  const at = state.runs.findIndex((r) => r.id === run.id);
  if (at < 0) state.runs = [run, ...state.runs];
  else state.runs = state.runs.map((r) => (r.id === run.id ? run : r));
  changed();
  conn().pipelines.saveRun(run).then((res) => {
    if (res?.error) toast('Could not save the pipeline run', res.error);
  }).catch(() => {});
  return run;
}

// ------------------------------------------------------------ the dialog

export function openRunDialog() { state.dialog = true; changed(); }
export function closeRunDialog() { state.dialog = false; changed(); }

// ------------------------------------------------------------ loading

export async function loadRuns() {
  try {
    const saved = await conn().pipelines.runs();
    // A run that was mid-stage when its window went away is stopped now: its
    // CLI went with that window. Continue sends the stage again.
    const known = new Set(state.runs.map((r) => r.id));
    const revived = (saved || []).filter((r) => !known.has(r.id)).map((r) => revive(r));
    state.runs = [...state.runs, ...revived].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    for (const r of revived) if (r !== saved.find((x) => x.id === r.id)) put(r);
  } catch { /* the list stays as it was */ }
  state.loaded = true;
  changed();
}

// ------------------------------------------------------------ starting

const slug = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'run';

/**
 * Starts a pipeline in a folder. With `worktree: true` the folder is a fresh
 * worktree cut from it, opened in this window, and every stage runs there.
 *
 * @returns {Promise<{ ok: true, id: string } | { error: string }>}
 */
export async function startRun({ pipeline, input = '', dir }) {
  if (!pipeline || !dir) return { error: 'Pick a pipeline and a folder.' };
  if (pipeline.input && !String(input).trim()) return { error: `${pipeline.input} needs an answer.` };
  const id = runId();
  let project = dir;
  if (pipeline.worktree) {
    const words = String(input).trim() ? slug(input).slice(0, 16) : '';
    const name = [slug(pipeline.name), words, id.slice(-4)].filter(Boolean).join('-').replace(/-+/g, '-');
    const res = await conn().project.worktree(dir, name).catch((e) => ({ error: e.message }));
    if (!res?.ok) return { error: res?.error || 'Could not make the worktree.' };
    project = res.dir;
  }
  const run = put(newRun({ id, pipeline, input: String(input).trim(), base: dir, project }));
  advance(run.id);
  return { ok: true, id: run.id };
}

// ------------------------------------------------------------ moving on

const advancing = new Set();

/* Does whatever the run's next step is. Only one step per run at a time: a
   stage's turn can end while its next stage is still being started. */
async function advance(id) {
  if (advancing.has(id)) return;
  advancing.add(id);
  try {
    const run = runOf(id);
    if (!run) return;
    const step = nextStep(run);
    if (step.type !== 'send') return;
    const { index, stage, prompt } = step;

    const alive = (key) => (key && chats()?.chatOf(key) ? key : null);
    const continued = step.chatOf ? alive(run.stages.find((s) => s.id === step.chatOf)?.chat) : null;
    let key = alive(step.reuse) || continued;
    if (key) {
      // A chat carried on into another stage takes that stage's mode.
      if (stage.mode) await conn().agent.mode(key, stage.mode).catch(() => {});
    } else {
      key = await chats().spawn({
        project: run.project,
        provider: stage.provider,
        mode: stage.mode,
        model: stage.model,
        title: `${run.name} · ${stage.title}`,
      });
    }
    put(stageStarted(runOf(id), index, { chat: key }));
    await chats().sendTo(key, prompt);
  } finally {
    advancing.delete(id);
  }
}

/* A turn ended somewhere. If it was a stage's, read the reply and move the
   run on. The result lands a frame or two before the last streamed text is
   in the chat, so the reply is read once the chat has settled. */
async function settled(key) {
  for (let i = 0; i < 20; i++) {
    await frame();
    const c = chats()?.chatOf(key);
    if (!c || !c.busy) break;
    await sleep(50);
  }
  await frame();
  return chats()?.chatOf(key) || null;
}

async function ended({ chat, failed, error }) {
  const run = state.runs.find((r) => r.stages.some((s) => s.chat === chat && s.status === 'running'));
  if (!run) return;
  const index = run.stages.findIndex((s) => s.chat === chat && s.status === 'running');
  const c = await settled(chat);
  const now = runOf(run.id);
  if (!now || now.stages[index]?.status !== 'running') return;
  let next = stageSession(now, index, c?.session || null);
  next = stageEnded(next, index, { failed, error, output: finalReply(c?.items) });
  put(next);
  announce(next, index);
  advance(next.id);
}

function announce(run, index) {
  const stage = run.stages[index];
  const note = (body) => conn().agent.notify({ chat: stage.chat, title: run.name, body });
  if (run.status === 'waiting') {
    toast(`${run.name}: ${stage.title} is ready`, 'Read it, reply if it needs changes, then Continue on the Board.');
    note(`${stage.title} is ready for you`);
  } else if (run.status === 'failed') {
    note(`${stage.title} failed`);
  } else if (run.status === 'done') {
    note('Finished');
  }
}

// ------------------------------------------------------------ the buttons

/* Past a gate. The stage's reply is read again now, so a plan you talked
   over with the stage's chat goes on as it stands after that. */
export function continueRun(id) {
  const run = runOf(id);
  if (!run || run.status !== 'waiting') return;
  const gated = run.stages.find((s) => s.status === 'gated');
  const c = gated?.chat ? chats()?.chatOf(gated.chat) : null;
  if (c?.busy) {
    toast('That chat is still working', 'Wait for its turn to end, then Continue.');
    return;
  }
  const reply = c ? finalReply(c.items) : null;
  put(approve(run, { output: reply || undefined }));
  advance(id);
}

export async function stopRun(id) {
  const run = runOf(id);
  if (!run) return;
  const live = run.stages.find((s) => s.status === 'running');
  put(stop(run));
  if (live?.chat) await conn().agent.interrupt(live.chat).catch(() => {});
}

export function retryRun(id) {
  const run = runOf(id);
  if (!run) return;
  put(retry(run));
  advance(id);
}

export async function removeRun(id) {
  const run = runOf(id);
  if (!run || run.status === 'running' || run.status === 'waiting') return;
  state.runs = state.runs.filter((r) => r.id !== id);
  changed();
  await conn().pipelines.removeRun(id).catch(() => {});
}

// Opens one stage's chat, here or from disk by its session.
export function openStage(run, stage) {
  if (!stage?.chat && !stage?.session) return;
  const live = stage.chat && chats()?.chatOf(stage.chat);
  window.connChat?.open(live
    ? { key: stage.chat, title: live.title }
    : { id: stage.session, project: run.project, title: `${run.name} · ${stage.title}` });
}

// ------------------------------------------------------------ for the Board

/* The chat a run is waiting on you in, so the Board can put that chat in
   Needs you even though its turn is over. Keyed by chat key. */
export function gatedChats() {
  const out = new Map();
  for (const run of state.runs) {
    if (run.status !== 'waiting') continue;
    const st = run.stages.find((s) => s.status === 'gated');
    if (st?.chat) out.set(st.chat, { run: run.id, name: run.name, stage: st.title });
  }
  return out;
}

// Which run and stage a chat belongs to, for its card.
export function stageOfChat(key) {
  for (const run of state.runs) {
    const st = run.stages.find((s) => s.chat === key);
    if (st) return { run: run.id, name: run.name, stage: st.title };
  }
  return null;
}

if (typeof window !== 'undefined' && window.conn?.pipelines) {
  window.connPipelines = { open: openRunDialog };
  onTurnEnd((e) => { ended(e).catch((err) => console.error(err)); });
  loadRuns();
}
