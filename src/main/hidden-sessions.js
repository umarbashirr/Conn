'use strict';
/* Sessions the rail never lists: the parts of a deleted chat that their agent
   could not delete from outside itself. The chat is gone, so there is no head
   row left to fold them into, and showing them would bring back a stretch of
   a chat the person deleted. */
const { sessionStore } = require('./session-store');

module.exports = sessionStore('hidden-sessions.json', {
  value: (v) => (v === true ? true : null),
  refusal: 'only true',
});
