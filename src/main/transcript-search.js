'use strict';
const MIN_QUERY = 2;
const MAX_QUERY = 200;
const BEFORE = 40;
const AFTER = 80;

const fold = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// A transcript stores a quote or a newline escaped, so the scan looks for the
// longest token in its escaped form; the full query is held against parsed text.
function parseQuery(raw) {
  const q = fold(raw).slice(0, MAX_QUERY).toLowerCase();
  if (q.length < MIN_QUERY) return null;
  const token = q.split(' ').reduce((a, b) => (b.length > a.length ? b : a), '');
  return { q, needle: JSON.stringify(token).slice(1, -1) };
}

function snippetOf(text, q) {
  const flat = fold(text);
  const at = flat.toLowerCase().indexOf(q);
  if (at < 0) return null;
  const from = Math.max(0, at - BEFORE);
  const to = Math.min(flat.length, at + q.length + AFTER);
  return `${from > 0 ? '…' : ''}${flat.slice(from, to)}${to < flat.length ? '…' : ''}`;
}

// Two open folders can share one transcript directory (/a/b.c and /a/b-c slug
// alike), and then both answer for the same chats.
function mergeResults(lists, limit) {
  const seen = new Map();
  for (const { hits, provider, project } of lists) {
    for (const h of hits) {
      const key = `${provider}:${h.id}`;
      if (!seen.has(key)) seen.set(key, { ...h, provider, project });
    }
  }
  return {
    results: [...seen.values()].sort((a, b) => b.at - a.at).slice(0, limit),
    searched: lists.reduce((n, l) => n + l.searched, 0),
    left: lists.reduce((n, l) => n + l.left, 0),
  };
}

function wordCache(maxChars) {
  const kept = new Map();
  let chars = 0;
  const weigh = (texts) => texts.reduce((n, t) => n + t.length, 0);
  const forget = (id) => {
    const old = kept.get(id);
    if (!old) return;
    chars -= weigh(old.texts);
    kept.delete(id);
  };
  return {
    get: (id, at) => (at && kept.get(id)?.at === at ? kept.get(id).texts : null),
    set(id, at, texts) {
      forget(id);
      const size = weigh(texts);
      if (!at || size > maxChars) return;
      for (const oldest of kept.keys()) {
        if (chars + size <= maxChars) break;
        forget(oldest);
      }
      kept.set(id, { at, texts });
      chars += size;
    },
    delete: forget,
  };
}

module.exports = { parseQuery, snippetOf, mergeResults, wordCache, MIN_QUERY };
