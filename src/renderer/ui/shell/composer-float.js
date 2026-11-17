/* The chat box floating over the page at full width.

   The page is a native view drawn above this document, so a box laid over it
   here would be hidden. The box goes in a window the shell opens on itself
   instead, which main hosts in a see-through view stacked above the page. The
   window is same-origin and in this process, so the chat portals its one
   composer into that window's document: the draft, the menus and the turn stay
   the chat's own state.

   A view takes every click inside its rectangle, so this keeps it the size of
   the box and the page around it stays live. A menu or a list opening out of
   the box needs room the box does not have, and for as long as one is up the
   view grows to the column above the box, transparent: a click there closes
   the menu, as a click outside any open menu does. */
import { createContext, useEffect, useState } from 'react';
import { zoomLevel } from '../../app.js';

export const ComposerFloat = createContext(null);

const NAME = 'conn-composer';
// Between the box and the bottom of the page, between the box and the sides,
// and the widest it gets: about the composer's width in the chat.
const GAP = 16;
const SIDE = 16;
const MAX_WIDTH = 720;
// Room around the box for its shadow. The view covers it, so it is kept small.
const MARGIN = 6;

const OWN_STYLE = `
  html, body { margin: 0; height: 100%; overflow: hidden; background: transparent !important; }
  body { display: block !important; }
  #composer-float { position: fixed; inset-inline: 0; bottom: ${MARGIN}px; margin-inline: auto; }
`;

/* The composer's code runs here and its nodes live there, and a few of this
   window's globals then answer for the wrong document. Radix moves focus
   through its menus by reading document.activeElement, and tells a click
   outside a menu by `instanceof Node`, which a node from the other window
   fails. While the box is over there, both answer for either document. */
function bridgeRealms(other) {
  const ownActive = Object.getOwnPropertyDescriptor(Document.prototype, 'activeElement').get;
  Object.defineProperty(document, 'activeElement', {
    configurable: true,
    get: () => (other.document.hasFocus() ? other.document.activeElement : ownActive.call(document)),
  });
  const isA = Function.prototype[Symbol.hasInstance];
  // On Node, so every DOM interface below it inherits it, each checking its own
  // counterpart over there: HTMLInputElement against HTMLInputElement.
  Object.defineProperty(Node, Symbol.hasInstance, {
    configurable: true,
    value(v) {
      if (isA.call(this, v)) return true;
      const twin = other[this.name];
      return typeof twin === 'function' && twin !== this && isA.call(twin, v);
    },
  });
  return () => {
    delete document.activeElement;
    delete Node[Symbol.hasInstance];
  };
}

// The page's own box, or the column when the tab is not a page.
function anchor() {
  const slot = document.querySelector('#paneslot')?.getBoundingClientRect();
  if (slot && slot.width > 0 && slot.height > 0) return slot;
  return document.querySelector('section#right')?.getBoundingClientRect() ?? null;
}

// A dialog of the shell's own is modal over everything, the box included.
const SHELL_MODAL = '[data-slot="dialog-overlay"], [data-slot="sheet-overlay"], [data-slot="alert-dialog-overlay"]';

// Anything open out of the box: a menu or dialog portaled onto the body, or
// the @ and / list hanging above the input.
const layerUp = (doc, root) => [...doc.body.children].some((el) => el !== root)
  || !!doc.getElementById('composer-mentions');

// Each float gets a name of its own. The last one may still be on its way out,
// and opening a name that is still taken hands back that window.
let opened = 0;

function openFloat() {
  const name = `${NAME}-${++opened}`;
  const win = window.open('', name);
  if (!win) return null;
  const doc = win.document;
  doc.title = 'Conn composer';

  // The same stylesheets, so the box looks the way it does in the chat. It
  // stays hidden until they have loaded, or its first frame is unstyled.
  const sheets = [];
  for (const el of document.head.querySelectorAll('link[rel="stylesheet"], style')) {
    const copy = el.tagName === 'LINK'
      ? Object.assign(doc.createElement('link'), { rel: 'stylesheet', href: el.href })
      : Object.assign(doc.createElement('style'), { textContent: el.textContent });
    if (copy.tagName === 'LINK') sheets.push(new Promise((done) => { copy.onload = done; copy.onerror = done; }));
    doc.head.append(copy);
  }
  doc.head.append(Object.assign(doc.createElement('style'), { textContent: OWN_STYLE }));

  // Theme, scheme and chat text size all live on <html>.
  const html = doc.documentElement;
  const mirror = () => {
    for (const { name } of [...html.attributes]) if (!document.documentElement.hasAttribute(name)) html.removeAttribute(name);
    for (const { name, value } of document.documentElement.attributes) html.setAttribute(name, value);
  };
  mirror();
  const themes = new MutationObserver(mirror);
  themes.observe(document.documentElement, { attributes: true });

  const root = doc.createElement('div');
  root.id = 'composer-float';
  doc.body.append(root);

  const unbridge = bridgeRealms(win);

  let ready = false;
  let frame = 0;
  let last = '';
  const place = () => {
    frame = 0;
    const a = anchor();
    const hidden = !ready || !a || a.width < 1 || !!document.querySelector(SHELL_MODAL);
    let box = null;
    if (!hidden) {
      const width = Math.max(0, Math.min(MAX_WIDTH, a.width - 2 * SIDE));
      root.style.width = `${width}px`;
      const height = root.offsetHeight;
      const bottom = a.bottom - GAP;
      box = layerUp(doc, root)
        ? { x: a.left, y: a.top, width: a.width, height: bottom + MARGIN - a.top }
        : { x: a.left + (a.width - width) / 2 - MARGIN, y: bottom - height - MARGIN, width: width + 2 * MARGIN, height: height + 2 * MARGIN };
      const z = zoomLevel();
      box = { x: box.x * z, y: box.y * z, width: box.width * z, height: box.height * z };
    }
    const next = JSON.stringify(box);
    if (next === last) return;
    last = next;
    window.conn.composer.float({ box, zoom: zoomLevel() });
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(place); };

  // An observer made here only hears about layout in this document, so the box
  // is watched by one made over there.
  const grows = new win.ResizeObserver(schedule);
  grows.observe(root);
  const layers = new MutationObserver(schedule);
  layers.observe(doc.body, { childList: true, subtree: true });
  const column = new ResizeObserver(schedule);
  for (const el of [document.querySelector('#paneslot'), document.querySelector('section#right')]) if (el) column.observe(el);
  const modals = new MutationObserver(schedule);
  modals.observe(document.body, { childList: true });
  addEventListener('resize', schedule);
  Promise.all(sheets).then(() => { ready = true; schedule(); });

  return {
    root,
    close: () => {
      cancelAnimationFrame(frame);
      for (const o of [themes, grows, layers, column, modals]) o.disconnect();
      removeEventListener('resize', schedule);
      unbridge();
      // Main takes the view out of the window before closing it. A close from
      // here would pull the contents out from under the view.
      window.conn.composer.close(name);
    },
  };
}

// Focus on a node in the other window leaves the keyboard where it was. Main
// moves it into the box's view.
export const focusFloat = () => window.conn.composer.focus();

// The element to portal the composer into while `on`, or null.
export function useComposerFloat(on) {
  const [root, setRoot] = useState(null);
  useEffect(() => {
    if (!on) return undefined;
    const float = openFloat();
    if (!float) return undefined;
    setRoot(float.root);
    return () => {
      setRoot(null);
      float.close();
    };
  }, [on]);
  return on ? root : null;
}
