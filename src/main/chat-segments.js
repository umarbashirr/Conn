'use strict';
/* The sessions behind a chat that changed agent, keyed by its first session.
   See shared/chat-segments.js for what a segment is. Only the agent and the
   session are kept: where each one starts in the transcript is worked out
   again when the chat is reopened. */
const { sessionStore } = require('./session-store');
const { cleanSegments } = require('../shared/chat-segments');

module.exports = sessionStore('chat-segments.json', {
  value: cleanSegments,
  refusal: 'not a list of two or more segments',
});
