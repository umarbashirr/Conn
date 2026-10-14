'use strict';
// A recording is a video and three stills beside it, named after it.
const fs = require('fs');
const path = require('path');

const STILLS = ['first', 'mid', 'last'];
const VIDEO = /\.(mp4|webm)$/i;

const stillPath = (video, which) => video.replace(VIDEO, `-${which}.jpg`);

// Oldest first goes, by mtime, a video together with its stills. Stills whose
// video is already gone are not looked for: nothing here makes them.
function pruneRecordings(dir, keep) {
  try {
    const videos = fs.readdirSync(dir)
      .filter((f) => VIDEO.test(f))
      .map((f) => {
        const full = path.join(dir, f);
        try { return { full, at: fs.statSync(full).mtimeMs }; } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.at - a.at);
    for (const { full } of videos.slice(keep)) {
      for (const f of [full, ...STILLS.map((s) => stillPath(full, s))]) {
        try { fs.unlinkSync(f); } catch {}
      }
    }
  } catch {}
}

module.exports = { STILLS, stillPath, pruneRecordings };
