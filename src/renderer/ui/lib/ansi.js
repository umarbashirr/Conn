// Terminal output as spans. A span is { text, fg, bold, dim }, where fg is an
// index into the 16 basic colours (0-7 normal, 8-15 bright) or null. SGR sets
// those; every other escape sequence is dropped, so no raw `\x1b[` text reaches
// the screen. Backgrounds, underline and 256/true colour are dropped too: they
// have no theme-aware reading, and the text they wrapped stays.

const ESCAPE = new RegExp([
  '(?:\\x1b\\[|\\x9b)([0-?]*)[ -/]*([@-~])?',
  '\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\|$)',
  '\\x1b[ -/]*[0-~]?',
].join('|'), 'g');

const fresh = () => ({ fg: null, bold: false, dim: false });

function sgr(style, body) {
  const params = body === '' ? ['0'] : body.split(';');
  let next = { ...style };
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (p.includes(':')) continue;
    const n = p === '' ? 0 : Number(p);
    if (n === 0) next = fresh();
    else if (n === 1) next.bold = true;
    else if (n === 2) next.dim = true;
    else if (n === 22) { next.bold = false; next.dim = false; }
    else if (n >= 30 && n <= 37) next.fg = n - 30;
    else if (n >= 90 && n <= 97) next.fg = n - 90 + 8;
    else if (n === 39) next.fg = null;
    else if (n === 38 || n === 48) i += params[i + 1] === '5' ? 2 : params[i + 1] === '2' ? 4 : 0;
  }
  return next;
}

export function parseAnsi(text) {
  const spans = [];
  let style = fresh();
  let at = 0;
  const emit = (to) => {
    if (to > at) spans.push({ text: text.slice(at, to), ...style });
  };
  for (const m of text.matchAll(ESCAPE)) {
    emit(m.index);
    at = m.index + m[0].length;
    if (m[2] === 'm') style = sgr(style, m[1]);
  }
  emit(text.length);
  return spans;
}

export const plainText = (spans) => spans.map((s) => s.text).join('');

export const stripAnsi = (text) => plainText(parseAnsi(text));

export function clipSpans(spans, limit) {
  const out = [];
  let left = limit;
  let hidden = 0;
  for (const s of spans) {
    if (left <= 0) hidden += s.text.length;
    else if (s.text.length <= left) { out.push(s); left -= s.text.length; }
    else { out.push({ ...s, text: s.text.slice(0, left) }); hidden += s.text.length - left; left = 0; }
  }
  return { spans: out, hidden };
}
