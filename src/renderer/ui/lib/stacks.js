// A stack trace read out of a block of text. A frame is app code when it is a
// file the reader could open, and framework when it sits in node_modules, a
// node: module, a runner's internals or Python's own libraries. No JSX, so
// plain node reads the same parser the rows do.

// eslint-disable-next-line no-control-regex
export const stripAnsi = (text) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

const LOCATION = /^(.*?):(\d+):(\d+)$/;
const V8_PAREN = /^\s+at (?:(?:async|new) )?(.+?) \((.*?:\d+:\d+|<anonymous>|native|index \d+|node:[^)]*)\)(?:\s*\{)?\s*$/;
const V8_BARE = /^\s+at (?:async )?(.*?:\d+:\d+)\s*$/;
const VITEST = /^\s*❯ (\S+?):(\d+):(\d+)\s*$/;
const PY_FRAME = /^(\s*)File "(.+)", line (\d+)(?:, in (.+))?\s*$/;
const PY_MARKS = /^[\s^~]+$/;

const toPath = (file) => {
  if (!file.startsWith('file://')) return file;
  try { return decodeURIComponent(file.slice('file://'.length)); } catch { return file; }
};

const frameworkFile = (file) => (
  !file
  || file.startsWith('node:')
  || file.startsWith('<')
  || file === 'native'
  || /(^|[\\/])node_modules[\\/]/.test(file)
  || file.includes('internal/')
  || /site-packages|dist-packages/.test(file)
  || /[\\/]lib[\\/]python\d[\d.]*[\\/]/.test(file)
);

function v8Frame(line) {
  const paren = V8_PAREN.exec(line);
  const where = paren ? paren[2] : V8_BARE.exec(line)?.[1];
  if (where === undefined) return null;
  const at = LOCATION.exec(where);
  const file = toPath(at ? at[1] : where);
  return {
    fn: paren ? paren[1] : '',
    file,
    line: at ? Number(at[2]) : null,
    col: at ? Number(at[3]) : null,
    framework: frameworkFile(file) || !at,
    raw: line.trim(),
  };
}

function vitestFrame(line) {
  const m = VITEST.exec(line);
  if (!m) return null;
  return { fn: '', file: m[1], line: Number(m[2]), col: Number(m[3]), framework: frameworkFile(m[1]), raw: line.trim() };
}

// Splits text into runs of plain text and runs of frames, in order. A Python
// frame owns the source line and the ^^^ marks under it, which are not text a
// reader wants to see between two frames.
export function segmentStack(text) {
  const lines = stripAnsi(text).split('\n');
  const out = [];
  const text_ = [];
  let frames = null;

  const flushText = () => {
    if (text_.length) out.push({ type: 'text', text: text_.join('\n') });
    text_.length = 0;
  };
  const flushFrames = () => {
    if (frames) out.push({ type: 'stack', frames });
    frames = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const py = PY_FRAME.exec(line);
    let frame = null;
    if (py) {
      const file = py[2];
      frame = { fn: py[4] || '', file, line: Number(py[3]), col: null, framework: frameworkFile(file), raw: line.trim() };
      const next = lines[i + 1];
      if (next !== undefined && /^\s+\S/.test(next) && !PY_FRAME.test(next) && !PY_MARKS.test(next) && next.search(/\S/) > py[1].length) {
        frame.code = next.trim();
        i++;
        while (i + 1 < lines.length && PY_MARKS.test(lines[i + 1]) && lines[i + 1].trim()) i++;
      }
    } else {
      frame = v8Frame(line) || vitestFrame(line);
    }

    if (frame) {
      flushText();
      (frames ||= []).push(frame);
    } else {
      flushFrames();
      text_.push(line);
    }
  }
  flushFrames();
  flushText();
  return out;
}

export function parseStack(text) {
  const frames = segmentStack(text).flatMap((s) => (s.type === 'stack' ? s.frames : []));
  return frames.length ? { frames } : null;
}

// App frames stay rows of their own; a run of framework frames is one row.
export function foldFrames(frames) {
  const rows = [];
  for (const frame of frames) {
    const last = rows.at(-1);
    if (frame.framework) {
      if (last?.type === 'fold') last.frames.push(frame);
      else rows.push({ type: 'fold', frames: [frame] });
    } else {
      rows.push({ type: 'app', frame });
    }
  }
  return rows;
}

function normalise(path) {
  const parts = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts;
}

// The path the Files view can open: relative to the project folder, or null
// when the file is outside it (main refuses those) or is not a file at all.
export function resolveFile(file, project) {
  if (!file || file.startsWith('node:') || file.startsWith('<')) return null;
  const path = file.replace(/\\/g, '/');
  const absolute = path.startsWith('/') || /^[A-Za-z]:\//.test(path);

  if (!absolute) {
    const rel = [];
    for (const part of path.split('/')) {
      if (!part || part === '.') continue;
      if (part !== '..') rel.push(part);
      else if (rel.pop() === undefined) return null;
    }
    return rel.length ? rel.join('/') : null;
  }

  if (!project) return null;
  const root = normalise(project.replace(/\\/g, '/'));
  const abs = normalise(path);
  if (abs.length <= root.length || root.some((p, i) => abs[i] !== p)) return null;
  return abs.slice(root.length).join('/');
}
