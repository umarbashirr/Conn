'use strict';
const path = require('path');

// A file named by an agent, kept inside `dir`. `name` is a file name and never
// a directory: whatever folders it carries are dropped, and a name that is
// nothing (or `..`) falls back to `${prefix}-${now}`. `strip` lists the
// extensions a caller may have typed that `ext` is about to add again.
function safeFilePath(dir, name, { ext, prefix, strip = [ext] }) {
  const fallback = () => `${prefix}-${Date.now()}`;
  let stem;
  if (name != null && String(name).trim() !== '') {
    const drop = new RegExp(`\\.(${strip.join('|')})$`, 'i');
    const base = path.basename(String(name)).replace(drop, '');
    if (!base || base === '.' || base === '..') stem = fallback();
    else stem = base;
  } else {
    stem = fallback();
  }
  const file = path.resolve(dir, `${stem}.${ext}`);
  const root = path.resolve(dir);
  if (file !== root && !file.startsWith(root + path.sep)) {
    return path.join(dir, `${fallback()}.${ext}`);
  }
  return path.join(dir, `${stem}.${ext}`);
}

const screenshotFilePath = (shotDir, name) => safeFilePath(shotDir, name, { ext: 'png', prefix: 'shot' });

module.exports = { screenshotFilePath, safeFilePath };
