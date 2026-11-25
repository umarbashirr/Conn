'use strict';
/* Deleting a chat that may have run on several agents.

   The row always goes. Each session is deleted on its own, the chat's first
   one last, and one agent failing to delete its part stops nothing else: the
   sessions that could not be deleted come back in `left`, for the caller to
   hide and to name to the person. A reader that answers false found nothing
   to delete, which is the same as gone; only a throw counts as left. */
async function deleteChat({ id, segments = [], remove }) {
  const sessions = new Map(segments.map((s) => [s.session, s.provider]));
  const order = [...sessions.keys()].filter((s) => s !== id);
  order.push(id);
  const removed = [];
  const left = [];
  for (const session of order) {
    const provider = sessions.get(session);
    try {
      await remove(session, provider);
      removed.push(session);
    } catch (e) {
      left.push({ session, provider: provider || null, error: e?.message || String(e) });
    }
  }
  return { removed, left };
}

module.exports = { deleteChat };
