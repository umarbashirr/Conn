/* The worktrees of each open folder's repository, read from git and shared by
   the Worktrees pane and the chat overview, so the two never disagree.

   Nothing tells us when an agent commits or leaves a file uncommitted, so a
   folder that someone is looking at is read again on a timer. A folder nobody
   is watching is not read at all. */
'use strict';
import { useEffect, useSyncExternalStore } from 'react';
import { onProject } from '../../project.js';

const POLL_MS = 5000;
const EMPTY = Object.freeze({ loading: true, ok: false, base: null, worktrees: [], error: '' });

const byDir = new Map();     // dir -> state
const watchers = new Map();  // dir -> count
const timers = new Map();    // dir -> interval
const inflight = new Map();  // dir -> promise
const listeners = new Set();
let version = 0;

const changed = () => { version++; for (const fn of listeners) fn(); };
const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const getVersion = () => version;

export const worktreesOf = (dir) => (dir && byDir.get(dir)) || EMPTY;

export function refreshWorktrees(dir) {
  if (!dir || !window.conn?.project?.worktrees) return Promise.resolve();
  if (inflight.has(dir)) return inflight.get(dir);
  const p = window.conn.project.worktrees(dir).catch(() => null).then((res) => {
    inflight.delete(dir);
    byDir.set(dir, {
      loading: false,
      ok: !!res?.ok,
      base: res?.base || null,
      worktrees: res?.worktrees || [],
      error: res?.ok ? '' : (res?.error || ''),
    });
    changed();
  });
  inflight.set(dir, p);
  return p;
}

// Opening and removing worktrees moves the set of open folders, which is
// the cheapest signal there is that a list has gone stale.
onProject(() => { for (const dir of watchers.keys()) refreshWorktrees(dir); });

function watch(dir) {
  watchers.set(dir, (watchers.get(dir) || 0) + 1);
  if (watchers.get(dir) === 1) {
    refreshWorktrees(dir);
    timers.set(dir, setInterval(() => refreshWorktrees(dir), POLL_MS));
  }
  return () => {
    const n = (watchers.get(dir) || 1) - 1;
    if (n > 0) { watchers.set(dir, n); return; }
    watchers.delete(dir);
    clearInterval(timers.get(dir));
    timers.delete(dir);
  };
}

// The list for `dir`, kept fresh while `active` is true.
export function useWorktrees(dir, active = true) {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  useEffect(() => (dir && active ? watch(dir) : undefined), [dir, active]);
  return worktreesOf(dir);
}
