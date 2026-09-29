/* How a canvas node looks, as CSS. The board paints with it and the code
   exports are written from it, so what you export is what you saw. */
import { unreachable } from './canvas-schema.js';

export const px = (v) => `${v}px`;

const ALIGN = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch' };
const JUSTIFY = { start: 'flex-start', center: 'center', end: 'flex-end', 'space-between': 'space-between' };
const VECTOR_SIZE = 24;

export const fontStack = (family) => `${family ? `'${family}', ` : ''}Inter, system-ui, sans-serif`;

export function cssPaint(paint) {
  if (typeof paint === 'string') return paint;
  const stops = paint.stops.map((s) => `${s.color} ${+(s.at * 100).toFixed(2)}%`);
  return `linear-gradient(${paint.angle ?? 180}deg, ${stops.join(', ')})`;
}

export const pathFill = (p) => p.fill ?? (p.stroke ? 'none' : '#000000');

export const isVertical = (line) => line.width === undefined && line.height !== undefined;

// A line's thickness is its stroke; a vector with no size is icon sized.
export function sizeOf(node, axis) {
  if (node.type === 'line' && (axis === 'height') !== isVertical(node)) return node.stroke.width;
  if (node.type === 'vector' && typeof node[axis] !== 'number') return node[axis] === 'fill' ? 'fill' : VECTOR_SIZE;
  return node[axis];
}

const inFlow = (parent) => parent?.type === 'frame' && !!parent.layout;

function place(node, parent) {
  if (!parent) return { position: 'relative', width: px(node.width), height: px(node.height) };
  const s = {};
  const flow = inFlow(parent);
  if (!flow) Object.assign(s, { position: 'absolute', left: px(node.x ?? 0), top: px(node.y ?? 0) });
  const main = flow && (parent.layout.direction === 'row' ? 'width' : 'height');
  for (const axis of ['width', 'height']) {
    const v = sizeOf(node, axis);
    if (typeof v === 'number') {
      s[axis] = px(v);
      if (flow) s.flexShrink = 0;
    } else if (v === 'fill') {
      if (axis === main) Object.assign(s, { flex: '1 1 0', [axis === 'width' ? 'minWidth' : 'minHeight']: '0px' });
      else if (flow) s.alignSelf = 'stretch';
      else s[axis] = '100%';
    }
  }
  return s;
}

function box(node) {
  const s = {};
  if (node.fill) s.background = cssPaint(node.fill);
  if (node.stroke) Object.assign(s, { outline: `${px(node.stroke.width)} solid ${node.stroke.color}`, outlineOffset: px(-node.stroke.width) });
  if (node.radius !== undefined) s.borderRadius = Array.isArray(node.radius) ? node.radius.map(px).join(' ') : px(node.radius);
  if (node.shadows?.length) s.boxShadow = node.shadows.map((d) => `${px(d.x)} ${px(d.y)} ${px(d.blur)} ${px(d.spread ?? 0)} ${d.color}`).join(', ');
  return s;
}

function container(node) {
  const l = node.type === 'frame' ? node.layout : undefined;
  if (!l) return {};
  const s = { display: 'flex', flexDirection: l.direction };
  if (l.gap) s.gap = px(l.gap);
  if (l.padding !== undefined) s.padding = [].concat(l.padding).map(px).join(' ');
  if (l.align) s.alignItems = ALIGN[l.align];
  if (l.justify) s.justifyContent = JUSTIFY[l.justify];
  return s;
}

function text(node) {
  const s = {
    color: node.color ?? '#000000',
    fontFamily: fontStack(node.fontFamily),
    fontSize: px(node.fontSize ?? 16),
    fontWeight: node.fontWeight ?? 400,
    whiteSpace: typeof node.width === 'number' || node.width === 'fill' ? 'pre-wrap' : 'pre',
  };
  if (node.italic) s.fontStyle = 'italic';
  if (node.lineHeight) s.lineHeight = px(node.lineHeight);
  if (node.letterSpacing) s.letterSpacing = px(node.letterSpacing);
  if (node.align) s.textAlign = node.align;
  return s;
}

function look(node, top) {
  switch (node.type) {
    case 'frame': return { ...box(node), ...container(node), ...((node.clip ?? top) ? { overflow: 'hidden' } : {}) };
    case 'group': return {};
    case 'rect': return box(node);
    case 'ellipse': return { ...box(node), borderRadius: '50%' };
    case 'line': return { background: node.stroke.color };
    case 'text': return text(node);
    case 'vector': return { display: 'block' };
    default: return unreachable(node);
  }
}

// `parent` is the node this one sits in, or null for a frame on the board.
export function styleOf(node, parent) {
  const s = { boxSizing: 'border-box', ...place(node, parent), ...look(node, !parent) };
  if ((node.type === 'frame' || node.type === 'group') && !s.position) s.position = 'relative';
  if (node.opacity !== undefined && node.opacity < 1) s.opacity = node.opacity;
  return s;
}
