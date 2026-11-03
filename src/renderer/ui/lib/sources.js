// What a turn read from the web. WebSearch prints its results as a JSON list on
// a "Links:" line of its output; WebFetch names its page in its input and
// prints a summary of it. A source is a unique URL: { url, title?, host }.
import { toolLabel, toolText } from './tools.js';

const LINKS_LINE = /^Links: (\[.*\])[ \t]*$/gm;

const hostOf = (url) => new URL(url).hostname.replace(/^www\./, '');

function source(url, title) {
  if (typeof url !== 'string' || !URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) return null;
  return { url, ...(typeof title === 'string' && title.trim() && { title: title.trim() }), host: hostOf(url) };
}

export function linksOf(output) {
  const out = [];
  for (const [, json] of toolText(output).matchAll(LINKS_LINE)) {
    let list;
    try { list = JSON.parse(json); } catch { continue; }
    for (const l of Array.isArray(list) ? list : []) {
      const s = source(l?.url, l?.title);
      if (s) out.push(s);
    }
  }
  return out;
}

export const withoutLinks = (text) => text.replace(LINKS_LINE, '').replace(/\n{3,}/g, '\n\n').trim();

export const sourceLabel = (s) => s.title || s.host;

function read(item) {
  if (item.kind !== 'tool' || item.state !== 'output-available') return [];
  const label = toolLabel(item.name);
  if (label === 'WebSearch') return linksOf(item.output);
  if (label === 'WebFetch') return [source(item.input?.url)].filter(Boolean);
  return [];
}

export function sourcesOf(items) {
  const seen = new Map();
  const visit = (list) => {
    for (const it of list) {
      for (const s of read(it)) {
        const have = seen.get(s.url);
        if (!have) seen.set(s.url, s);
        else if (!have.title && s.title) have.title = s.title;
      }
      if (it.children) visit(it.children);
    }
  };
  visit(items);
  return [...seen.values()];
}

// Keyed by the last finished reply of each turn that used the web.
export function turnSources(items) {
  const out = new Map();
  let turn = null;
  const close = () => {
    const reply = turn?.reply;
    const sources = turn ? sourcesOf(turn.items) : [];
    if (reply && sources.length) out.set(reply.id, sources);
  };
  for (const it of items) {
    if (it.kind === 'user' && !it.parent) {
      close();
      turn = { items: [], reply: null };
    } else if (turn) {
      turn.items.push(it);
      if (it.kind === 'assistant' && it.text && !it.parent) turn.reply = it.streaming ? null : it;
    }
  }
  close();
  return out;
}
