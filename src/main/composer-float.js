'use strict';
// The chat box floating over a full-width page. The page is a native view, so
// nothing the shell's document draws can sit on top of it; this is a second
// native view stacked above it, like the control overlay. A view takes every
// click inside its rectangle, so the shell keeps this one the size of the box
// itself, and the page beside it stays live.
//
// What it shows is a window the shell opened on itself (window.open, same
// origin, same process), and the shell renders its one composer into that
// window's document. So this view holds no state of its own: the draft, the
// menus and the turn are the shell's, wherever the box is drawn.
const { WebContentsView } = require('electron');

// What the frame name the shell opens it under starts with, so no other
// window.open gets a view. Each float adds a number of its own.
const FLOAT_NAME = 'conn-composer';

class ComposerFloat {
  constructor() {
    this.view = null;
    this.host = null;
    this.name = null;
  }

  // Called from the shell's window open handler, with the web contents
  // Chromium has already made for the new window.
  adopt(host, webContents, name) {
    this.dispose();
    this.host = host;
    this.name = name;
    this.view = new WebContentsView({ webContents });
    this.view.setBackgroundColor('#00000000');
    this.view.setVisible(false);
    webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    webContents.on('will-navigate', (e) => e.preventDefault());
    // A window that dies on its own takes its view with it, and there is
    // nothing left to remove.
    const view = this.view;
    webContents.once('destroyed', () => {
      if (this.view !== view) return;
      this.view = null;
      this.host = null;
    });
    host.contentView.addChildView(this.view);
    return webContents;
  }

  // `box` is in window pixels, or null to hide. `zoom` is the shell's, which
  // this window does not share on its own.
  place({ box, zoom } = {}) {
    if (!this.view) return;
    const wc = this.view.webContents;
    if (zoom > 0 && Math.abs(wc.getZoomFactor() - zoom) > 0.001) wc.setZoomFactor(zoom);
    if (!box) { this.view.setVisible(false); return; }
    this.view.setBounds({
      x: Math.round(box.x), y: Math.round(box.y),
      width: Math.max(0, Math.round(box.width)), height: Math.max(0, Math.round(box.height)),
    });
    this.view.setVisible(true);
    this.raise();
  }

  // Above every page and the control overlay. A page made or moved after this
  // view is added lands on top of it, so the shell's layout passes call this.
  raise() {
    const kids = this.host?.contentView.children;
    if (this.view && kids && kids.at(-1) !== this.view) this.host.contentView.addChildView(this.view);
  }

  // Focus on an element in another window's document does not move the
  // keyboard there. Only the view's own web contents can take it.
  focus() {
    if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.focus();
  }

  // Out of the window first, then closed. The shell asks for this rather than
  // closing its window itself: a close from the page destroys the contents
  // while the view still holds them, and that took the whole app down. A
  // `name` closes only that float, so a late ask cannot take a newer one.
  dispose(name) {
    const { view, host } = this;
    if (!view || (name && name !== this.name)) return;
    this.view = null;
    this.host = null;
    this.name = null;
    const wc = view.webContents;
    const typing = !wc.isDestroyed() && wc.isFocused();
    try { host?.contentView.removeChildView(view); } catch { /* window already gone */ }
    if (!wc.isDestroyed()) wc.close();
    // The box goes back into the chat, and the keys follow it there.
    if (typing && host && !host.isDestroyed()) host.webContents.focus();
  }
}

module.exports = { ComposerFloat, FLOAT_NAME };
