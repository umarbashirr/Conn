'use strict';
// The native application menu. The window draws its own title bar, so this one
// stays hidden until Alt is pressed; it exists so folder switching, the clipboard
// and the window roles are reachable from the keyboard wherever focus happens to
// be, including inside the preview pane.
//
// View items carry an accelerator for display only. Those chords are already
// handled in the renderer, and registering them here too would fire twice.
const os = require('os');
const { Menu } = require('electron');
const { accelerators } = require('../shared/keybindings');

const home = os.homedir();
const short = (p) => (p === home ? '~' : p.startsWith(home + '/') ? '~' + p.slice(home.length) : p);

function buildMenu({ recents = [], actions, keys = {} }) {
  const isMac = process.platform === 'darwin';
  // A cleared shortcut is absent, not an accelerator of "".
  const chord = (id) => accelerators(id, keys[id])[0];
  const command = (label, name, id) => {
    const item = {
      label,
      registerAccelerator: false,
      click: () => actions.command(name),
    };
    const accelerator = chord(id);
    if (accelerator) item.accelerator = accelerator;
    return item;
  };
  // The one chord the menu really owns. With the preview at full width the
  // focus is usually inside the page, where a renderer keydown never lands, so
  // this accelerator is registered for real and the renderer leaves it alone.
  const hotkey = (label, name, id) => {
    const item = { label, click: () => actions.command(name) };
    const accelerator = typeof id === 'string' && id.includes('+') ? id : chord(id);
    if (accelerator) item.accelerator = accelerator;
    return item;
  };
  const labeled = (label, accelerator, click) => {
    const item = { label, click };
    if (accelerator) item.accelerator = accelerator;
    return item;
  };

  const recentItems = recents.length
    ? [
      ...recents.map((r) => ({ label: short(r.path), click: () => actions.openRecent(r.path) })),
      { type: 'separator' },
      { label: 'Clear list', click: () => actions.clearRecents() },
    ]
    : [{ label: 'Nothing yet', enabled: false }];

  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '&File',
      submenu: [
        labeled('Open Folder…', chord('openFolder'), () => actions.openFolder()),
        labeled('Open Folder in New Window…', chord('openFolderWindow'), () => actions.openFolder({ newWindow: true })),
        { label: 'Open Recent', submenu: recentItems },
        { type: 'separator' },
        command('New Chat', 'newChat', 'newChat'),
        command('New Terminal', 'newTerminal', 'newTerminal'),
        { type: 'separator' },
        hotkey('Settings…', 'settings', 'settings'),
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: '&View',
      submenu: [
        // Display only, like its neighbours: the renderer owns Ctrl+K so that a
        // shell with the cursor in it keeps kill-to-end-of-line, which a real
        // accelerator here would take from every terminal in the window.
        command('Command Palette', 'palette', 'palette'),
        { type: 'separator' },
        command('Sessions', 'rail', 'rail'),
        command('Terminal', 'terminal', 'terminal'),
        command('Preview Browser', 'preview', 'preview'),
        command('Project Files', 'files', 'files'),
        command('Uncommitted Changes', 'changes', 'changes'),
        hotkey('Right Pane at Full Width', 'previewFull', 'previewFull'),
        command('Console and Network', 'drawer', 'drawer'),
        { type: 'separator' },
        command('Light or Dark', 'theme', 'theme'),
        command('Theme…', 'appearance', 'appearance'),
        { type: 'separator' },
        // The renderer owns the zoom, because the app shell and the preview
        // pane are different web contents and only one of them should scale.
        // These are registered for real: with the preview at full width the
        // focus is inside the page, where a renderer keydown never lands.
        hotkey('Zoom In', 'zoomIn', 'zoomIn'),
        // Same command on the unshifted key, which is what most keyboards
        // actually produce. A menu item carries one accelerator, so it takes
        // two of them to cover both, and only while zoom in is still the
        // default plus key.
        ...accelerators('zoomIn', keys.zoomIn).slice(1).map((accelerator) => ({
          ...hotkey('Zoom In', 'zoomIn', accelerator),
          visible: false,
        })),
        hotkey('Zoom Out', 'zoomOut', 'zoomOut'),
        hotkey('Reset Zoom', 'zoomReset', 'zoomReset'),
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools', label: 'Developer Tools (app shell)' },
      ],
    },
    {
      label: '&Help',
      submenu: [
        command('Copy MCP Command', 'copyMcp', 'copyMcp'),
        command('Check for Updates…', 'updates', 'updates'),
        command('About', 'about', 'about'),
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

const applyMenu = (opts) => Menu.setApplicationMenu(buildMenu(opts));

module.exports = { buildMenu, applyMenu, short };
