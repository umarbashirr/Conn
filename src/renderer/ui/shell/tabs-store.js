/* The tabs in the right column.

   The column used to hold one view at a time, chosen by three toolbar buttons.
   It holds two strips of tabs now, one above the other. The top slot is for
   pages, a preview or the canvas, and the bottom slot is for the tools that
   go with a page: a terminal, the file tree, the diff, the agents and the
   console. Each slot has its own active tab and its own answer to whether it
   is up, so a terminal can run under the page it is building. A panel can
   have as many previews and shells as it has things to run, and one of
   everything else, because a second would only draw the same thing twice.

   A panel belongs to a chat in a folder. Two chats in one project are two
   pieces of work, and a preview opened for one of them showing up beside the
   other is a page nobody asked for there. So each chat gets its own strips,
   and its own answer to whether either slot is up, and switching chats or
   folders swaps the lot. What you left is there when you come back.

   Callers still name a folder. The chat is the one that folder is showing,
   which for the folder in front is the chat on screen and for the others is
   the chat they last showed.

   Same shape as the other stores here: a mutable map, a version counter for
   useSyncExternalStore, and changed() to bump it. */
'use strict';
import { layout, OPEN_KEY, setLayout, subscribe as subscribeLayout } from './layout-store.js';

export const SLOTS = ['top', 'bottom'];
export const KINDS = ['browser', 'canvas', 'terminal', 'files', 'changes', 'agents', 'console'];

export const SLOT_OF = {
  browser: 'top', canvas: 'top',
  terminal: 'bottom', files: 'bottom', changes: 'bottom', agents: 'bottom', console: 'bottom',
};

// One tree, one diff, one agents list, one canvas and one console per panel,
// so opening any of them twice lands you back on the one you have. Previews
// and terminals are the exception: two dev servers, or a build beside a shell,
// is the reason this strip exists at all.
const SINGLE = new Set(['files', 'changes', 'agents', 'canvas', 'console']);

// dir -> { chat, panels: Map(chat -> panel) }
// panel = { tabs: [{ id, kind, title }], slots: { top: { activeId, open }, bottom: { activeId, open } }, full }
const folders = new Map();
const front = { dir: '', chat: '' };

const listeners = new Set();
let version = 0;

export const getTabsVersion = () => version;

export function subscribeTabs(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function changed() {
  version += 1;
  for (const fn of listeners) fn();
}

/* Ids are minted once per window and never reused, because main keys a native
   preview off them and a recycled id would hand a new tab the last one's page.
   Main mints them too, when an agent asks for a preview in a chat that has no
   tab open for one, so the prefix says who made it and the two can never
   collide. */
let seq = 0;
const mintId = (kind) => `${kind[0]}r${++seq}`;

const chatIn = (dir) => (dir === front.dir ? front.chat : folders.get(dir)?.chat ?? '');

const panelOf = (dir, chat = chatIn(dir)) => folders.get(dir)?.panels.get(chat) || null;

function panelFor(dir, chat = chatIn(dir)) {
  let folder = folders.get(dir);
  if (!folder) {
    folder = { chat, panels: new Map() };
    folders.set(dir, folder);
  }
  let panel = folder.panels.get(chat);
  if (!panel) {
    panel = { tabs: [], slots: Object.fromEntries(SLOTS.map((slot) => [slot, { activeId: null, open: false }])), full: false };
    folder.panels.set(chat, panel);
  }
  return panel;
}

const isFront = (panel) => panel === panelOf(front.dir);

// The layout says which slots are up, and it says it for the panel in front.
// A panel behind keeps its own answer until it comes forward.
function setOpen(panel, slot, open) {
  panel.slots[slot].open = open;
  if (isFront(panel)) setLayout({ [OPEN_KEY[slot]]: open });
}

/* Whatever turns a slot on or off, from a keyboard chord to a drag that
   collapsed it to Customize taking the window, goes through the layout store.
   Writing it down here as it happens is what lets a chat come back to the
   column it left, and telling this store's readers is what lets them ask
   shownIn alone whether their tab is on screen. */
subscribeLayout(() => {
  const panel = panelOf(front.dir) || (layout.rightOpen ? panelFor(front.dir) : null);
  if (!panel) return;
  panel.full = layout.previewFull;
  const moved = SLOTS.filter((slot) => panel.slots[slot].open !== layout[OPEN_KEY[slot]]);
  for (const slot of moved) panel.slots[slot].open = layout[OPEN_KEY[slot]];
  if (moved.length) changed();
});

/* The chat on screen and the folder with focus. `remember` is whether this is
   the chat that folder should go back to showing: a chat that belongs to
   another folder is on screen for a moment while focus follows it, and that
   moment should not be what this folder remembers. */
export function showPanel(dir, chat, { remember = true } = {}) {
  const same = front.dir === dir && front.chat === chat;
  front.dir = dir;
  front.chat = chat;
  if (remember && folders.has(dir)) folders.get(dir).chat = chat;
  if (same) return;
  const panel = panelOf(dir);
  setLayout({ topOpen: !!panel?.slots.top.open, bottomOpen: !!panel?.slots.bottom.open, previewFull: !!panel?.full });
  changed();
}

// The panel in front, as a key that moves only when showPanel moves it. The
// rail can name the next chat a moment before that.
export const frontKey = () => `${front.dir}\n${front.chat}`;

// What the column is drawing. An empty list is a chat nobody has opened the
// column in yet, which is most chats most of the time.
export const tabsOf = (dir) => panelOf(dir)?.tabs || [];

export const tabsIn = (dir, slot) => tabsOf(dir).filter((t) => SLOT_OF[t.kind] === slot);

export function activeIn(dir, slot) {
  const panel = panelOf(dir);
  if (!panel) return null;
  const { activeId } = panel.slots[slot];
  return panel.tabs.find((t) => t.id === activeId) || null;
}

/* The tab a slot is drawing, which is its active tab only while the slot is up.
   Read off the panel's own flag rather than the layout's: for the panel in
   front the two agree at every read, and for a panel behind the panel's flag is
   the only right answer. */
export const shownIn = (dir, slot) => (panelOf(dir)?.slots[slot].open ? activeIn(dir, slot) : null);

/* Open a tab of this kind, or go to the one already there. `id` lets main name
   the tab it just made a preview for, so the pane and the tab agree on which
   one they are, and `chat` names the chat it made it for. Returns the tab
   either way, because most callers want to tell main about it.

   `reveal` is whether this tab is one somebody asked for. A person clicking
   Files wants its slot, so it comes up. An agent putting a page on screen in a
   folder nobody is looking at has not asked for anything of the sort, and
   opening the slot would show the focused folder's tab instead, which is a
   slot appearing for no reason with the wrong thing in it.

   `activate` is whether the tab becomes the one its slot is on. A subagent
   opening a tab for itself is filed behind the one the person has, unless the
   slot had nothing on at all. */
export function openTab(dir, kind, id = null, { reveal = true, chat = chatIn(dir), activate = true } = {}) {
  if (!KINDS.includes(kind)) return null;
  const panel = panelFor(dir, chat);
  const slot = SLOT_OF[kind];

  /* Two callers can name the same tab. Main mints the id for a preview it has
     already made, and more than one path in here answers that. An id already in
     the strip is the tab it names, not a second one to push beside it: closing
     goes by id and takes the first row it finds, so a pair sharing an id close
     each other. */
  const held = SINGLE.has(kind)
    ? panel.tabs.find((t) => t.kind === kind)
    : (id ? panel.tabs.find((t) => t.id === id) : null);
  const tab = held || { id: id || mintId(kind), kind, title: '' };
  if (!held) panel.tabs.push(tab);

  if (activate || !panel.slots[slot].activeId) panel.slots[slot].activeId = tab.id;
  if (reveal) setOpen(panel, slot, true);
  changed();
  return tab;
}

export function activateTab(dir, id) {
  const panel = panelOf(dir);
  const tab = panel?.tabs.find((t) => t.id === id);
  if (!tab) return;
  const slot = panel.slots[SLOT_OF[tab.kind]];
  if (slot.activeId === id) return;
  slot.activeId = id;
  changed();
}

/* An agent loaded a page in a preview. Whichever panel holds that tab goes to
   it and its slot comes up, so the chat the agent is working for shows the
   page when you are in it, now or when you get back to it. */
export function revealTab(id) {
  for (const folder of folders.values()) {
    for (const panel of folder.panels.values()) {
      const tab = panel.tabs.find((t) => t.id === id);
      if (!tab) continue;
      const slot = SLOT_OF[tab.kind];
      panel.slots[slot].activeId = id;
      setOpen(panel, slot, true);
      changed();
      return true;
    }
  }
  return false;
}

/* Closing one. The neighbour to the right in the same slot takes over, which is
   where your eye already is, and the slot puts itself away when its last tab
   goes rather than sitting there empty. The other slot is left where it was.
   The caller is told which tab left so it can tell main to drop the pane
   behind it. */
export function closeTab(dir, id) {
  const panel = panelOf(dir);
  return panel ? spliceTab(panel, id) : null;
}

/* Close by id wherever the tab is filed, for a tab an agent closed in a chat
   that may not be on screen. */
export function removeTab(id) {
  for (const folder of folders.values()) {
    for (const panel of folder.panels.values()) {
      if (panel.tabs.some((t) => t.id === id)) return spliceTab(panel, id);
    }
  }
  return null;
}

function spliceTab(panel, id) {
  const at = panel.tabs.findIndex((t) => t.id === id);
  if (at < 0) return null;

  const [gone] = panel.tabs.splice(at, 1);
  const slotName = SLOT_OF[gone.kind];
  const slot = panel.slots[slotName];
  if (slot.activeId === id) {
    const peers = panel.tabs.filter((t) => SLOT_OF[t.kind] === slotName);
    const after = panel.tabs.slice(at).find((t) => SLOT_OF[t.kind] === slotName);
    const next = after || peers[peers.length - 1] || null;
    slot.activeId = next?.id || null;
    if (!next && slot.open) setOpen(panel, slotName, false);
  }
  changed();
  return gone;
}

// Every tab this store holds, with the folder and chat it is filed under, or
// only one folder's. Shells and previews live on while their chat is not on
// screen, so what has to be kept alive is all of these, not the strip in view.
export function everyTab(only = null) {
  const out = [];
  for (const [dir, folder] of folders) {
    if (only !== null && dir !== only) continue;
    for (const [chat, panel] of folder.panels) {
      for (const tab of panel.tabs) out.push({ dir, chat, tab });
    }
  }
  return out;
}

const findTab = (id) => everyTab().find((e) => e.tab.id === id) || null;

// The chat a tab was opened for, which is what main files its page under.
export const chatOfTab = (id) => findTab(id)?.chat ?? null;

// A browser tab wears the page it is showing and a terminal its shell. A tree
// and a diff are named by their kind. The tab can be in a chat that is not on
// screen, still printing or still loading.
export function setTabTitle(dir, id, title) {
  const tab = findTab(id)?.tab;
  if (!tab || tab.title === title) return;
  tab.title = title || '';
  changed();
}

/* The folder is closing. Every chat's tabs in it go too, and the previews
   behind them are handed back so main can let those native views go. */
export function dropProject(dir) {
  const previews = everyTab(dir).filter((e) => e.tab.kind === 'browser').map((e) => e.tab.id);
  if (!folders.delete(dir)) return [];
  changed();
  return previews;
}

/* The chat is gone, deleted from the rail or dropped with its folder. Its
   panels go with it, and with them its shells and its previews. */
export function dropChat(chat) {
  let any = false;
  for (const folder of folders.values()) any = folder.panels.delete(chat) || any;
  if (any) changed();
}

export const previewTabs = (dir) => tabsOf(dir).filter((t) => t.kind === 'browser').map((t) => t.id);

// Every folder this store is holding tabs for, so a caller reconciling against
// main does not have to keep its own list of folders to ask about.
export const projectDirs = () => [...folders.keys()];
