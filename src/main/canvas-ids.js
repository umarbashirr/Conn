'use strict';
/* Which board a session draws on.

   A chat's board id is minted when the chat is, and the $canvas brief names the
   folder in the transcript from the first message on. The session id only
   exists once the agent has started, so the pairing is written down then, and
   the rail hands it back when the chat is reopened after a restart. */
const { sessionStore } = require('./session-store');
const { CANVAS_ID } = require('../shared/canvas');

module.exports = sessionStore('canvas-ids.json', {
  value: (id) => (typeof id === 'string' && CANVAS_ID.test(id) ? id : null),
  refusal: 'not a board id',
});
