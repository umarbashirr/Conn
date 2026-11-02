'use strict';
const { mergeResults } = require('./transcript-search');

const LIMIT = 20;

// The agent:search handler. A newer search from the same window aborts the one
// before it, because the palette has already stopped listening for its answer.
// Providers whose history has no search are named in titleOnly.
function createAgentSearch({ rows, dirs, owners }) {
  const running = new Map();

  return async (e, { query } = {}) => {
    const from = e.sender.id;
    running.get(from)?.abort();
    const ctl = new AbortController();
    running.set(from, ctl);
    try {
      const all = rows();
      const lists = await Promise.all(all.filter((row) => row.history.search).flatMap((row) => dirs().map(async (dir) => {
        try {
          const res = await row.history.search(dir, String(query || ''), { limit: LIMIT, signal: ctl.signal });
          return { ...res, provider: row.id, project: dir };
        } catch {
          return { hits: [], searched: 0, left: 0, provider: row.id, project: dir };
        }
      })));
      const merged = mergeResults(lists, LIMIT);
      for (const r of merged.results) owners.set(r.id, r.provider);
      return { ...merged, titleOnly: all.filter((row) => !row.history.search).map((row) => ({ id: row.id, label: row.label })) };
    } finally {
      if (running.get(from) === ctl) running.delete(from);
    }
  };
}

module.exports = { createAgentSearch };
