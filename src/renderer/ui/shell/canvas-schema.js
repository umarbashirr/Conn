/* The design canvas's document: frames on a board, each a tree of nodes.

   Close to Figma's node model on purpose, so the SVG that goes to Figma is a
   translation rather than a guess: frames with auto layout, rects, ellipses,
   lines, text and vectors, each with fills, strokes, radii, shadows and clip.

   Each top-level frame is its own file in .conn/canvas/. The agent edits one
   screen without rewriting the others, a broken edit breaks one frame instead
   of the board, and a frame the person drags is a write to that file alone.

   Everything the agent writes is parsed here before it reaches the board, and
   a file that does not parse becomes a readable error on the board instead of
   a crash. */
import { z } from 'zod';
import { CANVAS_DIR } from '../../../shared/canvas';

// Bundlers drop zod's default locale as a side effect, leaving every issue as
// "Invalid input". The messages are what the person and the agent read.
z.config(z.locales.en());

const n = z.number();
const hex = z.string().regex(/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i, 'expected a hex colour like #1e293b or #1e293b80');

const Gradient = z.strictObject({
  type: z.literal('linear'),
  angle: n.optional(),
  stops: z.array(z.strictObject({ at: n.min(0).max(1), color: hex })).min(2),
});
const Paint = z.union([hex, Gradient]);
const Stroke = z.strictObject({ color: hex, width: n.positive() });
const Shadow = z.strictObject({ x: n, y: n, blur: n.min(0), spread: n.optional(), color: hex });
const Radius = z.union([n.min(0), z.tuple([n, n, n, n])]);
const Size = z.union([n.min(0), z.enum(['fill', 'hug'])]);
const Layout = z.strictObject({
  direction: z.enum(['row', 'column']),
  gap: n.optional(),
  padding: z.union([n, z.tuple([n, n]), z.tuple([n, n, n, n])]).optional(),
  align: z.enum(['start', 'center', 'end', 'stretch']).optional(),
  justify: z.enum(['start', 'center', 'end', 'space-between']).optional(),
});

const common = {
  name: z.string().optional(),
  x: n.optional(),
  y: n.optional(),
  width: Size.optional(),
  height: Size.optional(),
  opacity: n.min(0).max(1).optional(),
};
const box = { fill: Paint.optional(), stroke: Stroke.optional(), radius: Radius.optional(), shadows: z.array(Shadow).optional() };

const Frame = z.strictObject({
  type: z.literal('frame'),
  ...common,
  ...box,
  layout: Layout.optional(),
  clip: z.boolean().optional(),
  get children() { return z.array(Node).optional(); },
});
const Group = z.strictObject({
  type: z.literal('group'),
  ...common,
  get children() { return z.array(Node).optional(); },
});
const Rect = z.strictObject({ type: z.literal('rect'), ...common, ...box });
const Ellipse = z.strictObject({ type: z.literal('ellipse'), ...common, ...box });
const Line = z.strictObject({ type: z.literal('line'), ...common, stroke: Stroke });
const Text = z.strictObject({
  type: z.literal('text'),
  ...common,
  text: z.string(),
  fontFamily: z.string().optional(),
  fontSize: n.positive().optional(),
  fontWeight: n.min(100).max(900).optional(),
  italic: z.boolean().optional(),
  lineHeight: n.positive().optional(),
  letterSpacing: n.optional(),
  color: hex.optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
});
const Vector = z.strictObject({
  type: z.literal('vector'),
  ...common,
  viewBox: z.string().regex(/^-?[\d.]+(\s+-?[\d.]+){3}$/, 'expected four numbers like "0 0 24 24"'),
  paths: z.array(z.strictObject({
    d: z.string(),
    fill: z.union([hex, z.literal('none')]).optional(),
    stroke: hex.optional(),
    strokeWidth: n.positive().optional(),
  })).min(1),
});

const Node = z.discriminatedUnion('type', [Frame, Group, Rect, Ellipse, Line, Text, Vector]);

const Board = Frame.extend({
  name: z.string(),
  x: n,
  y: n,
  width: n.positive(),
  height: n.positive(),
});

/** @typedef {z.infer<typeof Node>} Node */
/** @typedef {z.infer<typeof Board>} BoardFrame */
/** @typedef {z.infer<typeof Paint>} Paint */

/** @param {never} value */
export function unreachable(value) {
  throw new Error(`unhandled canvas case ${JSON.stringify(value)}`);
}

const where = (path) => path.reduce((s, k) => (typeof k === 'number' ? `${s}[${k}]` : s ? `${s}.${k}` : String(k)), '');

// A file off disk, turned into a frame or into the sentence that says why not.
// A few issues at most: the first one is usually the cause of the rest.
export function parseFrame(text, file) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { error: `${file} is not valid JSON. ${e.message}` };
  }
  const res = Board.safeParse(raw);
  if (res.success) return { frame: res.data };
  const issues = res.error.issues.slice(0, 3).map((i) => `${where(i.path) || 'frame'}: ${i.message}`);
  return { error: `${file}: ${issues.join('; ')}` };
}

const SLOT_GAP = 160;

// Right of everything already on the board, level with the top row, so a new
// frame can never land on an old one.
export function nextSlot(frames) {
  if (!frames.length) return { x: 0, y: 0 };
  return {
    x: Math.max(...frames.map((f) => f.x + f.width)) + SLOT_GAP,
    y: Math.min(...frames.map((f) => f.y)),
  };
}

// What $canvas means, told to the agent on the message that says it. Short
// enough to ride along every time, complete enough that the schema is never
// guessed, and plain that no canvas of the agent's own is meant.
export function designBrief(slot) {
  return [
    '[conn canvas] $canvas',
    '  "Canvas" here means the Canvas board in Conn, the app this chat runs in, shown beside this chat. It is not Cursor Canvas, a Claude artifact, Figma, or any design tool of your own. You draw on it by writing files, not with a tool.',
    `  Each frame is one JSON file in ${CANVAS_DIR}/ in this project, drawn live as you edit it.`,
    `  A new frame is a new file, ${CANVAS_DIR}/<kebab-name>.json, placed at x ${slot.x}, y ${slot.y}, which is clear of every frame on the board. Change a frame by editing its file. Never move or touch frames you were not asked about.`,
    '  Frame file: {"type":"frame","name":"Pricing","x":0,"y":0,"width":1280,"height":900,"fill":"#ffffff","layout":{"direction":"column","gap":24,"padding":[48,64]},"children":[...]}',
    '  Every node takes name, width, height and opacity. x and y only apply inside a parent with no layout. Node types:',
    '    frame {fill, stroke, radius, shadows, clip, layout, children}. group {children}, positioned by x and y.',
    '    rect and ellipse {fill, stroke, radius, shadows}. line {stroke}, horizontal with a width, vertical with a height.',
    '    text {text, fontFamily, fontSize, fontWeight, italic, lineHeight, letterSpacing, color, align: left|center|right}. Text wraps when it has a width.',
    '    vector {viewBox: "0 0 24 24", paths: [{d, fill, stroke, strokeWidth}]}, for icons and imagery.',
    '  layout: {direction: row|column, gap, padding: n or [v, h] or [t, r, b, l], align: start|center|end|stretch, justify: start|center|end|space-between}.',
    '  width and height: pixels, "fill" to take the free space, or "hug" to fit the content, which is the default.',
    '  fill: "#rrggbb" or "#rrggbbaa", or {"type":"linear","angle":90,"stops":[{"at":0,"color":"#f59e0b"},{"at":1,"color":"#f43f5e"}]}. stroke: {color, width}. shadows: [{x, y, blur, spread, color}]. radius: n or [tl, tr, br, bl].',
    '  Unknown keys are rejected and the canvas shows the error. There are no raster images, so draw imagery as vectors. Use realistic content.',
  ].join('\n');
}

export function selectionBrief(frames) {
  return [
    '[conn canvas selection]',
    `  Change only these frames. Leave every other file in ${CANVAS_DIR}/ alone.`,
    ...frames.map((f) => `  ${CANVAS_DIR}/${f.file}  (${f.name})`),
  ].join('\n');
}
