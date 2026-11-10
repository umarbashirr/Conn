'use strict';
// Whether a PR the chat opened is still open, a draft, merged or closed. The
// chat only ever sees the URL, so the state comes from `gh`, signed in as
// whoever the person is. Merged and closed do not change back often enough to
// ask twice; an open one is asked again after a minute. A PR gh cannot read
// (no gh, not signed in, no access) answers null and is left alone for a while
// rather than spawning on every repaint.
const { execFile } = require('child_process');
const shellEnv = require('./shell-env');

const OPEN_TTL_MS = 60_000;
const MISS_TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 15_000;
const MAX_PER_CALL = 20;
const SLUG = /^[\w.-]+\/[\w.-]+$/;

const cache = new Map();
const inflight = new Map();

const keyOf = (repo, number) => `${repo.toLowerCase()}#${number}`;

function stateOf({ state, isDraft }) {
  const s = String(state || '').toLowerCase();
  if (s === 'open') return isDraft ? 'draft' : 'open';
  return s === 'merged' || s === 'closed' ? s : null;
}

function ask(repo, number) {
  return new Promise((resolve) => {
    execFile(
      'gh',
      ['pr', 'view', String(number), '--repo', repo, '--json', 'state,isDraft'],
      { env: shellEnv.env(), timeout: TIMEOUT_MS, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        try { resolve(stateOf(JSON.parse(stdout))); } catch { resolve(null); }
      },
    );
  });
}

function fresh(hit, now) {
  if (!hit) return false;
  if (hit.state === 'merged' || hit.state === 'closed') return true;
  return now - hit.at < (hit.state ? OPEN_TTL_MS : MISS_TTL_MS);
}

async function one(repo, number) {
  const key = keyOf(repo, number);
  const hit = cache.get(key);
  if (fresh(hit, Date.now())) return hit.state;
  if (!inflight.has(key)) {
    inflight.set(key, ask(repo, number).then((state) => {
      cache.set(key, { state, at: Date.now() });
      inflight.delete(key);
      return state;
    }));
  }
  return inflight.get(key);
}

// { 'owner/repo#12': 'open' | 'draft' | 'merged' | 'closed' | null }
async function states(list) {
  const wanted = (Array.isArray(list) ? list : [])
    .filter((pr) => pr && SLUG.test(pr.repo || '') && Number.isInteger(pr.number) && pr.number > 0)
    .slice(0, MAX_PER_CALL);
  const out = {};
  await Promise.all(wanted.map(async ({ repo, number }) => {
    out[keyOf(repo, number)] = await one(repo, number);
  }));
  return out;
}

module.exports = { states, stateOf, keyOf };
