'use strict';
const fs = require('fs');

// Every spelling an agent may have recorded a project folder under. Codex and
// the ACP agents filter their history by exact string, and on Windows the same
// folder turns up as D:\TMS\app or d:\TMS\app, depending on how the terminal
// that started the chat typed it. A symlinked folder is also recorded under
// whichever path started the thread, so its real path goes in too.
function cwdSpellings(cwd) {
  const out = [];
  const add = (p) => { if (p && !out.includes(p)) out.push(p); };
  const base = [cwd];
  try { base.push(fs.realpathSync(cwd)); } catch {}
  for (const p of base) {
    if (process.platform !== 'win32') { add(p); continue; }
    const trimmed = p.length > 3 ? p.replace(/[\\/]+$/, '') : p;
    for (const v of [trimmed, trimmed.replace(/\//g, '\\')]) {
      add(v);
      if (/^[a-z]:/i.test(v)) {
        add(v[0].toUpperCase() + v.slice(1));
        add(v[0].toLowerCase() + v.slice(1));
      }
    }
  }
  return out;
}

module.exports = { cwdSpellings };
