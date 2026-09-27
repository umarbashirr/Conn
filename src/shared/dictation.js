'use strict';
// One dictation take as a state machine, and the per-chat outbox its words
// wait in. Pure, so the whole policy can be run from node without a window.
//
// Session:
//   { kind: 'unavailable', reason }
//   { kind: 'idle' }
//   { kind: 'requesting', id, chat }                 waiting on the microphone
//   { kind: 'listening', id, chat, mic, startedAt }
//   { kind: 'transcribing', id, chat }
//   { kind: 'failed', reason, chat }
//
// Every async result carries the id of the take that asked for it. One that
// does not match the live take changes nothing, except a microphone grant,
// which is aborted so the OS indicator goes off.
const { SPEECH_RATE, MIN_SECONDS } = require('./speech');

const IDLE = { kind: 'idle' };
const TOO_SHORT = 'That was too short to hear anything. Hold it a little longer.';
const HEARD_NOTHING = 'Nothing was heard in that recording.';

const to = (session, effects = []) => ({ session, effects });
const current = (session, id) => session.id !== undefined && session.id === id;

function transition(session, event) {
  const { kind } = session;
  switch (event.type) {
    case 'probed': {
      const { probe } = event;
      if (probe.ok) return kind === 'unavailable' ? to(IDLE) : to(session);
      if (kind === 'unavailable' || kind === 'idle' || kind === 'failed') {
        return to({ kind: 'unavailable', reason: probe.reason });
      }
      return to(session);
    }

    case 'toggle': {
      if (kind === 'idle' || kind === 'failed') {
        return to({ kind: 'requesting', id: event.id, chat: event.chat }, [{ do: 'openMic', id: event.id }]);
      }
      // The grant still in flight is aborted by the micOpened row when it lands.
      if (kind === 'requesting') return to(IDLE);
      if (kind === 'listening') {
        return to({ kind: 'transcribing', id: session.id, chat: session.chat },
          [{ do: 'finishMic', id: session.id, mic: session.mic }]);
      }
      return to(session);
    }

    case 'cancel': {
      if (kind === 'listening') return to(IDLE, [{ do: 'abortMic', mic: session.mic }]);
      if (kind === 'requesting' || kind === 'transcribing' || kind === 'failed') return to(IDLE);
      return to(session);
    }

    case 'chatShown': {
      if (session.chat === undefined || session.chat === event.chat) return to(session);
      if (kind === 'requesting' || kind === 'failed') return to(IDLE);
      if (kind === 'listening') {
        return to({ kind: 'transcribing', id: session.id, chat: session.chat },
          [{ do: 'finishMic', id: session.id, mic: session.mic }]);
      }
      return to(session);
    }

    case 'micOpened': {
      if (kind !== 'requesting' || !current(session, event.id)) {
        return to(session, [{ do: 'abortMic', mic: event.mic }]);
      }
      return to({ kind: 'listening', id: session.id, chat: session.chat, mic: event.mic, startedAt: event.at },
        [{ do: 'armTimer', id: session.id }]);
    }

    case 'micFailed': {
      if (kind !== 'requesting' || !current(session, event.id)) return to(session);
      return to({ kind: 'failed', reason: event.reason, chat: session.chat });
    }

    case 'timeUp': {
      if (kind !== 'listening' || !current(session, event.id)) return to(session);
      return to({ kind: 'transcribing', id: session.id, chat: session.chat },
        [{ do: 'finishMic', id: session.id, mic: session.mic }]);
    }

    case 'captured': {
      if (kind !== 'transcribing' || !current(session, event.id)) return to(session);
      if (event.audio.length < MIN_SECONDS * SPEECH_RATE) {
        return to({ kind: 'failed', reason: TOO_SHORT, chat: session.chat });
      }
      return to(session, [{ do: 'transcribe', id: session.id, audio: event.audio }]);
    }

    case 'transcribed': {
      if (kind !== 'transcribing' || !current(session, event.id)) return to(session);
      const { result } = event;
      const text = result.ok ? result.text.trim() : '';
      if (text) return to(IDLE, [{ do: 'deliver', chat: session.chat, text }]);
      return to({ kind: 'failed', reason: result.ok ? HEARD_NOTHING : result.reason, chat: session.chat });
    }

    default:
      throw new Error(`dictation: unknown event ${event.type}`);
  }
}

// The outbox holds words whose chat was not on screen when they arrived. Two
// takes for the same chat join with a space rather than one replacing the other.
function park(outbox, chat, text) {
  const waiting = outbox[chat];
  return { ...outbox, [chat]: waiting ? `${waiting} ${text}` : text };
}

// Hands a chat's parked words to `insert`, which answers false when that chat
// is not the one on screen. Kept until it says yes.
function flush(outbox, chat, insert) {
  const waiting = outbox[chat];
  if (!waiting || !insert(chat, waiting)) return outbox;
  const { [chat]: _sent, ...rest } = outbox;
  return rest;
}

module.exports = { transition, park, flush, IDLE, TOO_SHORT, HEARD_NOTHING };
