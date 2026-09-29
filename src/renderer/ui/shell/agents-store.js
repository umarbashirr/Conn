/* A chat's subagents, for the views that are not the chat: the sheet that
   opens over it and the Agents tab beside it.

   A subagent's work used to be drawn inside the chat, under its row, and three
   running at once buried the conversation in three growing logs. The chat now
   keeps one line per agent, and its transcript opens in a sheet over the chat
   or in the Agents tab.

   The chat owns the state: useAgent builds the agent rows and loads a replayed
   one's transcript. So the chat publishes what it has here on every render,
   and the views read it back. The store adds two things of its own: which
   agent the tab is showing, and which one the sheet has open.

   Same shape as the other stores here: a version counter for
   useSyncExternalStore, and changed() to bump it. */
'use strict';
import { subagentsIn } from '../lib/subagents.js';

let agent = null; // the active chat's useAgent() value
let chat = null;
let selected = null; // an agent row's id
let sheet = null; // { id, full }

const listeners = new Set();
let version = 0;

export const getAgentsVersion = () => version;
// The chat publishes on every render, so it reads the sheet alone: a snapshot
// that moves with the version would render it again, forever.
export const getSheet = () => sheet;

export function subscribeAgents(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function changed() {
  version += 1;
  for (const fn of listeners) fn();
}

export function publish(next) {
  if (next === agent) return;
  // Another chat's agents are not this one's. The selection and the sheet go with it.
  if (next.activeKey !== chat) {
    chat = next.activeKey;
    selected = null;
    sheet = null;
  }
  agent = next;
  changed();
}

export const agentsState = () => ({
  agent,
  agents: agent ? subagentsIn(agent.items) : [],
  selected,
  sheet,
});

export function selectAgent(id) {
  if (selected === id) return;
  selected = id;
  changed();
}

// A row, a panel entry, or an agent nested in another's stream was clicked.
export function openSheet(id) {
  sheet = { id, full: sheet?.full || false };
  changed();
}

export function toggleSheetFull() {
  if (!sheet) return;
  sheet = { ...sheet, full: !sheet.full };
  changed();
}

export function closeSheet() {
  if (!sheet) return;
  sheet = null;
  changed();
}
