/* What the address bar offers under what you have typed: places you have been
   or bookmarked, matched here on the machine, and the inline completion that
   turns "not" into "notion.so" the way a browser's address bar does. Search
   suggestions come from main; see searchSuggestions in main/browser.js. */

import { SEARCH_ENGINES, DEFAULT_ENGINE, engineOf } from '../../../shared/search-engines';

export { SEARCH_ENGINES, DEFAULT_ENGINE };
export const engineLabel = (id) => engineOf(id).label;
// What a picked search row opens: the engine's results page, never the phrase
// itself, which would go back through address parsing and turn "vue.js" into
// https://vue.js.
export const searchUrl = (phrase, id) => engineOf(id).search(phrase);

const MAX_PLACES = 5;

function split(url) {
  const m = /^(https?:\/\/)?([^/?#]*)(.*)$/i.exec(String(url || ''));
  const scheme = (m[1] || 'https://').toLowerCase();
  const host = m[2].toLowerCase();
  const rest = m[3] === '/' ? '' : m[3];
  return { scheme, host, bare: host.replace(/^www\./, ''), rest };
}

// Recents first, then bookmarks, one row per address.
export function places(recents, bookmarks) {
  const seen = new Set();
  const out = [];
  for (const [list, kind] of [[recents, 'history'], [bookmarks, 'bookmark']]) {
    for (const e of list || []) {
      if (!e?.url || seen.has(e.url)) continue;
      seen.add(e.url);
      out.push({ ...e, kind });
    }
  }
  return out;
}

export function matchPlaces(typed, entries, max = MAX_PLACES) {
  const q = String(typed || '').trim().toLowerCase().replace(/^https?:\/\//, '');
  if (!q) return [];
  const scored = [];
  entries.forEach((e, order) => {
    const { host, bare, rest } = split(e.url);
    const address = bare + rest;
    const title = String(e.title || '').toLowerCase();
    let score = 0;
    const oneWord = !/[\s./-]/.test(q);
    if (bare.startsWith(q) || host.startsWith(q) || address.startsWith(q)) score = 3;
    else if (title.startsWith(q) || (oneWord && wordsOf(`${host} ${title}`).some((w) => w.startsWith(q)))) score = 2;
    else if (address.includes(q) || title.includes(q)) score = 1;
    if (score) scored.push({ e, score, order });
  });
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.slice(0, max).map(({ e }) => e);
}

const wordsOf = (s) => s.split(/[^a-z0-9]+/).filter(Boolean);

/* The rest of an address you have been to that starts with what is typed, or
   null. Completes to the end of the host while the typing is still inside the
   host, and to the whole address once it reaches the path. `text` is what the
   field shows; `url` is what Enter opens. */
export function inlineCompletion(typed, entries) {
  const raw = String(typed || '');
  if (!raw || /\s/.test(raw)) return null;
  const q = raw.toLowerCase();
  const typedScheme = /^https?:\/\//.exec(q)?.[0] || '';
  const body = q.slice(typedScheme.length);
  if (!body) return null;
  for (const e of entries) {
    const { scheme, host, bare, rest } = split(e.url);
    for (const shown of body.startsWith('www.') ? [host] : [bare, host]) {
      const full = shown + rest;
      if (!full.startsWith(body) || full === body) continue;
      const text = body.length < shown.length ? shown : full;
      if (text === body) continue;
      const www = shown === bare ? host.slice(0, host.length - bare.length) : '';
      return { text: raw + text.slice(body.length), url: scheme + www + text };
    }
  }
  return null;
}

// Nothing that names your own machine or a path goes to a search engine.
export function worthSuggesting(typed) {
  const s = String(typed || '').trim();
  if (!s || s.length > 200) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return false;
  if (/^(localhost|127\.|0\.0\.0\.0|\[?::1|\d{1,3}(\.\d{1,3}){3}|:\d|\d{2,5}$)/i.test(s)) return false;
  if (!/\s/.test(s) && /[/:]/.test(s)) return false;
  return true;
}

export const displayUrl = (url) => String(url || '').replace(/^https?:\/\//i, '').replace(/\/$/, '');
