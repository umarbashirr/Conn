'use strict';
// Every command the keyboard can run, and the chord it starts with.
//
// `keys` is an Electron accelerator, so the native menu and this list cannot
// disagree about how a chord is spelled. An empty string means the command is
// waiting for someone to record one.
//
// `owner` says who actually hears the key. The menu owns a chord when the
// preview page may have the keyboard, because a keydown in this window never
// reaches that page. The renderer owns the rest. The chat box and the changes
// pane own the chords that would be wrong anywhere else.
//
// `steal` is for the terminal. A chord marked that way is not typed into the
// shell; Ctrl+K is not, because a shell has meant kill-to-end-of-line for that
// one since before this app existed.

const BINDINGS = [
  { id: 'palette', command: 'palette', label: 'Command palette', category: 'General', keys: 'CmdOrCtrl+K', owner: 'renderer', scope: 'shell', steal: false },
  { id: 'paletteAnywhere', command: 'palette', label: 'Command palette from anywhere', category: 'General', keys: 'CmdOrCtrl+Shift+P', owner: 'renderer', scope: 'app', steal: true },
  { id: 'settings', command: 'settings', label: 'Settings', category: 'General', keys: 'CmdOrCtrl+,', owner: 'menu', scope: 'menu', steal: false },
  { id: 'focusComposer', command: 'focusComposer', label: 'Focus the chat box', category: 'General', keys: 'CmdOrCtrl+Shift+K', owner: 'renderer', scope: 'app', steal: true },
  { id: 'newChat', command: 'newChat', label: 'New chat', category: 'General', keys: '', owner: 'renderer', scope: 'app', steal: true },
  { id: 'newChatNoFolder', command: 'newChatNoFolder', label: 'New chat without a folder', category: 'General', keys: '', owner: 'renderer', scope: 'app', steal: true },
  { id: 'openFolder', command: 'openFolder', label: 'Open folder', category: 'General', keys: 'CmdOrCtrl+O', owner: 'menu', scope: 'menu', steal: false },
  { id: 'openFolderWindow', command: 'openFolderWindow', label: 'Open folder in a new window', category: 'General', keys: 'CmdOrCtrl+Shift+O', owner: 'menu', scope: 'menu', steal: false },

  { id: 'send', command: 'send', label: 'Send the message', category: 'Chat', keys: 'Enter', owner: 'composer', scope: 'composer', steal: false },
  { id: 'newline', command: 'newline', label: 'New line', category: 'Chat', keys: 'Shift+Enter', owner: 'composer', scope: 'composer', steal: false },
  { id: 'cycleMode', command: 'cycleMode', label: 'Next permission mode', category: 'Chat', keys: 'Shift+Tab', owner: 'composer', scope: 'composer', steal: false },
  { id: 'stop', command: 'stop', label: 'Stop the turn', category: 'Chat', keys: '', owner: 'composer', scope: 'composer', steal: false },

  { id: 'rail', command: 'rail', label: 'Sessions', category: 'View', keys: 'CmdOrCtrl+Shift+S', owner: 'renderer', scope: 'app', steal: true },
  { id: 'terminal', command: 'terminal', label: 'Terminal', category: 'View', keys: 'CmdOrCtrl+`', owner: 'renderer', scope: 'app', steal: true },
  { id: 'newTerminal', command: 'newTerminal', label: 'New terminal', category: 'View', keys: 'CmdOrCtrl+Shift+T', owner: 'renderer', scope: 'app', steal: true },
  { id: 'preview', command: 'preview', label: 'Preview browser', category: 'View', keys: 'CmdOrCtrl+Shift+B', owner: 'renderer', scope: 'app', steal: true },
  { id: 'focusAddress', command: 'focusAddress', label: 'Focus the address bar', category: 'View', keys: 'CmdOrCtrl+Shift+L', owner: 'renderer', scope: 'app', steal: true },
  { id: 'pickElement', command: 'pickElement', label: 'Pick an element in the preview', category: 'View', keys: 'CmdOrCtrl+Shift+E', owner: 'renderer', scope: 'app', steal: true },
  { id: 'files', command: 'files', label: 'Project files', category: 'View', keys: 'CmdOrCtrl+Shift+D', owner: 'renderer', scope: 'app', steal: true },
  { id: 'changes', command: 'changes', label: 'Uncommitted changes', category: 'View', keys: 'CmdOrCtrl+Shift+G', owner: 'renderer', scope: 'app', steal: true },
  { id: 'agents', command: 'agents', label: 'Subagents', category: 'View', keys: '', owner: 'renderer', scope: 'app', steal: true },
  { id: 'previewFull', command: 'previewFull', label: 'Right pane at full width', category: 'View', keys: 'CmdOrCtrl+Shift+F', owner: 'menu', scope: 'menu', steal: false },
  { id: 'drawer', command: 'drawer', label: 'Console and network', category: 'View', keys: 'CmdOrCtrl+Shift+J', owner: 'renderer', scope: 'app', steal: true },
  { id: 'theme', command: 'theme', label: 'Light or dark', category: 'View', keys: '', owner: 'renderer', scope: 'app', steal: true },
  { id: 'appearance', command: 'appearance', label: 'Theme and appearance', category: 'View', keys: '', owner: 'renderer', scope: 'app', steal: true },

  { id: 'zoomIn', command: 'zoomIn', label: 'Zoom in', category: 'Zoom', keys: 'CmdOrCtrl+Plus', owner: 'menu', scope: 'menu', steal: false },
  { id: 'zoomOut', command: 'zoomOut', label: 'Zoom out', category: 'Zoom', keys: 'CmdOrCtrl+-', owner: 'menu', scope: 'menu', steal: false },
  { id: 'zoomReset', command: 'zoomReset', label: 'Reset zoom', category: 'Zoom', keys: 'CmdOrCtrl+0', owner: 'menu', scope: 'menu', steal: false },

  { id: 'nextChange', command: 'nextChange', label: 'Next change', category: 'Changes', keys: 'Alt+Down', owner: 'changes', scope: 'changes', steal: false },
  { id: 'prevChange', command: 'prevChange', label: 'Previous change', category: 'Changes', keys: 'Alt+Up', owner: 'changes', scope: 'changes', steal: false },

  { id: 'copyMcp', command: 'copyMcp', label: 'Copy MCP command', category: 'Help', keys: '', owner: 'renderer', scope: 'app', steal: true },
  { id: 'updates', command: 'updates', label: 'Check for updates', category: 'Help', keys: '', owner: 'renderer', scope: 'app', steal: true },
  { id: 'about', command: 'about', label: 'About Conn', category: 'Help', keys: '', owner: 'renderer', scope: 'app', steal: true },
];

for (let n = 1; n <= 9; n += 1) {
  BINDINGS.push({
    id: `terminalTab${n}`,
    command: 'terminalTab',
    arg: n,
    label: `Terminal tab ${n}`,
    category: 'Terminal',
    keys: `CmdOrCtrl+${n}`,
    owner: 'renderer',
    scope: 'app',
    steal: true,
  });
}

const BY_ID = Object.fromEntries(BINDINGS.map((row) => [row.id, row]));

const WHERE = {
  app: 'Anywhere in the window',
  shell: 'Anywhere except a terminal',
  menu: 'Anywhere, including the preview',
  composer: 'While the chat box is focused',
  changes: 'While the changes pane is open',
};

function defaultKeybindings() {
  return Object.fromEntries(BINDINGS.map((row) => [row.id, row.keys]));
}

function keyOf(overrides, id) {
  const row = BY_ID[id];
  if (!row) return '';
  const given = overrides?.[id];
  return typeof given === 'string' ? given : row.keys;
}

// Zoom in answers to the plus key and to the unshifted equals key, which is
// what most keyboards actually send. The second one is not its own command.
function accelerators(id, keys) {
  if (!keys) return [];
  if (id === 'zoomIn' && keys === 'CmdOrCtrl+Plus') return [keys, 'CmdOrCtrl+='];
  return [keys];
}

function partsOf(accel) {
  const mods = [];
  let key = '';
  for (const bit of String(accel || '').split('+')) {
    if (!bit) continue;
    const t = bit.toLowerCase();
    if (t === 'cmdorctrl' || t === 'cmd' || t === 'command' || t === 'ctrl' || t === 'control' || t === 'meta') mods.push('mod');
    else if (t === 'alt' || t === 'option') mods.push('alt');
    else if (t === 'shift') mods.push('shift');
    else key = bit;
  }
  return { mods, key };
}

function signature(accel) {
  const { mods, key } = partsOf(accel);
  const have = new Set(mods);
  const order = ['mod', 'alt', 'shift'].filter((m) => have.has(m));
  return [...order, key.toLowerCase()].join('+');
}

const FACE = { Plus: '+', Minus: '-', Space: 'Space' };

function formatChord(accel, { compact = false } = {}) {
  if (!accel) return '';
  const { mods, key } = partsOf(accel);
  const face = FACE[key] || key;
  if (compact) {
    const mark = mods.map((m) => (m === 'mod' ? '^' : m === 'shift' ? '⇧' : '⌥')).join('');
    return mark + face;
  }
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  const names = mods.map((m) => (m === 'mod' ? (mac ? 'Cmd' : 'Ctrl') : m === 'shift' ? 'Shift' : 'Alt'));
  return [...names, face].join('+');
}

// What the person pressed, spelled the same way a stored chord is. Shift and
// the equals key is the plus key, so it is stored as Plus rather than as a
// shifted equals, which is how the menu already names zoom in.
function eventToAccel(e) {
  const key = e.key;
  if (!key || key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta') return '';
  const code = e.code || '';
  let name = '';
  let shift = !!e.shiftKey;
  if (code.startsWith('Key') && code.length === 4) name = code.slice(3);
  else if (code.startsWith('Digit')) name = code.slice(5);
  else if (code === 'Equal') {
    name = shift ? 'Plus' : '=';
    if (shift) shift = false;
  } else if (code === 'Minus') name = 'Minus';
  else if (code === 'Backquote') name = '`';
  else if (code === 'Comma') name = ',';
  else if (code === 'Period') name = '.';
  else if (code === 'Space') name = 'Space';
  else if (code === 'Slash') name = '/';
  else if (code === 'Backslash') name = '\\';
  else if (code === 'BracketLeft') name = '[';
  else if (code === 'BracketRight') name = ']';
  else if (code === 'Semicolon') name = ';';
  else if (code === 'Quote') name = "'";
  else if (code === 'ArrowUp') name = 'Up';
  else if (code === 'ArrowDown') name = 'Down';
  else if (code === 'ArrowLeft') name = 'Left';
  else if (code === 'ArrowRight') name = 'Right';
  else if (key === 'Enter') name = 'Enter';
  else if (key === 'Tab') name = 'Tab';
  else if (key === 'Escape') name = 'Escape';
  else if (key === 'Backspace') name = 'Backspace';
  else if (key === 'Delete') name = 'Delete';
  else if (/^F\d+$/.test(code)) name = code;
  else if (/^F\d+$/.test(key)) name = key;
  else if (key.length === 1) name = key.toUpperCase();
  else return '';

  const parts = [];
  if (e.metaKey || e.ctrlKey) parts.push('CmdOrCtrl');
  if (e.altKey) parts.push('Alt');
  if (shift) parts.push('Shift');
  parts.push(name);
  return parts.join('+');
}

function matchEvent(e, accel, allowRepeat = false) {
  if (!accel || e.isComposing) return false;
  if (e.repeat && !allowRepeat) return false;
  const got = eventToAccel(e);
  return !!got && signature(got) === signature(accel);
}

const RESERVED = new Set(['mod+c', 'mod+v', 'mod+x', 'mod+a', 'mod+z', 'mod+y', 'mod+shift+z']);

function modified(sig) {
  return sig.startsWith('mod') || sig.startsWith('alt') || sig.startsWith('shift');
}

// A chord that would type a character, or that already belongs to editing
// text, is refused. The chat box is allowed Enter, Tab and Escape on their
// own, because that is where those keys already mean something.
function chordError(accel, scope) {
  if (!accel) return 'Press the keys for the shortcut.';
  const sig = signature(accel);
  const key = sig.split('+').pop();
  if (RESERVED.has(sig)) return 'That shortcut is for editing text.';
  if (scope === 'composer') {
    if (!modified(sig) && /^[a-z0-9=]$/.test(key)) {
      return 'Add Ctrl, Alt, or Shift, or it will type into the message.';
    }
    return '';
  }
        if (!modified(sig) && !/^f\d+$/.test(key)) return 'Add Ctrl, Alt, or Shift, or it will type.';
  return '';
}

function conflictWith(overrides, id, accel) {
  const want = signature(accel);
  if (!want) return null;
  for (const row of BINDINGS) {
    if (row.id === id) continue;
    const keys = keyOf(overrides, row.id);
    for (const chord of accelerators(row.id, keys)) {
      if (signature(chord) === want) return row;
    }
  }
  return null;
}

module.exports = {
  BINDINGS,
  BY_ID,
  WHERE,
  defaultKeybindings,
  keyOf,
  accelerators,
  signature,
  formatChord,
  eventToAccel,
  matchEvent,
  chordError,
  conflictWith,
};
