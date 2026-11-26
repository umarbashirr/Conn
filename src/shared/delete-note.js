'use strict';
/* What the toast says after a delete that left something on disk. It says
   plainly what happened: when every part stayed, the chat was only taken out
   of Conn; when some went, it names which went and which stayed. */
const { labelOf } = require('./handoff');

const and = (names) => (names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);
const agents = (providers) => [...new Set(providers.map((p) => labelOf(p)))];
const WHERE = 'Settings › Chat › Hidden chats lists it, to show it again or try deleting it again.';

// `left` is what stayed, as { provider }; `deleted` the providers whose part went.
function deleteNote({ left = [], deleted = [] } = {}) {
  if (!left.length) return null;
  const kept = agents(left.map((l) => l.provider));
  const one = kept.length === 1;
  if (!deleted.length) {
    return { title: 'Removed from Conn.', description: `${and(kept)} kept ${one ? 'its copy' : 'their copies'} on disk. ${WHERE}` };
  }
  const gone = agents(deleted);
  return {
    title: `Deleted the ${and(gone)} part.`,
    description: `${and(kept)} kept ${one ? 'its part' : 'their parts'} on disk. ${WHERE}`,
  };
}

module.exports = { deleteNote };
