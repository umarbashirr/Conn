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
  approve, finalReply, labelFor, newRun, nextStep, retry, revive, stageEnded, stageSession, stageStarted, stop,
} from '../../../shared/pipeline';
import { toast as sonner } from 'sonner';
import { onChatsGone, onTurnEnd } from '../lib/turn-events.js';
import { project as projectState } from '../../project.js';
import { grouped } from './rail-store';
import { headOf } from '../../../shared/chat-segments';
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
// What a run is called on screen. Older run files have no label.
export const nameOf = (run) => run.label || run.name;
const runOf = (id) => state.runs.find((r) => r.id === id) || null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

// Ids main will take for a file name: lowercase, digits and dashes.
const runId = () => `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/* The folders a run still needs: one running a stage or waiting at a gate.
   Main keeps them open when the window is full, the way it keeps a folder
   with a chat working in it, so a run's worktree is not closed under it. */
let held = '';
function holdFolders() {
  const dirs = [...new Set(state.runs.filter((r) => r.status === 'running' || r.status === 'waiting').map((r) => r.project))].sort();
  const key = JSON.stringify(dirs);
  if (key === held) return;
  held = key;
  conn().pipelines.hold?.(dirs).catch(() => { held = ''; });
}

function put(run) {
  const at = state.runs.findIndex((r) => r.id === run.id);
  if (at < 0) state.runs = [run, ...state.runs];
  else state.runs = state.runs.map((r) => (r.id === run.id ? run : r));
  changed();
  holdFolders();
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
    const revived = (saved || []).filter((r) => r && !known.has(r.id)).map((r) => {
      try { return revive(r); } catch { return null; }
    }).filter(Boolean);
    state.runs = [...state.runs, ...revived].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    for (const r of revived) if (r !== saved.find((x) => x.id === r.id)) put(r);
    holdFolders();
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
  const run = put(newRun({ id, pipeline, input: String(input).trim(), base: dir, project, label: labelFor(pipeline.name, state.runs) }));
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

    // The run's folder has to be open in this window for a chat to run in it.
    // A worktree closed since, or a run picked up after a restart, opens it.
    if (!(projectState.projects || []).some((p) => p.dir === run.project)) {
      const res = await conn().project.open({ dir: run.project }).catch((e) => ({ error: e.message }));
      if (res?.error || res?.canceled) {
        put(stageEnded(stageStarted(run, index, { chat: null }), index, { failed: true, error: `Could not open ${run.project}: ${res?.error || 'cancelled'}` }));
        return;
      }
    }

    // Which chat the stage goes to: its own, when it is sent again; the one a
    // `same:` stage continues; or a new one. A chat this window no longer
    // holds is taken up again from its saved session when it has one.
    const alive = (key) => (key && chats()?.chatOf(key) ? key : null);
    const into = step.chatOf ? run.stages.find((s) => s.id === step.chatOf) : null;
    const own = run.stages[index];
    let key = alive(step.reuse) || alive(into?.chat);
    const resume = key ? null : (own.session || into?.session || null);
    if (key) {
      // A chat carried on into another stage takes that stage's mode.
      if (stage.mode) await conn().agent.mode(key, stage.mode).catch(() => {});
    } else {
      key = await chats().spawn({
        project: run.project,
        provider: stage.provider,
        mode: stage.mode,
        model: stage.model,
        // A `same:` stage taking up its earlier stage's saved chat is that chat,
        // so it keeps that stage's name.
        title: `${nameOf(run)} · ${(!own.session && into?.session && resume ? into : stage).title}`,
        resume,
      });
    }
    put(stageStarted(runOf(id), index, { chat: key }));
    watchSession(id, index, key);
    await chats().sendTo(key, prompt);
  } finally {
    advancing.delete(id);
  }
}

/* The stage's session id, as soon as the chat has one. It is what the stage
   is found by after a restart, and the chat's name is written against it
   then, so the rail keeps "Feature · Plan" rather than the prompt's first
   line. A stage chat that changed agent is still known by its first session:
   a later one is only part of it. */
async function watchSession(id, index, key) {
  for (let i = 0; i < 300; i++) {
    const c = chats()?.chatOf(key);
    if (!c) return;
    const head = headOf(c);
    if (head) {
      const run = runOf(id);
      if (!run || run.stages[index]?.chat !== key) return;
      if (run.stages[index].session !== head) put(stageSession(run, index, head));
      if (c.renamed && c.title) conn().agent.rename(head, c.title).catch(() => {});
      return;
    }
    await sleep(200);
  }
}

/* Chats that left the window. A stage running in one cannot end any more,
   so the run fails there and Retry picks it up, from the saved session when
   there is one. Any stage pointing at one of them forgets the chat and keeps
   its session. */
function chatsLeft(keys) {
  const gone = new Set(keys);
  for (const run of state.runs) {
    if (!run.stages.some((s) => gone.has(s.chat))) continue;
    let next = run;
    const index = run.stages.findIndex((s) => gone.has(s.chat) && s.status === 'running');
    if (index >= 0 && run.status === 'running') {
      next = stageEnded(next, index, { failed: true, error: 'Its chat was closed.' });
    }
    next = { ...next, stages: next.stages.map((s) => (gone.has(s.chat) ? { ...s, chat: null } : s)) };
    put(next);
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
  let next = stageSession(now, index, headOf(c));
  next = stageEnded(next, index, { failed, error, output: finalReply(c?.items) });
  put(next);
  announce(next, index);
  advance(next.id);
}

// The "ready" toast of each run at a gate, so it goes when the gate does.
const gateToasts = new Map();
const dropGateToast = (id) => {
  if (gateToasts.has(id)) sonner.dismiss(gateToasts.get(id));
  gateToasts.delete(id);
};

function announce(run, index) {
  const stage = run.stages[index];
  const note = (body) => conn().agent.notify({ chat: stage.chat, title: nameOf(run), body });
  if (run.status === 'waiting') {
    gateToasts.set(run.id, toast(`${nameOf(run)}: ${stage.title} is ready`, 'Read it, reply if it needs changes, then Continue on the Board.'));
    note(`${stage.title} is ready for you`);
  } else if (run.status === 'failed') {
    toast(`${nameOf(run)}: ${stage.title} failed`, stage.error || 'Retry on the Board sends it again.');
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
  dropGateToast(id);
  put(approve(run, { output: reply || undefined }));
  advance(id);
}

export async function stopRun(id) {
  const run = runOf(id);
  if (!run) return;
  const live = run.stages.find((s) => s.status === 'running');
  dropGateToast(id);
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
  if (live) {
    window.connChat?.open({ key: stage.chat, title: live.title });
    return;
  }
  // A saved chat opens from disk, if the rail can see it there. One that was
  // deleted, or whose folder is closed, would open as an empty chat.
  // A stage saved before it was known by its chat's first session may name a
  // later one, which the rail lists under the first.
  const saved = stage.session && grouped().some((g) => g.rows.concat(g.done || [])
    .some((r) => r.id === stage.session || r.segments?.some((x) => x.session === stage.session)));
  if (!saved) {
    toast(`Could not open ${stage.title}`, 'Its chat was deleted, or its folder is not open in this window.');
    return;
  }
  window.connChat?.open({ id: stage.session, project: run.project, title: `${nameOf(run)} · ${stage.title}` });
}

// ------------------------------------------------------------ for the Board

/* The chat a run is waiting on you in, so the Board can put that chat in
   Needs you even though its turn is over. Keyed by chat key. */
export function gatedChats() {
  const out = new Map();
  for (const run of state.runs) {
    if (run.status !== 'waiting') continue;
    const st = run.stages.find((s) => s.status === 'gated');
    if (st?.chat) out.set(st.chat, { run: run.id, name: nameOf(run), stage: st.title });
  }
  return out;
}

// Which run and stage a chat belongs to, for its card.
export function stageOfChat(key) {
  for (const run of state.runs) {
    const st = run.stages.find((s) => s.chat === key);
    if (st) return { run: run.id, name: nameOf(run), stage: st.title };
  }
  return null;
}

if (typeof window !== 'undefined' && window.conn?.pipelines) {
  window.connPipelines = { open: openRunDialog };
  onTurnEnd((e) => { ended(e).catch((err) => console.error(err)); });
  onChatsGone(chatsLeft);
  loadRuns();
}
