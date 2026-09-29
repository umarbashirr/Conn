/* Board arithmetic. A viewport is { x, y, zoom }: the screen point where the
   board's origin sits and how many screen pixels one board pixel takes. */

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 8;
export const MIN_SIZE = 40;
export const HANDLE = 8;
const FIT_PAD = 48;
export const LABEL = 20;

export const clampZoom = (z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

export const toBoard = (v, sx, sy) => ({ x: (sx - v.x) / v.zoom, y: (sy - v.y) / v.zoom });

// Zoom about a screen point, which stays over the same spot on the board.
export function zoomAt(v, sx, sy, zoom) {
  const z = clampZoom(zoom);
  return { zoom: z, x: sx - ((sx - v.x) * z) / v.zoom, y: sy - ((sy - v.y) * z) / v.zoom };
}

export function boundsOf(frames) {
  const x = Math.min(...frames.map((f) => f.x));
  const y = Math.min(...frames.map((f) => f.y));
  return { x, y, width: Math.max(...frames.map((f) => f.x + f.width)) - x, height: Math.max(...frames.map((f) => f.y + f.height)) - y };
}

export function fit(frames, w, h, maxZoom = 1) {
  if (!frames.length || w <= 0 || h <= 0) return { x: w / 2, y: h / 2, zoom: 1 };
  const b = boundsOf(frames);
  const zoom = clampZoom(Math.min((w - 2 * FIT_PAD) / b.width, (h - 2 * FIT_PAD - LABEL) / b.height, maxZoom));
  return { zoom, x: w / 2 - (b.x + b.width / 2) * zoom, y: h / 2 - (b.y + b.height / 2) * zoom + LABEL / 2 };
}

const contains = (f, p) => p.x >= f.x && p.x <= f.x + f.width && p.y >= f.y && p.y <= f.y + f.height;

// The label above a frame grabs it too, as in Figma.
export function frameAt(frames, p, zoom) {
  const label = LABEL / zoom;
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i];
    if (contains(f, p) || (p.x >= f.x && p.x <= f.x + f.width && p.y >= f.y - label && p.y < f.y)) return f;
  }
  return null;
}

// Each handle as the fraction of the frame it sits at.
export const HANDLES = {
  nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5],
  se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5],
};

export function handleAt(f, v, sx, sy) {
  for (const [h, [fx, fy]] of Object.entries(HANDLES)) {
    const hx = v.x + (f.x + f.width * fx) * v.zoom;
    const hy = v.y + (f.y + f.height * fy) * v.zoom;
    if (Math.abs(sx - hx) <= HANDLE && Math.abs(sy - hy) <= HANDLE) return h;
  }
  return null;
}

export function resize(f, handle, dx, dy) {
  const [fx, fy] = HANDLES[handle];
  let { x, y, width, height } = f;
  if (fx === 0) {
    const w = Math.max(MIN_SIZE, width - dx);
    x += width - w;
    width = w;
  } else if (fx === 1) width = Math.max(MIN_SIZE, width + dx);
  if (fy === 0) {
    const h = Math.max(MIN_SIZE, height - dy);
    y += height - h;
    height = h;
  } else if (fy === 1) height = Math.max(MIN_SIZE, height + dy);
  return { x, y, width, height };
}

export function rectFrom(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

export const overlaps = (f, r) => f.x < r.x + r.width && f.x + f.width > r.x && f.y < r.y + r.height && f.y + f.height > r.y;
