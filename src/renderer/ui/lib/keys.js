// The live copy of the shortcut list. Main owns the file; this module is the
// copy the keydown listeners ask, so a chord changed on the settings page is
// the chord the next keypress runs.
import {
  BINDINGS,
  WHERE,
  accelerators,
  chordError,
  conflictWith,
  defaultKeybindings,
  eventToAccel,
  formatChord,
  keyOf,
  matchEvent,
} from '../../../shared/keybindings';

let overrides = null;

export function setOverrides(map) {
  overrides = map && typeof map === 'object' ? map : null;
}

export function currentKey(id) {
  return keyOf(overrides, id);
}

function rows() {
  return BINDINGS.map((row) => ({ ...row, keys: keyOf(overrides, row.id) }));
}

export function matches(e, id) {
  return matchEvent(e, currentKey(id));
}

// The one the renderer should run. Menu-owned chords are left alone here,
// because the native menu already ran them and running them twice would
// toggle the thing straight back.
export function findBinding(e) {
  if (!e || e.isComposing || e.repeat) return null;
  for (const row of rows()) {
    if (row.owner !== 'renderer' || !row.keys) continue;
    if (matchEvent(e, row.keys)) return row;
  }
  return null;
}

// True when the terminal must not type this key. Asked by xterm before the
// window listener runs, so it reads the same list.
export function chordSteals(e) {
  for (const row of rows()) {
    if (!row.steal || !row.keys) continue;
    if (matchEvent(e, row.keys, true)) return true;
  }
  return false;
}

export function inTerminal(target) {
  return !!(target instanceof Element && target.closest('.xterm'));
}

export {
  BINDINGS,
  WHERE,
  accelerators,
  chordError,
  conflictWith,
  defaultKeybindings,
  eventToAccel,
  formatChord,
  keyOf,
  matchEvent,
};
