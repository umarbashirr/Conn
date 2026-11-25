/* Which preview pages you have taken off the agents, so the chat whose
   agent stopped for you knows to offer them back. (The page offers it too,
   with a pill main floats over it, and the title bar has its chip.)

   Main says who holds a page whenever that changes ('preview:driver'). A
   page is held by you from Take control until Hand back.

   Same shape as the other stores here: a version counter for
   useSyncExternalStore, and changed() to bump it. */
'use strict';

const held = new Set(); // tab ids you hold
const listeners = new Set();
let version = 0;

export const getControlVersion = () => version;
export const heldTabs = () => [...held];

export function subscribeControl(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function changed() {
  version += 1;
  for (const fn of listeners) fn();
}

function apply(msg) {
  const tab = msg?.tab;
  if (!tab) return;
  const yours = msg.holder?.id === 'human';
  if (yours === held.has(tab)) return;
  if (yours) held.add(tab);
  else held.delete(tab);
  changed();
}

// Gives one page back, or every page you hold. The agents can use it again
// straight away; main tells everyone so the controls go.
export async function handBack(tab) {
  const tabs = tab ? [tab] : heldTabs();
  await Promise.all(tabs.map((t) => window.conn.browser.handBack(t).catch(() => {})));
  for (const t of tabs) held.delete(t);
  changed();
}

if (typeof window !== 'undefined' && window.conn?.browser?.onDriver) {
  window.conn.browser.onDriver(apply);
}
