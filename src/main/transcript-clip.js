'use strict';
/* What a replayed transcript is allowed to weigh, for the providers that read
   a chat back from a CLI rather than from a file of their own. */

const MAX_MESSAGES = 400;
const MAX_TEXT = 6000;

// A whole npm install lands in one tool_result, and the panel has nowhere to
// put 400KB of it.
function slim(msg) {
  const c = msg.message?.content;
  if (!Array.isArray(c)) return msg;
  const content = c.map((b) => {
    if (typeof b.text === 'string' && b.text.length > MAX_TEXT) {
      return { ...b, text: `${b.text.slice(0, MAX_TEXT)}\n… truncated` };
    }
    if (typeof b.content === 'string' && b.content.length > MAX_TEXT) {
      return { ...b, content: `${b.content.slice(0, MAX_TEXT)}\n… truncated` };
    }
    return b;
  });
  return { ...msg, message: { ...msg.message, content } };
}

// The newest MAX_MESSAGES, each slimmed, in the shape agent:transcript returns.
function clip(id, messages) {
  const tail = messages.slice(-MAX_MESSAGES);
  return { id, truncated: messages.length > tail.length, messages: tail.map(slim) };
}

module.exports = { clip, slim, MAX_MESSAGES, MAX_TEXT };
