/* Frames leaving the canvas: React with Tailwind, plain HTML, and SVG for Figma.

   The code exports are written from the scene graph through the same styleOf
   the board paints with. The SVG takes its styling from the scene graph too,
   so gradients keep their stops and shadows stay shadows, and takes only
   positions and text line breaks from the board, which has already done the
   layout and wrapping. */
import { unreachable } from './canvas-schema.js';
import { fontStack, isVertical, pathFill, styleOf } from './canvas-style.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (v) => +(+v).toFixed(2);

export function componentName(name) {
  const pascal = String(name).split(/[^a-zA-Z0-9]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('');
  if (!pascal) return 'Screen';
  return /^\d/.test(pascal) ? `Screen${pascal}` : pascal;
}

const unique = (names) => {
  const seen = new Map();
  return names.map((n) => {
    const k = (seen.get(n) || 0) + 1;
    seen.set(n, k);
    return k === 1 ? n : `${n}${k}`;
  });
};

// ------------------------------------------------------------------ Tailwind

const WORDS = {
  position: { absolute: 'absolute', relative: 'relative' },
  display: { flex: 'flex', block: 'block' },
  flexDirection: { row: 'flex-row', column: 'flex-col' },
  alignItems: { 'flex-start': 'items-start', center: 'items-center', 'flex-end': 'items-end', stretch: 'items-stretch' },
  justifyContent: { 'flex-start': 'justify-start', center: 'justify-center', 'flex-end': 'justify-end', 'space-between': 'justify-between' },
  alignSelf: { stretch: 'self-stretch' },
  flex: { '1 1 0': 'flex-1' },
  flexShrink: { 0: 'shrink-0' },
  overflow: { hidden: 'overflow-hidden' },
  fontStyle: { italic: 'italic' },
  textAlign: { left: 'text-left', center: 'text-center', right: 'text-right' },
  whiteSpace: { pre: 'whitespace-pre', 'pre-wrap': 'whitespace-pre-wrap' },
  boxSizing: { 'border-box': '' },
};
const PREFIX = {
  width: 'w', height: 'h', minWidth: 'min-w', minHeight: 'min-h', left: 'left', top: 'top',
  gap: 'gap', padding: 'p', borderRadius: 'rounded', boxShadow: 'shadow', opacity: 'opacity',
  background: 'bg', color: 'text', fontSize: 'text', fontWeight: 'font', lineHeight: 'leading', letterSpacing: 'tracking',
};
const arbitrary = (v) => String(v).replace(/ /g, '_');
const kebab = (k) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

export function classesOf(style) {
  return Object.entries(style).map(([k, v]) => {
    const word = WORDS[k]?.[v];
    if (word !== undefined) return word;
    if (PREFIX[k]) return `${PREFIX[k]}-[${arbitrary(v)}]`;
    return `[${kebab(k)}:${arbitrary(v)}]`;
  }).filter(Boolean).join(' ');
}

// ------------------------------------------------------------------ markup

const cssText = (style) => Object.entries(style).map(([k, v]) => `${kebab(k)}:${v}`).join(';');

const JSX = {
  attrs: (style) => `className="${classesOf(style)}"`,
  text: (t) => (/^[^{}<>&\n]*$/.test(t) && t === t.trim() ? t : `{${JSON.stringify(t)}}`),
  path: (p) => [`d="${esc(p.d)}"`, `fill="${pathFill(p)}"`, p.stroke && `stroke="${p.stroke}"`, p.strokeWidth && `strokeWidth={${p.strokeWidth}}`, p.stroke && 'strokeLinecap="round" strokeLinejoin="round"'],
};
const HTML = {
  attrs: (style) => `style="${esc(cssText(style))}"`,
  text: (t) => esc(t),
  path: (p) => [`d="${esc(p.d)}"`, `fill="${pathFill(p)}"`, p.stroke && `stroke="${p.stroke}"`, p.strokeWidth && `stroke-width="${p.strokeWidth}"`, p.stroke && 'stroke-linecap="round" stroke-linejoin="round"'],
};

function markup(node, parent, pad, lang) {
  const open = (tag, extra = '') => `${pad}<${tag} ${lang.attrs(styleOf(node, parent))}${extra}`;
  const kids = (list) => list.map((c) => markup(c, node, `${pad}  `, lang)).join('\n');
  switch (node.type) {
    case 'frame':
    case 'group':
      return node.children?.length ? `${open('div')}>\n${kids(node.children)}\n${pad}</div>` : `${open('div')}></div>`;
    case 'rect':
    case 'ellipse':
    case 'line':
      return `${open('div')}></div>`;
    case 'text':
      return `${open('div')}>${lang.text(node.text)}</div>`;
    case 'vector': {
      const paths = node.paths.map((p) => `${pad}  <path ${lang.path(p).filter(Boolean).join(' ')} />`);
      return `${open('svg', ` viewBox="${node.viewBox}" xmlns="http://www.w3.org/2000/svg"`)}>\n${paths.join('\n')}\n${pad}</svg>`;
    }
    default:
      return unreachable(node);
  }
}

export function toReact(frames) {
  const names = unique(frames.map((f) => componentName(f.name)));
  return frames.map((f, i) => `export function ${names[i]}() {\n  return (\n${markup(f, null, '    ', JSX)}\n  );\n}\n`).join('\n');
}

const bounds = (frames) => {
  const x = Math.min(...frames.map((f) => f.x));
  const y = Math.min(...frames.map((f) => f.y));
  return { x, y, width: Math.max(...frames.map((f) => f.x + f.width)) - x, height: Math.max(...frames.map((f) => f.y + f.height)) - y };
};

export function toHtml(frames, title) {
  const b = bounds(frames);
  const placed = frames.map((f) => `    <div style="position:absolute;left:${f.x - b.x}px;top:${f.y - b.y}px">\n${markup(f, null, '      ', HTML)}\n    </div>`);
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8">',
    `  <title>${esc(title)}</title>`,
    '  <style>*{margin:0;box-sizing:border-box}body{padding:40px}</style>',
    '</head>',
    '<body>',
    `  <div style="position:relative;width:${b.width}px;height:${b.height}px">`,
    ...placed,
    '  </div>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

// ------------------------------------------------------------------ SVG

function hexParts(c) {
  let h = c.slice(1);
  if (h.length === 3) h = [...h].map((d) => d + d).join('');
  return { color: `#${h.slice(0, 6)}`, alpha: h.length === 8 ? num(parseInt(h.slice(6), 16) / 255) : 1 };
}

const colour = (attr, c) => {
  const { color, alpha } = hexParts(c);
  return alpha < 1 ? `${attr}="${color}" ${attr}-opacity="${alpha}"` : `${attr}="${color}"`;
};

function roundedPath(x, y, w, h, [tl, tr, br, bl]) {
  const lim = (r) => Math.max(0, Math.min(r, w / 2, h / 2));
  [tl, tr, br, bl] = [tl, tr, br, bl].map(lim);
  return `M${num(x + tl)} ${num(y)}H${num(x + w - tr)}A${num(tr)} ${num(tr)} 0 0 1 ${num(x + w)} ${num(y + tr)}V${num(y + h - br)}A${num(br)} ${num(br)} 0 0 1 ${num(x + w - br)} ${num(y + h)}H${num(x + bl)}A${num(bl)} ${num(bl)} 0 0 1 ${num(x)} ${num(y + h - bl)}V${num(y + tl)}A${num(tl)} ${num(tl)} 0 0 1 ${num(x + tl)} ${num(y)}Z`;
}

// One SVG document's worth of defs and layer names.
function svgWriter() {
  const defs = [];
  const used = new Map();
  let serial = 0;
  const id = (prefix) => `${prefix}${++serial}`;
  return {
    defs,
    layer(name) {
      const base = String(name).trim().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '_').slice(0, 48) || 'Layer';
      const k = (used.get(base) || 0) + 1;
      used.set(base, k);
      return k === 1 ? base : `${base}_${k}`;
    },
    paint(p) {
      if (typeof p === 'string') return colour('fill', p);
      const a = ((p.angle ?? 180) * Math.PI) / 180;
      const [sin, cos] = [Math.sin(a), Math.cos(a)];
      const g = id('g');
      const stops = p.stops.map((s) => {
        const { color, alpha } = hexParts(s.color);
        return `<stop offset="${num(s.at)}" stop-color="${color}"${alpha < 1 ? ` stop-opacity="${alpha}"` : ''}/>`;
      });
      defs.push(`<linearGradient id="${g}" x1="${num(0.5 - sin / 2)}" y1="${num(0.5 + cos / 2)}" x2="${num(0.5 + sin / 2)}" y2="${num(0.5 - cos / 2)}">${stops.join('')}</linearGradient>`);
      return `fill="url(#${g})"`;
    },
    // The chain Figma writes for its own drop shadows: grow, blur, offset, tint.
    shadow(list, r) {
      const f = id('s');
      const m = Math.max(...list.map((s) => Math.max(Math.abs(s.x), Math.abs(s.y)) + s.blur * 1.5 + Math.abs(s.spread ?? 0)));
      const steps = list.map((s, i) => {
        const spread = s.spread ?? 0;
        const grow = spread ? `<feMorphology in="SourceAlpha" operator="${spread > 0 ? 'dilate' : 'erode'}" radius="${Math.abs(spread)}" result="m${i}"/>` : '';
        const { color, alpha } = hexParts(s.color);
        return `${grow}<feGaussianBlur in="${spread ? `m${i}` : 'SourceAlpha'}" stdDeviation="${num(s.blur / 2)}"/><feOffset dx="${s.x}" dy="${s.y}" result="o${i}"/><feFlood flood-color="${color}" flood-opacity="${alpha}"/><feComposite in2="o${i}" operator="in" result="d${i}"/>`;
      });
      const merge = [...list.map((_, i) => `<feMergeNode in="d${i}"/>`), '<feMergeNode in="SourceGraphic"/>'].join('');
      defs.push(`<filter id="${f}" filterUnits="userSpaceOnUse" x="${num(r.x - m)}" y="${num(r.y - m)}" width="${num(r.w + 2 * m)}" height="${num(r.h + 2 * m)}" color-interpolation-filters="sRGB">${steps.join('')}<feMerge>${merge}</feMerge></filter>`);
      return `filter="url(#${f})"`;
    },
    clip(shape) {
      const c = id('c');
      defs.push(`<clipPath id="${c}">${shape}</clipPath>`);
      return `clip-path="url(#${c})"`;
    },
  };
}

const radii = (node) => (node.radius === undefined ? [0, 0, 0, 0] : [].concat(node.radius).length === 4 ? node.radius : [0, 1, 2, 3].map(() => node.radius));

function shapeOf(node, r, inset = 0) {
  const [x, y, w, h] = [r.x + inset, r.y + inset, r.w - 2 * inset, r.h - 2 * inset];
  if (node.type === 'ellipse') return `<ellipse cx="${num(x + w / 2)}" cy="${num(y + h / 2)}" rx="${num(w / 2)}" ry="${num(h / 2)}"`;
  const rs = radii(node).map((v) => Math.max(0, v - inset));
  if (rs.every((v) => v === rs[0])) return `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}"${rs[0] ? ` rx="${num(rs[0])}"` : ''}`;
  return `<path d="${roundedPath(x, y, w, h, rs)}"`;
}

function boxSvg(node, r, id, out) {
  if (!node.fill && !node.stroke && !node.shadows?.length) return '';
  const inset = node.stroke ? node.stroke.width / 2 : 0;
  const attrs = [
    `id="${id}"`,
    node.fill ? out.paint(node.fill) : 'fill="none"',
    node.stroke && `${colour('stroke', node.stroke.color)} stroke-width="${node.stroke.width}"`,
    node.shadows?.length && out.shadow(node.shadows, r),
  ];
  return `${shapeOf(node, r, inset)} ${attrs.filter(Boolean).join(' ')}/>`;
}

// Per line of wrapped text, as the board broke it. Baselines come from the
// font's own ascent and descent, scaled to the box the browser gave the line.
function textLines(el, k, origin) {
  const t = el.firstChild;
  if (!t || t.nodeType !== Node.TEXT_NODE) return [];
  const cs = getComputedStyle(el);
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const m = ctx.measureText('Hg');
  const ascent = m.fontBoundingBoxAscent / (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent);
  const range = document.createRange();
  const lines = [];
  for (const w of t.data.matchAll(/\S+/g)) {
    range.setStart(t, w.index);
    range.setEnd(t, w.index + w[0].length);
    const rect = range.getBoundingClientRect();
    const top = (rect.top - origin.top) / k;
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.top - top) < 1) last.end = w.index + w[0].length;
    else lines.push({ top, x: (rect.left - origin.left) / k, h: rect.height / k, start: w.index, end: w.index + w[0].length });
  }
  return lines.map((l) => ({ x: l.x, y: l.top + l.h * ascent, text: t.data.slice(l.start, l.end) }));
}

function vectorSvg(node, r, id) {
  const [vx, vy, vw, vh] = node.viewBox.trim().split(/\s+/).map(Number);
  const s = Math.min(r.w / vw, r.h / vh);
  const tx = r.x + (r.w - vw * s) / 2 - vx * s;
  const ty = r.y + (r.h - vh * s) / 2 - vy * s;
  const paths = node.paths.map((p) => {
    const fill = pathFill(p);
    return `<path d="${esc(p.d)}" ${fill === 'none' ? 'fill="none"' : colour('fill', fill)}${p.stroke ? ` ${colour('stroke', p.stroke)} stroke-width="${p.strokeWidth ?? 1}" stroke-linecap="round" stroke-linejoin="round"` : ''}/>`;
  });
  return `<g id="${id}" transform="translate(${num(tx)} ${num(ty)}) scale(${num(s)})">${paths.join('')}</g>`;
}

function nodeSvg(node, el, k, origin, out, top = false) {
  const b = el.getBoundingClientRect();
  const r = { x: (b.left - origin.left) / k, y: (b.top - origin.top) / k, w: b.width / k, h: b.height / k };
  const id = out.layer(node.name ?? (node.type === 'text' ? node.text.slice(0, 32) : node.type));
  const fade = node.opacity !== undefined && node.opacity < 1 ? ` opacity="${node.opacity}"` : '';
  const children = () => (node.children || []).map((c, i) => nodeSvg(c, el.children[i], k, origin, out)).join('');
  switch (node.type) {
    case 'frame': {
      const inner = children();
      const clipped = (node.clip ?? top) && inner ? `<g ${out.clip(`${shapeOf(node, r)}/>`)}>${inner}</g>` : inner;
      return `<g id="${id}"${fade}>${boxSvg(node, r, out.layer(`${id} background`), out)}${clipped}</g>`;
    }
    case 'group':
      return `<g id="${id}"${fade}>${children()}</g>`;
    case 'rect':
    case 'ellipse': {
      const shape = boxSvg(node, r, id, out);
      return fade && shape ? `<g${fade}>${shape}</g>` : shape;
    }
    case 'line': {
      const w = node.stroke.width;
      const [lw, lh] = isVertical(node) ? [w, r.h] : [r.w, w];
      return `<rect id="${id}" x="${num(r.x)}" y="${num(r.y)}" width="${num(lw)}" height="${num(lh)}" ${colour('fill', node.stroke.color)}${fade}/>`;
    }
    case 'text': {
      const spans = textLines(el, k, origin).map((l) => `<tspan x="${num(l.x)}" y="${num(l.y)}">${esc(l.text)}</tspan>`);
      const attrs = [
        `font-family="${esc(fontStack(node.fontFamily))}"`,
        `font-size="${node.fontSize ?? 16}"`,
        `font-weight="${node.fontWeight ?? 400}"`,
        node.italic && 'font-style="italic"',
        node.letterSpacing && `letter-spacing="${node.letterSpacing}"`,
        colour('fill', node.color ?? '#000000'),
      ];
      return `<text id="${id}" xml:space="preserve" ${attrs.filter(Boolean).join(' ')}${fade}>${spans.join('')}</text>`;
    }
    case 'vector':
      return fade ? `<g${fade}>${vectorSvg(node, r, id)}</g>` : vectorSvg(node, r, id);
    default:
      return unreachable(node);
  }
}

// `placed` pairs each frame with the element the board drew it into.
export function toSvg(placed) {
  const b = bounds(placed.map((p) => p.frame));
  const out = svgWriter();
  const layers = placed.map(({ frame, el }) => {
    const origin = el.getBoundingClientRect();
    const k = origin.width / frame.width;
    return `<g transform="translate(${num(frame.x - b.x)} ${num(frame.y - b.y)})">${nodeSvg(frame, el, k, origin, out, true)}</g>`;
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(b.width)}" height="${num(b.height)}" viewBox="0 0 ${num(b.width)} ${num(b.height)}" fill="none">`,
    out.defs.length ? `<defs>${out.defs.join('')}</defs>` : '',
    ...layers,
    '</svg>',
    '',
  ].join('\n');
}