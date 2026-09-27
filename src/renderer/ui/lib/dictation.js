// One dictation session per window. The policy is the pure transition in
// shared/dictation.js; this runs its effects and keeps the per-chat outbox of
// words that arrived while their chat was not on screen.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { flush, park, transition } from '../../../shared/dictation';
import { MAX_SECONDS } from '../../../shared/speech';
import { openMic } from '@/lib/mic';

function viewOf(session) {
  switch (session.kind) {
    case 'unavailable':
    case 'failed':
      return { kind: session.kind, reason: session.reason };
    case 'listening':
      return { kind: 'listening', startedAt: session.startedAt };
    case 'idle':
    case 'requesting':
    case 'transcribing':
      return { kind: session.kind };
    default:
      throw new Error(`dictation: unknown session ${session.kind}`);
  }
}

const reasonOf = (err) => err?.message || String(err);

export function createDictation(deps) {
  let session = { kind: 'idle' };
  let view = viewOf(session);
  let outbox = {};
  let takes = 0;
  let disposed = false;
  const subscribers = new Set();

  const dispatch = (raw) => {
    if (disposed) {
      raw.mic?.abort();
      return;
    }
    const event = raw.type === 'toggle' ? { ...raw, id: takes += 1 } : raw;
    if (event.type === 'chatShown') outbox = flush(outbox, event.chat, deps.insert);
    const next = transition(session, event);
    if (next.session !== session) {
      session = next.session;
      view = viewOf(session);
      for (const fn of subscribers) fn();
    }
    for (const effect of next.effects) run(effect);
  };

  const run = (effect) => {
    const { id } = effect;
    switch (effect.do) {
      case 'openMic':
        deps.openMic().then(
          (mic) => dispatch({ type: 'micOpened', id, mic, at: deps.now() }),
          (err) => dispatch({ type: 'micFailed', id, reason: reasonOf(err) }),
        );
        return;
      case 'armTimer':
        deps.setTimer(MAX_SECONDS * 1000, () => dispatch({ type: 'timeUp', id }));
        return;
      case 'finishMic':
        effect.mic.finish().then(
          (audio) => dispatch({ type: 'captured', id, audio }),
          (err) => dispatch({ type: 'transcribed', id, result: { ok: false, reason: reasonOf(err) } }),
        );
        return;
      case 'abortMic':
        effect.mic.abort();
        return;
      case 'transcribe':
        deps.transcribe(effect.audio).then(
          (result) => dispatch({ type: 'transcribed', id, result }),
          (err) => dispatch({ type: 'transcribed', id, result: { ok: false, reason: reasonOf(err) } }),
        );
        return;
      case 'deliver':
        outbox = flush(park(outbox, effect.chat, effect.text), effect.chat, deps.insert);
        return;
      default:
        throw new Error(`dictation: unknown effect ${effect.do}`);
    }
  };

  return {
    dispatch,
    view: () => view,
    subscribe: (fn) => {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    level: () => (session.kind === 'listening' ? session.mic.level() : 0),
    // True when there was a take, or a failure on the button, to throw away.
    cancel: () => {
      const before = session;
      dispatch({ type: 'cancel' });
      return session !== before;
    },
    dispose: () => {
      if (session.kind === 'listening') session.mic.abort();
      disposed = true;
    },
  };
}

export function useDictation({ input, chat, command }) {
  const chatRef = useRef(chat);
  chatRef.current = chat;

  const [controller] = useState(() => createDictation({
    // Main checks the command and, on macOS, the OS permission before the
    // microphone opens, so a broken setup fails before anyone speaks.
    openMic: async () => {
      const armed = await window.conn.dictation.arm();
      if (!armed?.ok) throw new Error(armed?.reason || 'Dictation is not set up.');
      return openMic();
    },
    transcribe: (audio) => window.conn.dictation.transcribe(audio),
    insert: (target, text) => {
      if (target !== chatRef.current || !input.current) return false;
      input.current.insertText(text);
      return true;
    },
    setTimer: (ms, fn) => setTimeout(fn, ms),
    now: Date.now,
  }));

  useEffect(() => {
    let live = true;
    window.conn.dictation.arm()
      .catch((err) => ({ ok: false, reason: reasonOf(err) }))
      .then((probe) => { if (live) controller.dispatch({ type: 'probed', probe }); });
    return () => { live = false; };
  }, [controller, command]);

  // Every render, not only on a chat change: the box can come back without the
  // chat changing (a full page closing), and a parked take should land then.
  useEffect(() => { controller.dispatch({ type: 'chatShown', chat }); });

  useEffect(() => () => controller.dispose(), [controller]);

  const view = useSyncExternalStore(controller.subscribe, controller.view);
  const toggle = useCallback(() => controller.dispatch({ type: 'toggle', chat: chatRef.current }), [controller]);
  return { view, toggle, cancel: controller.cancel, level: controller.level };
}
