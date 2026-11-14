// What the chat overview says about one chat: where it runs, the panes to open,
// the PRs it opened, the files it changed and the work still running. No JSX,
// so plain node checks the same rules the panel is drawn by:
// scripts/overview-check.mjs.
import { statusOf, nameOf } from './subagents.js';
import { resolveFile } from './stacks.js';
import { toolText } from './tools.js';
import { turnEdits } from './turns.js';

export const FILES_SHOWN = 4;
export const PRS_SHOWN = 3;

const PLACES = ['changes', 'browser', 'terminal', 'files', 'worktrees'];
const FOLDERLESS_PLACES = ['browser', 'terminal'];

// Every item in transcript order, a subagent's own steps right after it.
function* walk(items) {
  for (const it of items) {
    yield it;
    if (it.children) yield* walk(it.children);
  }
}

// ------------------------------------------------------------------- header

const header = (_items, facts) => (facts.folderless ? null : { kind: 'header', name: facts.name, branch: facts.branch });

// ------------------------------------------------------------------- places

// How many entries each place lists under its row before "N more".
export const PLACE_ITEMS_SHOWN = 3;

const base = (p) => p.split('/').pop();
const parent = (p) => p.split('/').slice(0, -1).join('/');

// What each place has open, as rows under its heading. Every row carries the
// one thing the panel needs to bring it back: a tab, a changed file, the file
// in the Files pane, or a worktree folder.
function itemsOf(kind, facts) {
  if (kind === 'browser' || kind === 'terminal') {
    return (facts.tabs || []).filter((t) => t.kind === kind).map((t) => ({
      id: t.id, label: t.title || (kind === 'browser' ? 'New tab' : 'Terminal'), act: { tab: t.id },
    }));
  }
  if (kind === 'changes') {
    return (facts.changedFiles || []).map((f) => ({
      id: f.path, label: base(f.path), detail: parent(f.path), mark: f.status, act: { change: f.path },
    }));
  }
  if (kind === 'files') {
    return facts.openFile ? [{ id: facts.openFile, label: base(facts.openFile), detail: parent(facts.openFile), act: { file: facts.openFile } }] : [];
  }
  if (kind === 'worktrees') {
    return (facts.worktrees || []).filter((w) => !w.main && !w.prunable).map((w) => {
      const bits = [];
      if (w.ahead) bits.push(`↑${w.ahead}`);
      if (w.behind) bits.push(`↓${w.behind}`);
      if (w.dirty) bits.push(`${w.dirty} uncommitted`);
      return { id: w.dir, label: w.branch || w.head, detail: bits.join(' '), current: w.dir === facts.project, act: { worktree: w.dir } };
    });
  }
  return [];
}

function places(_items, facts) {
  const kinds = facts.folderless ? FOLDERLESS_PLACES : PLACES;
  return {
    kind: 'places',
    places: kinds.map((kind) => {
      const all = itemsOf(kind, facts);
      return {
        kind,
        open: facts.pane === kind,
        count: kind === 'changes' ? facts.changes : (kind === 'worktrees' ? all.length : null),
        // Kept for anything still reading the old shape.
        tabs: (facts.tabs || []).filter((t) => t.kind === kind),
        items: all.slice(0, PLACE_ITEMS_SHOWN),
        more: Math.max(0, all.length - PLACE_ITEMS_SHOWN),
      };
    }),
  };
}

// ---------------------------------------------------------------------- PRs

const PR_URL = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?!\w)/gi;
const PR_LINK = /\[([^\]]*)\]\((https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+[^)\s]*)\)/gi;
const PR_CREATE = /\bgh\s+pr\s+create\b/;
const TITLE_FLAG = /(?:--title|-t)(?:=|\s+)(?:"([^"]*)"|'([^']*)'|(\S+))/;

const prKey = (repo, number) => `${repo.toLowerCase()}#${number}`;

function* prUrls(text) {
  for (const [, owner, repo, number] of text.matchAll(PR_URL)) yield { repo: `${owner}/${repo}`, number: Number(number) };
}

// A label that is only the URL or the number says nothing the row does not.
function labelTitle(label) {
  const title = label.trim().replace(/^(?:PR\s*)?#\d+:\s*/i, '');
  return !title || /^#?\d+$/.test(title) || /^https?:\/\//.test(title) ? null : title;
}

function* linkTitles(text) {
  for (const [, label, url] of text.matchAll(PR_LINK)) {
    const title = labelTitle(label);
    const [pr] = prUrls(url);
    if (title && pr) yield { ...pr, title };
  }
}

// A title written as a shell variable or substitution is a placeholder, not
// the title the PR got.
const literal = (title) => (title && !/[$`]/.test(title) ? title : null);

// Only a PR this chat opened is listed. A chat that reads a handoff or reviews
// other work mentions many more, and those are not its own.
function opened(item) {
  if (item.kind !== 'tool' || item.output == null || !PR_CREATE.test(item.input?.command || '')) return [];
  const flag = TITLE_FLAG.exec(item.input.command);
  const title = literal(flag && (flag[1] ?? flag[2] ?? flag[3]));
  return [...prUrls(toolText(item.output))].map((pr) => ({ ...pr, title }));
}

// What one item says, as the PRs it opened and the titles it gives any PR.
function mentions(item) {
  const text = item.kind === 'assistant' ? item.text || '' : item.kind === 'tool' && item.output != null ? toolText(item.output) : '';
  const made = opened(item);
  return { prs: made, titles: [...linkTitles(text), ...made.filter((pr) => pr.title)] };
}

function prs(items) {
  const found = new Map();
  const titles = new Map();
  for (const item of walk(items)) {
    const said = mentions(item);
    for (const { repo, number } of said.prs) {
      const key = prKey(repo, number);
      if (!found.has(key)) found.set(key, { repo, number });
    }
    for (const { repo, number, title } of said.titles) {
      const key = prKey(repo, number);
      if (!titles.has(key)) titles.set(key, title);
    }
  }
  if (!found.size) return null;
  const list = [...found].reverse().map(([key, { repo, number }]) => ({
    url: `https://github.com/${repo}/pull/${number}`,
    repo,
    number,
    title: titles.get(key) ?? null,
  }));
  return { kind: 'prs', prs: list, repos: new Set(list.map((pr) => pr.repo.toLowerCase())).size };
}

// -------------------------------------------------------------------- files

function files(items, facts) {
  // Re-setting a path moves it to the end, so the map ends newest-touched last.
  const touched = new Map();
  for (const turn of turnEdits(items)) {
    for (const { path, added, removed } of turn.files) {
      const before = touched.get(path) || { added: 0, removed: 0 };
      touched.delete(path);
      touched.set(path, { path, added: before.added + added, removed: before.removed + removed });
    }
  }
  // A file outside the project, such as an agent's own notes, is not part of
  // the work this panel describes.
  const all = [...touched.values()].reverse()
    .map((f) => ({ ...f, rel: resolveFile(f.path, facts.project) }))
    .filter((f) => f.rel)
    .map((f) => ({ ...f, name: f.rel.split('/').pop(), dir: f.rel.split('/').slice(0, -1).join('/') }));
  if (!all.length) return null;
  return { kind: 'files', files: all.slice(0, FILES_SHOWN), total: all.length };
}

// --------------------------------------------------------------- background

const running = (it) => (it.kind === 'agent' || it.taskId) && it.background && statusOf(it) === 'running';

// Agents ahead of shells: an agent is work that will finish and want reading,
// a shell is usually a server that is meant to stay up. `at` is when it
// started, so the row can count up.
function background(items) {
  const tasks = [...walk(items)].filter(running).map((it) => (
    it.kind === 'agent'
      ? { id: it.id, kind: 'agent', name: nameOf(it), at: it.at || null }
      : { id: it.id, kind: 'shell', name: it.description || it.input?.description || it.input?.command, at: it.at || null }
  ));
  tasks.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'agent' ? -1 : 1));
  return tasks.length ? { kind: 'background', tasks } : null;
}

// ---------------------------------------------------------------------- all

// Running work first: it is the part that changes while you read.
const SECTIONS = [header, places, background, files, prs];

export function chatOverview(items, facts) {
  if (!items.length) return [];
  return SECTIONS.map((build) => build(items, facts)).filter(Boolean);
}
