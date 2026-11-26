'use strict';
/* The Board's reach past this window: the cards every other Conn window
   publishes, and the Claude Code sessions running outside Conn.

   Each window holds its own chats and nothing else may drive them, so another
   window's cards are read over its bridge and a click on one asks that window
   to open it. The CLI's own list comes from `claude agents --json`, read only.

   Nothing here runs unless the Board is open: the renderer asks, and stops
   asking when it closes. */
const { spawn } = require('child_process');

const state = require('../../cli/state');
const { launchSpec, killTree } = require('./launch');
const shellEnv = require('./shell-env');
const { cleanSegments } = require('../shared/chat-segments');

// A window that does not answer in this long is skipped for this round rather
// than holding up the rest.
const PEER_TIMEOUT_MS = 1500;
// `claude agents --json` boots the CLI, which takes a second or two cold.
const LIST_TIMEOUT_MS = 10000;
// A Board asks every few seconds; one answer serves every ask inside this.
const LIST_FRESH_MS = 3000;
// More than this many cards from one window is not a board, it is a dump.
const MAX_CARDS = 200;
const MAX_LIST_BYTES = 2_000_000;

// What a card may carry between windows, and of what type. Anything else a
// window sends is dropped, so one window cannot hand another a field it then
// trusts.
const CARD_FIELDS = {
  id: 'string',
  key: 'string',
  session: 'string',
  title: 'string',
  project: 'string',
  provider: 'string',
  at: 'number',
  busy: 'boolean',
  waiting: 'boolean',
  agents: 'number',
  shells: 'number',
  failed: 'boolean',
  gate: 'boolean',
};

const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : undefined);

function cleanActivity(a) {
  if (!a || typeof a !== 'object' || typeof a.state !== 'string') return null;
  const line = text(a.line, 200);
  return { state: a.state.slice(0, 20), ...(line !== undefined && { line }) };
}

function cleanPipeline(p) {
  if (!p || typeof p !== 'object') return null;
  const name = text(p.name, 100);
  const stage = text(p.stage, 100);
  return { ...(name !== undefined && { name }), ...(stage !== undefined && { stage }) };
}

function cleanCard(c) {
  if (!c || typeof c !== 'object') return null;
  const out = {};
  for (const [k, type] of Object.entries(CARD_FIELDS)) {
    const v = c[k];
    if (typeof v !== type) continue;
    if (type === 'string') out[k] = v.slice(0, 500);
    else if (type === 'number') { if (Number.isFinite(v)) out[k] = v; } else out[k] = v;
  }
  if (!out.id) return null;
  const activity = cleanActivity(c.activity);
  if (activity) out.activity = activity;
  const pipeline = cleanPipeline(c.pipeline);
  if (pipeline) out.pipeline = pipeline;
  // A chat that changed agent: its sessions, so every window holds all of them
  // and none comes back as an outside card.
  const segments = cleanSegments(c.segments);
  if (segments) out.segments = segments.map(({ provider, session }) => ({ provider, session }));
  return out;
}

/* A window's list, cleaned. A chat is one card: a second card with the same
   key (or id, for one with no key) is dropped rather than drawn twice. */
function cleanCards(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list.slice(0, MAX_CARDS)) {
    const c = cleanCard(raw);
    const id = c && (c.key || c.id);
    if (!c || seen.has(id)) continue;
    seen.add(id);
    out.push(c);
  }
  return out;
}

async function ask(win, route, { method = 'GET', body } = {}) {
  const res = await fetch(`${win.url}${route}`, {
    method,
    headers: { 'x-conn-token': win.token, ...(body && { 'content-type': 'application/json' }) },
    ...(body && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${route} answered ${res.status}`);
  return res.json();
}

function createBoard({ claudeBin, windows = state.windows, pid = process.pid } = {}) {
  // What this window last published. Served to the others on GET /board.
  let mine = [];
  let listing = null;
  let listed = null;

  const others = () => windows().filter((w) => w.pid !== pid);

  return {
    publish(cards) {
      mine = cleanCards(cards);
      return mine.length;
    },

    cards: () => mine,

    // Each other window's cards. A window that does not answer is left out of
    // this round; it is still running, so the next round will try it again.
    async peers() {
      const answers = await Promise.all(others().map(async (w) => {
        try {
          const body = await ask(w, '/board');
          return { pid: w.pid, cwds: w.cwds, cards: cleanCards(body?.cards) };
        } catch {
          return null;
        }
      }));
      return answers.filter(Boolean);
    },

    // Asks the window that holds a chat to bring it forward. The card is the
    // one that window published, so only the fields it needs to find it go.
    async openOn(peerPid, card) {
      const w = others().find((x) => x.pid === peerPid);
      if (!w) return { error: 'That window has closed.' };
      try {
        const res = await ask(w, '/board/open', {
          method: 'POST',
          body: { key: card?.key || null, session: card?.session || null, project: card?.project || null, title: card?.title || null },
        });
        return res?.error ? { error: res.error } : { ok: true };
      } catch (e) {
        return { error: `That window did not answer: ${e.message}` };
      }
    },

    // `claude agents --json`, at most once per LIST_FRESH_MS however many
    // times it is asked. { ok, list } or { ok: false, unsupported | error }.
    outside() {
      if (listed && Date.now() - listed.at < LIST_FRESH_MS) return Promise.resolve(listed.answer);
      if (!listing) {
        listing = listSessions(claudeBin?.())
          .then((answer) => { listed = { at: Date.now(), answer }; return answer; })
          .finally(() => { listing = null; });
      }
      return listing;
    },
  };
}

function listSessions(bin) {
  if (!bin) return Promise.resolve({ ok: false, unsupported: true, error: 'claude is not installed' });
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    let child;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const spec = launchSpec(bin, ['agents', '--json']);
      child = spawn(spec.command, spec.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: shellEnv.env(),
        shell: spec.shell,
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } catch (e) {
      return finish({ ok: false, error: e.message });
    }
    const timer = setTimeout(() => { killTree(child); finish({ ok: false, error: 'claude agents did not answer' }); }, LIST_TIMEOUT_MS);
    child.stdout.on('data', (d) => { if (out.length < MAX_LIST_BYTES) out += d; });
    child.stderr.on('data', (d) => { if (err.length < 4096) err += d; });
    child.on('error', (e) => { clearTimeout(timer); finish({ ok: false, error: e.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(parseList(out, code, err));
    });
  });
}

/* What `claude agents --json` printed, as an answer. A CLI from before the
   command existed exits non-zero and says so on stderr; that is "unsupported",
   which hides the section, rather than an error worth showing. */
function parseList(out, code, err = '') {
  if (code !== 0) {
    const unknown = /unknown (command|option)|too many arguments|error: unknown/i.test(err) || /unknown (command|option)/i.test(out);
    return { ok: false, unsupported: unknown, error: (err || out).trim().split('\n')[0] || `exited ${code}` };
  }
  try {
    const list = JSON.parse(out);
    if (!Array.isArray(list)) return { ok: false, error: 'claude agents printed something other than a list' };
    return { ok: true, list };
  } catch {
    return { ok: false, error: 'claude agents printed something other than JSON' };
  }
}

module.exports = { createBoard, cleanCards, parseList };
