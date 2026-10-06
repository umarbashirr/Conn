'use strict';
/* Names a person gave a chat.

   A transcript's title is the first thing typed in it, and claude never writes
   another. Renaming has to live beside that, the way a completed mark does,
   or the next history read puts the first message back. */
const { sessionStore } = require('./session-store');

const clean = (title) => (typeof title === 'string' ? title.trim().slice(0, 80) : '');

module.exports = sessionStore('chat-titles.json', {
  value: (title) => clean(title) || null,
  refusal: 'Give the chat a name.',
});
