'use strict';
const { RENAME_MAX } = require('../shared/chat-title');
const { sessionStore } = require('./session-store');

const clean = (title) => (typeof title === 'string' ? title.trim().slice(0, RENAME_MAX) : '');

module.exports = sessionStore('chat-titles.json', {
  value: (title) => clean(title) || null,
  refusal: 'Give the chat a name.',
});
