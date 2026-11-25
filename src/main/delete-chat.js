'use strict';
/* Deleting a chat that may have run on several agents.

   The other sessions go first, each on its own: one agent failing to delete
   its part must not stop the rest, and must not take the chat's first session
   with it before the person has been told. Only a session whose delete threw
   counts as left behind. A reader that answers false found nothing to delete,
   which is the same as gone. The first session goes last; if that fails the
   error comes back with what was removed, and the caller keeps the chat's
   record, so nothing it still lists comes loose. */
async function deleteChat({ id, segments = [], remove }) {
  const rest = [...new Map(segments.filter((s) => s.session !== id).map((s) => [s.session, s.provider])).entries()];
  const left = [];
  const removed = [];
  for (const [session, provider] of rest) {
    try {
      await remove(session, provider);
      removed.push(session);
    } catch (e) {
      left.push({ session, provider, error: e?.message || String(e) });
    }
  }
  try {
    const gone = await remove(id, segments.find((s) => s.session === id)?.provider);
    return { gone, removed, left };
  } catch (e) {
    return { gone: false, removed, left, error: e?.message || String(e) };
  }
}

module.exports = { deleteChat };
