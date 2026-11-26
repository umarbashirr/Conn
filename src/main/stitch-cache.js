'use strict';
/* A switched chat's stitched transcript, kept for the phone, which asks again
   on every refresh. Each read checks every session's stamp first, and any
   change reads the chat again. A session with no stamp is read fresh every
   time and never kept. `stampOf(dir, session, provider)` is the caller's; see
   index.js for what goes into one. */
function createStitchCache({ read, stampOf, size = 20 }) {
  const kept = new Map();
  return async function get(dir, segs) {
    const key = `${dir}\0${segs.map((x) => x.session).join(',')}`;
    const stamps = await Promise.all(segs.map((x) => stampOf(dir, x.session, x.provider)));
    const stamp = stamps.every((s) => s) ? stamps.join('|') : null;
    const hit = kept.get(key);
    if (stamp && hit?.stamp === stamp) return hit.messages;
    const messages = await read(dir, segs);
    if (stamp) {
      kept.delete(key);
      kept.set(key, { stamp, messages });
      if (kept.size > size) kept.delete(kept.keys().next().value);
    } else {
      kept.delete(key);
    }
    return messages;
  };
}

module.exports = { createStitchCache };
