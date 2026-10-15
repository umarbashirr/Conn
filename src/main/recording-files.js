'use strict';
const fs = require('fs');
const path = require('path');

const STILLS = ['first', 'mid', 'last'];
const VIDEO = /\.(mp4|webm)$/i;

const stillPath = (video, which) => video.replace(VIDEO, `-${which}.jpg`);

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
