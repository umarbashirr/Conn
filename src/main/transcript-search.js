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

module.exports = { parseQuery, snippetOf, MIN_QUERY };
