'use strict';

// The composer label and the process that answers a chat are easy to update
// apart. These three questions are the whole rule, so the renderer and main
// cannot each invent a different one.

// A session that just said which model it started on replaces the label, but
// only for the chat on screen. A background chat must not steal it.
function shownModel(shown, reported, forActive) {
  if (forActive && reported) return reported;
  return shown || reported || '';
}

// A chat that has already chosen a model, or that already has a transcript,
// does not follow the next window-wide provider push.
function followsWindowProvider(chat) {
  return !(chat?.items?.length || chat?.session || chat?.usage?.model);
}

// A live session is the one that answers the next message. It is the right
// process only while the chat is still on the CLI that started it.
function reuseLive(liveProvider, requestedProvider) {
  if (!liveProvider) return false;
  if (!requestedProvider || requestedProvider === liveProvider) return true;
  return false;
}

module.exports = { shownModel, followsWindowProvider, reuseLive };
