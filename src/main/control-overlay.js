'use strict';
// A see-through view laid over a preview while an agent drives it. The page is
// a native view, so nothing the app shell draws can sit on top of it; this is a
// second native view stacked above it. Mouse and wheel input over the page lands
// here, so the person cannot scroll or click the page out from under the agent,
// while the agent's own input goes to the page's webContents directly and never
// passes through this. Screenshots and recordings read the page alone.
const path = require('path');
const { WebContentsView } = require('electron');

const DIR = path.join(__dirname, '..', 'overlay');

class ControlOverlay {
  constructor() {
    this.view = null;
    this.host = null;
    this.tab = null;
    this.caption = '';
  }

  #make() {
    this.view = new WebContentsView({
      webPreferences: { preload: path.join(DIR, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    this.view.setBackgroundColor('#00000000');
    const wc = this.view.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.on('did-finish-load', () => this.#tell());
    wc.loadFile(path.join(DIR, 'overlay.html'));
  }

  #tell() {
    if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.send('overlay:state', { caption: this.caption });
  }

  // Over `tab`, filling `bounds` of `host`. Re-stacked on top each time, because
  // a page moved between windows is added again and lands above everything.
  show(host, bounds, { tab, caption }) {
    if (!this.view) this.#make();
    if (this.host !== host) {
      try { this.host?.contentView.removeChildView(this.view); } catch { /* window already gone */ }
      this.host = host;
    }
    if (host.contentView.children.at(-1) !== this.view) host.contentView.addChildView(this.view);
    this.view.setBounds(bounds);
    this.view.setVisible(true);
    this.tab = tab;
    if (caption !== this.caption) {
      this.caption = caption;
      this.#tell();
    }
  }

  hide() {
    this.tab = null;
    this.view?.setVisible(false);
  }

  owns(wc) {
    return !!this.view && this.view.webContents === wc;
  }

  focus() {
    this.view?.webContents.focus();
  }

  dispose() {
    if (!this.view) return;
    try { this.host?.contentView.removeChildView(this.view); } catch { /* window already gone */ }
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close();
    this.view = null;
    this.host = null;
    this.tab = null;
  }
}

module.exports = { ControlOverlay };
