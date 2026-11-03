'use strict';

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

// The last `limit` stored messages before `end`. The panel opens a chat on the
// newest 400 and asks for more as the reader climbs, each time ending where the
// first read did: a turn run since then is on screen already and is not read
// back in twice. The values come over IPC, so anything else means the default.
function windowOf(messages, { limit, end } = {}) {
  const total = messages.length;
  const to = Number.isInteger(end) && end >= 0 ? Math.min(end, total) : total;
  const n = Number.isInteger(limit) && limit > 0 ? limit : MAX_MESSAGES;
  const from = Math.max(0, to - n);
  return { total, truncated: from > 0, messages: messages.slice(from, to) };
}

function clip(id, messages, { whole, ...opts } = {}) {
  if (whole) return { id, total: messages.length, truncated: false, messages };
  const w = windowOf(messages, opts);
  return { id, ...w, messages: w.messages.map(slim) };
}

module.exports = { clip, slim, windowOf, MAX_MESSAGES, MAX_TEXT };
