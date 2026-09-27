'use strict';
// Every row of the dictation transition table, plus the outbox that holds a
// transcript whose chat is not on screen.
const assert = require('assert');
const path = require('path');
const ROOT = process.env.CONN_ROOT || path.join(__dirname, '..');
const { transition, park, flush, TOO_SHORT, HEARD_NOTHING } = require(path.join(ROOT, 'src/shared/dictation.js'));
const { SPEECH_RATE, MAX_SECONDS, MIN_SECONDS } = require(path.join(ROOT, 'src/shared/speech.js'));

const failures = [];
const check = (name, fn) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}: ${e.message}`);
    failures.push(name);
  }
};

const MIC = { name: 'live mic' };
const LATE = { name: 'late grant' };
const LONG = new Int16Array(SPEECH_RATE);
const SHORT = new Int16Array(Math.floor(MIN_SECONDS * SPEECH_RATE) - 1);

const S = {
  unavailable: { kind: 'unavailable', reason: 'no command' },
  idle: { kind: 'idle' },
  requesting: { kind: 'requesting', id: 1, chat: 'a' },
  listening: { kind: 'listening', id: 1, chat: 'a', mic: MIC, startedAt: 100 },
  transcribing: { kind: 'transcribing', id: 1, chat: 'a' },
  failed: { kind: 'failed', reason: 'mic refused', chat: 'a' },
};

const E = {
  probedOk: { type: 'probed', probe: { ok: true } },
  probedNo: { type: 'probed', probe: { ok: false, reason: 'whisper-cli is not on PATH' } },
  toggle: { type: 'toggle', chat: 'a', id: 2 },
  cancel: { type: 'cancel' },
  chatSame: { type: 'chatShown', chat: 'a' },
  chatOther: { type: 'chatShown', chat: 'b' },
  micOpened: { type: 'micOpened', id: 1, mic: LATE, at: 500 },
  micOpenedStale: { type: 'micOpened', id: 9, mic: LATE, at: 500 },
  micFailed: { type: 'micFailed', id: 1, reason: 'Microphone access was refused.' },
  micFailedStale: { type: 'micFailed', id: 9, reason: 'late' },
  timeUp: { type: 'timeUp', id: 1 },
  timeUpStale: { type: 'timeUp', id: 9 },
  captured: { type: 'captured', id: 1, audio: LONG },
  capturedShort: { type: 'captured', id: 1, audio: SHORT },
  capturedStale: { type: 'captured', id: 9, audio: LONG },
  transcribed: { type: 'transcribed', id: 1, result: { ok: true, text: '  fix the header  ' } },
  transcribedEmpty: { type: 'transcribed', id: 1, result: { ok: true, text: '   ' } },
  transcribedError: { type: 'transcribed', id: 1, result: { ok: false, reason: 'whisper-cli exited with code 1' } },
  transcribedStale: { type: 'transcribed', id: 9, result: { ok: true, text: 'late words' } },
};

const idle = { kind: 'idle' };
const unavailable = { kind: 'unavailable', reason: 'whisper-cli is not on PATH' };
const abortLate = [{ do: 'abortMic', mic: LATE }];

// Every cell that is not blank. A cell missing here must leave the session
// untouched with no effects.
const ROWS = {
  unavailable: {
    probedOk: [idle, []],
    probedNo: [unavailable, []],
    micOpened: [S.unavailable, abortLate],
    micOpenedStale: [S.unavailable, abortLate],
  },
  idle: {
    probedNo: [unavailable, []],
    toggle: [{ kind: 'requesting', id: 2, chat: 'a' }, [{ do: 'openMic', id: 2 }]],
    micOpened: [S.idle, abortLate],
    micOpenedStale: [S.idle, abortLate],
  },
  requesting: {
    toggle: [idle, []],
    cancel: [idle, []],
    chatOther: [idle, []],
    micOpened: [{ kind: 'listening', id: 1, chat: 'a', mic: LATE, startedAt: 500 }, [{ do: 'armTimer', id: 1 }]],
    micOpenedStale: [S.requesting, abortLate],
    micFailed: [{ kind: 'failed', reason: 'Microphone access was refused.', chat: 'a' }, []],
  },
  listening: {
    toggle: [S.transcribing, [{ do: 'finishMic', id: 1, mic: MIC }]],
    cancel: [idle, [{ do: 'abortMic', mic: MIC }]],
    chatOther: [S.transcribing, [{ do: 'finishMic', id: 1, mic: MIC }]],
    micOpened: [S.listening, abortLate],
    micOpenedStale: [S.listening, abortLate],
    timeUp: [S.transcribing, [{ do: 'finishMic', id: 1, mic: MIC }]],
  },
  transcribing: {
    cancel: [idle, []],
    micOpened: [S.transcribing, abortLate],
    micOpenedStale: [S.transcribing, abortLate],
    captured: [S.transcribing, [{ do: 'transcribe', id: 1, audio: LONG }]],
    capturedShort: [{ kind: 'failed', reason: TOO_SHORT, chat: 'a' }, []],
    transcribed: [idle, [{ do: 'deliver', chat: 'a', text: 'fix the header' }]],
    transcribedEmpty: [{ kind: 'failed', reason: HEARD_NOTHING, chat: 'a' }, []],
    transcribedError: [{ kind: 'failed', reason: 'whisper-cli exited with code 1', chat: 'a' }, []],
  },
  failed: {
    probedNo: [unavailable, []],
    toggle: [{ kind: 'requesting', id: 2, chat: 'a' }, [{ do: 'openMic', id: 2 }]],
    cancel: [idle, []],
    chatOther: [idle, []],
    micOpened: [S.failed, abortLate],
    micOpenedStale: [S.failed, abortLate],
  },
};

for (const [state, session] of Object.entries(S)) {
  for (const [name, event] of Object.entries(E)) {
    const want = ROWS[state][name];
    check(`${state} + ${name}`, () => {
      const got = transition(session, event);
      if (want) {
        assert.deepStrictEqual(got.session, want[0]);
        assert.deepStrictEqual(got.effects, want[1]);
      } else {
        assert.strictEqual(got.session, session, 'session changed on a blank cell');
        assert.deepStrictEqual(got.effects, []);
      }
    });
  }
}

check('unknown event throws', () => {
  assert.throws(() => transition(S.idle, { type: 'nope' }), /unknown event nope/);
});

check('a grant that lands after cancel is aborted and changes nothing', () => {
  const asked = transition(S.idle, { type: 'toggle', chat: 'a', id: 1 });
  assert.deepStrictEqual(asked.effects, [{ do: 'openMic', id: 1 }]);
  const cancelled = transition(asked.session, { type: 'cancel' });
  assert.deepStrictEqual(cancelled.session, idle);
  const late = transition(cancelled.session, { type: 'micOpened', id: 1, mic: LATE, at: 1 });
  assert.strictEqual(late.session, cancelled.session);
  assert.deepStrictEqual(late.effects, abortLate);
});

check('a grant from an earlier take is aborted while a newer take waits', () => {
  let s = transition(S.idle, { type: 'toggle', chat: 'a', id: 1 }).session;
  s = transition(s, { type: 'toggle', chat: 'a', id: 1 }).session;
  s = transition(s, { type: 'toggle', chat: 'a', id: 2 }).session;
  const old = transition(s, { type: 'micOpened', id: 1, mic: LATE, at: 1 });
  assert.deepStrictEqual(old.session, { kind: 'requesting', id: 2, chat: 'a' });
  assert.deepStrictEqual(old.effects, abortLate);
  const fresh = transition(s, { type: 'micOpened', id: 2, mic: MIC, at: 2 });
  assert.deepStrictEqual(fresh.session, { kind: 'listening', id: 2, chat: 'a', mic: MIC, startedAt: 2 });
});

check('switching chats mid-take delivers into the outbox, not the chat on screen', () => {
  const inserted = [];
  const onScreen = { chat: 'b' };
  const insert = (chat, text) => {
    if (chat !== onScreen.chat) return false;
    inserted.push([chat, text]);
    return true;
  };

  let step = transition(S.listening, { type: 'chatShown', chat: 'b' });
  assert.deepStrictEqual(step.effects, [{ do: 'finishMic', id: 1, mic: MIC }]);
  step = transition(step.session, { type: 'captured', id: 1, audio: LONG });
  step = transition(step.session, { type: 'chatShown', chat: 'b' });
  assert.deepStrictEqual(step.session, S.transcribing);
  step = transition(step.session, { type: 'transcribed', id: 1, result: { ok: true, text: 'rename the button' } });
  assert.deepStrictEqual(step.effects, [{ do: 'deliver', chat: 'a', text: 'rename the button' }]);

  let outbox = park({}, 'a', 'rename the button');
  outbox = flush(outbox, 'a', insert);
  assert.deepStrictEqual(outbox, { a: 'rename the button' });
  assert.deepStrictEqual(inserted, []);

  outbox = flush(outbox, 'b', insert);
  assert.deepStrictEqual(outbox, { a: 'rename the button' });
  assert.deepStrictEqual(inserted, []);

  onScreen.chat = 'a';
  outbox = flush(outbox, 'a', insert);
  assert.deepStrictEqual(outbox, {});
  assert.deepStrictEqual(inserted, [['a', 'rename the button']]);
});

check('two parked takes for one chat join with a space', () => {
  const outbox = park(park({ b: 'other' }, 'a', 'first part'), 'a', 'second part');
  assert.deepStrictEqual(outbox, { b: 'other', a: 'first part second part' });
});

check('speech constants', () => {
  assert.deepStrictEqual([SPEECH_RATE, MAX_SECONDS, MIN_SECONDS], [16000, 300, 0.3]);
});

console.log(failures.length ? `\n${failures.length} FAILED` : '\nall passed');
process.exit(failures.length ? 1 : 0);
