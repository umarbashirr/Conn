'use strict';
// What the composer prepends for an attachment or a mention: a bracketed head
// line, its indented detail lines, and a blank line between blocks. A mention's
// block is for the agent; the person already sees the $ badge they typed.
const HEAD_KIND = {
  'preview element': 'element',
  'attached image': 'element',
  'attached file': 'element',
  'conn canvas selection': 'frames',
  'conn browser': 'context',
  'conn canvas': 'context',
};
const ATTACHED = new RegExp(`^\\[(${Object.keys(HEAD_KIND).join('|')})\\]([^\\n]*)((?:\\n {2}[^\\n]*)*)\\n\\n`);

const basename = (p) => {
  const parts = p.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || p;
};

// The element picker writes the full description across several indented
// lines. The one worth showing is the element itself.
function attachedLabel(head, detail, tail) {
  if (head === 'preview element') {
    const line = /\n {2}element: (.+)/.exec(tail);
    return line ? line[1].replace(/"/g, '') : 'element';
  }
  if (head === 'conn canvas selection') {
    const names = [...tail.matchAll(/ {2}\((.+)\)$/gm)].map((m) => m[1]);
    return names.length === 1 ? names[0] : `${names.length} frames`;
  }
  return detail.trim() || head;
}

function imageHead(name) {
  return `[attached image] ${name}`;
}

function plainText(input) {
  let rest = String(input ?? '');
  const heads = [];
  for (let m; (m = ATTACHED.exec(rest));) {
    rest = rest.slice(m[0].length);
    if (HEAD_KIND[m[1]] === 'context') continue;
    const note = /\n {2}note: ([^\n]+)/.exec(m[3])?.[1];
    heads.push(`[${attachedLabel(m[1], m[2], m[3])}]${note ? ` ${note}` : ''}`);
  }
  return [...heads, rest].filter(Boolean).join('\n');
}

module.exports = { ATTACHED, HEAD_KIND, attachedLabel, basename, imageHead, plainText };
