'use strict';
/* conn_thread_read: reading this chat's own earlier items, by the ids a
   handoff names or by paging and searching, for an agent the chat was handed
   to. The definition is shared by Conn's MCP server and the in-process tools
   Claude gets, and the picking is pure so a check can hold it.

   An answer is the chat's items in the handoff's own labelled form, oldest
   first, capped near CAP tokens, and when more remain it says how to ask for
   them: `next` is the arguments of the call that continues. */
const { tokens } = require('./handoff');

const NAME = 'conn_thread_read';
const CAP = 8000;
const LIMIT = 20;
const MAX_LIMIT = 50;

const DESCRIPTION = 'Read earlier items of this chat: by ids a handoff names, around or before an id, or matching query. Oldest first.';

function schema(z) {
  return {
    ids: z.array(z.string()).max(MAX_LIMIT).optional(),
    around: z.string().optional(),
    before: z.string().optional(),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
    query: z.string().max(200).optional(),
  };
}

// One entry cut to fit what is left, for an item larger than a whole answer.
function cut(e, room) {
  const keep = Math.max(200, room * 4 - 200);
  if (e.text.length <= keep) return e;
  return { ...e, text: `${e.text.slice(0, keep)}\n… ${e.text.length - keep} more characters of ${e.id}, too long for one answer\n</item>`, tokens: room };
}

// Whole entries from the front of `list` while they fit, the first one cut if
// it alone does not. Returns what fit and how many of `list` that was.
function fill(list, cap) {
  const out = [];
  let room = cap;
  for (const e of list) {
    if (e.tokens <= room) {
      out.push(e);
      room -= e.tokens;
      continue;
    }
    if (!out.length) out.push(cut(e, room));
    break;
  }
  return out;
}

/* Which entries answer `args`, from the chat's entries in order. Returns
   { entries, missing, next, error }. */
function pick(all, args = {}, { cap = CAP } = {}) {
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isInteger(args.limit) ? args.limit : LIMIT));
  const at = (id) => all.findIndex((e) => e.id === id);

  if (Array.isArray(args.ids) && args.ids.length) {
    const wanted = new Set(args.ids);
    const found = all.filter((e) => wanted.has(e.id));
    const missing = args.ids.filter((id) => at(id) < 0);
    const shown = fill(found.slice(0, limit), cap);
    const rest = found.slice(shown.length).map((e) => e.id);
    return { entries: shown, missing, ...(rest.length && { next: { ids: rest } }) };
  }

  if (args.around) {
    const i = at(args.around);
    if (i < 0) return { entries: [], missing: [args.around] };
    const from = Math.max(0, i - Math.floor((limit - 1) / 2));
    const window = all.slice(from, from + limit);
    // Grown out from the id itself, so a cap keeps what is nearest it.
    const order = window.map((e, k) => k).sort((a, b) => Math.abs(from + a - i) - Math.abs(from + b - i));
    let room = cap;
    const keep = new Set();
    for (const k of order) {
      if (window[k].tokens > room) { if (!keep.size) keep.add(k); break; }
      keep.add(k);
      room -= window[k].tokens;
    }
    const entries = window.filter((_, k) => keep.has(k)).map((e) => (e.tokens > cap ? cut(e, cap) : e));
    return { entries, missing: [], ...(from > 0 && { next: { before: entries[0].id, limit } }) };
  }

  // Paging back, alone or through what matched a search.
  let end = all.length;
  if (args.before) {
    end = at(args.before);
    if (end < 0) return { entries: [], missing: [args.before] };
  }
  const q = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
  const pool = all.slice(0, end).filter((e) => !q || (e.kind === 'message' && e.body.toLowerCase().includes(q)));
  // The newest that fit, counted back from the end; told oldest first.
  const tail = [];
  let room = cap;
  for (let k = pool.length - 1; k >= 0 && tail.length < limit; k--) {
    const e = pool[k];
    if (e.tokens > room) { if (!tail.length) tail.push(cut(e, room)); break; }
    tail.push(e);
    room -= e.tokens;
  }
  const entries = tail.reverse();
  const more = pool.length > entries.length;
  return {
    entries,
    missing: [],
    ...(more && entries.length && { next: { ...(q && { query: args.query }), before: entries[0].id, ...(args.limit && { limit }) } }),
  };
}

// The text an agent gets back.
function answer({ entries, missing = [], next, total }) {
  const lines = [`${entries.length} of this chat's ${total} items, oldest first.`];
  if (missing.length) lines.push(`Not in this chat: ${missing.join(', ')}.`);
  for (const e of entries) lines.push(e.text);
  if (next) lines.push(`More: call ${NAME} with ${JSON.stringify(next)}`);
  return lines.join('\n');
}

// How many items an answer carried, read back off its first line, for the
// transcript's row.
const countOf = (text) => {
  const m = /^(\d+) of this chat's \d+ items/.exec(String(text || ''));
  return m ? Number(m[1]) : null;
};

module.exports = { NAME, CAP, LIMIT, DESCRIPTION, schema, pick, answer, countOf, tokens };
