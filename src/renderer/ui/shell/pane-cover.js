/* The preview is a native view the window paints on top of this document, so a
   popup landing over it opens somewhere nobody can see.

   Parking the pane the way a modal does would resize the page, and picking a
   viewport while the page jumps to another width is no good. So freeze it
   instead: photograph the page, hang the picture where the view was, and hide
   the view until the popup closes. The bounds never change, so nothing reflows
   and the page comes back on exactly the frame it left. */
'use strict';
import { frameBox, guestWanted, onScreen, parseViewport, previewOf } from './browser-store.js';

let still = null;
// A cover is in flight. Another popup opening in that window must not start a
// second capture, and a mutation while we wait must not cancel the one we have.
let pending = false;

export const isPaneCovered = () => !!still;

// A photograph takes a round trip to the main process, and the popup that asked
// for it may be gone by the time it lands. Every uncover retires whatever is in
// flight.
let token = 0;

export function uncoverPane() {
  token += 1;
  pending = false;
  if (!still) return;
  const going = still;
  still = null;
  // Only bring the guest back when the Stage is showing a live page. Empty and
  // error states own the hole, and uncovering a menu must not put about:blank
  // on top of them again.
  window.conn.browser.setVisible(guestWanted());
  requestAnimationFrame(() => going.remove());
}

/* The photograph, taken early.

   Covering the pane costs a round trip to main and a capture at the end of it,
   and asking for that only once the menu is already open leaves the page live
   under a menu nobody can see, then swaps it for a still a tenth of a second
   later. Warming on the way down to the click, from pointerdown, means the
   picture is usually in hand by the time the menu is up.

   The offer is good for a second. A page that has moved on since is a page the
   still would misrepresent, and taking another one costs what it always cost. */
let warm = null;

export function warmPane() {
  // A click that is not going to open anything still asks. Reusing the shot
  // from the last moment keeps a busy click from taking a picture every time.
  if (warm && warm.mine === token && performance.now() - warm.at < 700) return;
  const mine = token;
  const at = performance.now();
  const shot = window.conn.browser.action('still').catch(() => null);
  warm = { at, mine, shot };
}

/* `since` is the token as it stood before this cover claimed one, which is what
   the warm shot was taken under. Comparing against the current token instead
   would never match, and the prefetch would be thrown away every time. */
async function lastStill(since) {
  if (warm && warm.mine === since && performance.now() - warm.at < 1000) {
    const url = await warm.shot;
    warm = null;
    if (url) return url;
  }
  warm = null;

  // The first capture after a page paints can come back empty, and hiding the
  // view behind a picture of nothing is the blank the cover exists to avoid.
  // One more ask costs a round trip in the case that was going to look broken.
  const url = await window.conn.browser.action('still').catch(() => null);
  return url || window.conn.browser.action('still').catch(() => null);
}

// `rect` is where the popup ended up. Anything clear of the pane needs no cover,
// which is most of them: walking the menu bar carries a menu off the pane and
// back on again.
export async function coverPane(rect) {
  const slot = document.querySelector('#paneslot');
  if (!slot || !rect) return uncoverPane();

  const r = slot.getBoundingClientRect();
  const clear = !r.width || !r.height
    || rect.right < r.left || rect.left > r.right
    || rect.bottom < r.top || rect.top > r.bottom;
  if (clear) return uncoverPane();
  if (still || pending) return;

  pending = true;
  const since = token;
  const mine = ++token;
  try {
    const url = await lastStill(since);
    if (mine !== token || still) return;

    const img = document.createElement('img');
    img.className = 'pane-still';
    // A page in responsive mode sits in a frame inside the slot, and the picture
    // has to hang on the frame or the page jumps when the menu opens.
    const page = previewOf(onScreen());
    const dims = page.live && !page.error ? parseViewport(page.viewport) : null;
    if (dims) {
      const f = frameBox(r, dims, page.hold);
      Object.assign(img.style, { left: `${f.x}px`, top: `${f.y}px`, width: `${f.width}px`, height: `${f.height}px` });
    }
    if (url) {
      img.src = url;
      // A picture that is in the document but has not decoded yet paints as
      // nothing, and the view underneath is already gone by then. Wait for the
      // pixels, then swap: one frame has the page, the next has the photograph,
      // and no frame has neither.
      try { await img.decode(); } catch { /* a picture that will not decode is still better than a hole */ }
      if (mine !== token || still) return;
    }

    still = img;
    slot.appendChild(img);
    window.conn.browser.setVisible(false);
  } finally {
    if (mine === token) pending = false;
  }
}

/* Popovers, dialogs, and menus all portal into this document, and the preview
   is a native view above every one of them. Anything that lands on the pane
   freezes it; anything clear of the pane leaves it alone. One watch covers
   every layer, so a new dialog does not have to remember to ask. */
const LAYERS = [
  'popover-content',
  'dialog-overlay',
  'dialog-content',
  'dropdown-menu-content',
  'dropdown-menu-sub-content',
  'select-content',
  'context-menu-content',
  'menubar-content',
  'menubar-sub-content',
  'sheet-overlay',
  'sheet-content',
].map((slot) => `[data-slot="${slot}"]`)
  // Streamdown's fullscreen table and diagram portal a window-sized layer onto
  // the body with no slot, and the diagram's carries no attribute at all.
  .concat('body > .fixed.inset-0')
  .join(',');

const TRIGGERS = [
  'popover-trigger',
  'dialog-trigger',
  'dropdown-menu-trigger',
  'select-trigger',
  'context-menu-trigger',
  'menubar-trigger',
  'sheet-trigger',
].map((slot) => `[data-slot="${slot}"]`).join(',');

function layerOverPane() {
  const slot = document.querySelector('#paneslot');
  if (!slot) return null;
  const pane = slot.getBoundingClientRect();
  if (!pane.width || !pane.height) return null;
  for (const el of document.querySelectorAll(LAYERS)) {
    if (el.getAttribute('data-state') === 'closed') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;
    const clear = rect.right < pane.left || rect.left > pane.right
      || rect.bottom < pane.top || rect.top > pane.bottom;
    if (!clear) return rect;
  }
  return null;
}

let frame = 0;
let hold = 0;

// Closing one layer and opening the next (a menu item that opens a dialog)
// happens on adjacent frames. Uncovering on the empty frame between them
// flashes the live page, so a miss waits one frame before it lets go.
export function syncPaneCover() {
  const hit = layerOverPane();
  if (hit) {
    if (hold) { cancelAnimationFrame(hold); hold = 0; }
    coverPane(hit);
    return;
  }
  if (!still && !pending) return;
  if (hold) return;
  hold = requestAnimationFrame(() => {
    hold = 0;
    const next = layerOverPane();
    if (next) coverPane(next);
    else uncoverPane();
  });
}

let watching = false;

export function watchPaneOverlays() {
  if (watching) return () => {};
  watching = true;
  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      syncPaneCover();
    });
  };
  const obs = new MutationObserver(schedule);
  obs.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-state', 'style'],
  });
  // The still is usually ready by the time the layer paints, instead of the
  // page staying live under a dialog for the length of a capture.
  // Triggers warm on the way down, which is how a menu has its picture before
  // it paints. Dialogs opened from a plain button (Usage, Search) have no
  // trigger slot, so any button or menu item does the same when the pane is up.
  const onPointerDown = (e) => {
    const t = e.target;
    if (!(t instanceof Element) || t.closest('#paneslot')) return;
    const slot = document.querySelector('#paneslot');
    if (!slot || slot.getBoundingClientRect().width < 1) return;
    if (t.closest(`${TRIGGERS}, button, [role="button"], [role="menuitem"]`)) warmPane();
  };
  document.addEventListener('pointerdown', onPointerDown, true);
  return () => {
    obs.disconnect();
    document.removeEventListener('pointerdown', onPointerDown, true);
    if (frame) cancelAnimationFrame(frame);
    if (hold) cancelAnimationFrame(hold);
    frame = 0;
    hold = 0;
    watching = false;
  };
}
