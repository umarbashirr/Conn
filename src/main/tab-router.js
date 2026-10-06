'use strict';
/* Which tab each agent drives.

   A browser tab is driven by an actor, not by a chat. A chat's main thread,
   each of its subagents and a terminal caller matched to it are separate
   actors, and each keeps the tab its first page change landed on. That is what
   keeps a subagent researching the web from replacing the page the main thread
   or the human has open in the same chat.

   The rule lives here with the window's panes injected, so it reads in one
   screen and runs under plain node. */

/**
 * @typedef {{ id: string, label: string, chat: string, background?: boolean }} Actor
 *   id is unique within the window: 'main:<chat>' for a chat's main thread, the SDK task id
 *   for a Claude subagent, 'bridge' for a terminal caller. background is true for a subagent.
 * @typedef {{
 *   has(tab: string): boolean,
 *   ofChat(chat: string): string[],
 *   defaultTab(cwd: string, chat: string): string,
 *   newTab(cwd: string, chat: string, opts: { activate: boolean }): string,
 * }} Panes
 *   defaultTab is the window's own rule for a chat: the tab on screen when it is this chat's,
 *   else the chat's first, else a new one.
 */

const keyOf = (actor) => `${actor.chat}/${actor.id}`;

function createTabRouter(panes) {
  // actor key -> { tab, label }. The label is what browser_tabs shows the others.
  const driving = new Map();

  const pin = (actor, tab) => { driving.set(keyOf(actor), { tab, label: actor.label }); return tab; };
  const current = (actor) => driving.get(keyOf(actor))?.tab || null;

  /**
   * The tab this tool call acts on. In order:
   *  1. the actor's pinned tab, if it still exists;
   *  2. a background actor's first navigate opens a tab of its own, quietly;
   *  3. otherwise the chat's default tab.
   * Page-changing tools pin the actor to the tab they land on. Reads pin
   * nothing, so a subagent that only looks sees what the chat sees.
   */
  function tabFor(actor, tool, cwd, { pageChange }) {
    const key = keyOf(actor);
    const held = driving.get(key)?.tab;
    if (held && panes.has(held)) return held;
    if (held) driving.delete(key);
    const tab = actor.background && tool === 'navigate'
      ? panes.newTab(cwd, actor.chat, { activate: false })
      : panes.defaultTab(cwd, actor.chat);
    return pageChange ? pin(actor, tab) : tab;
  }

  // browser_tab_new. A foreground actor's new tab comes to the front of its
  // strip; a subagent's waits behind the one the person has.
  function open(actor, cwd) {
    return pin(actor, panes.newTab(cwd, actor.chat, { activate: !actor.background }));
  }

  // browser_tab_select. Only a tab of the actor's own chat.
  function select(actor, tab) {
    if (!panes.ofChat(actor.chat).includes(tab)) throw new Error(`${tab} is not a tab in this chat`);
    return pin(actor, tab);
  }

  // browser_tab_close. The actor's own tab by default. Refused while another
  // actor is driving it, whoever that is.
  function closable(actor, want) {
    const tab = want || current(actor);
    if (!tab) throw new Error('you are not driving a tab');
    if (!panes.ofChat(actor.chat).includes(tab)) throw new Error(`${tab} is not a tab in this chat`);
    for (const [key, d] of driving) {
      if (d.tab === tab && key !== keyOf(actor)) throw new Error(`${tab} is being driven by another agent (${d.label})`);
    }
    return tab;
  }

  // Who drives a tab, for browser_tabs: an actor pinned to it, or null.
  function driverOf(tab) {
    for (const [key, d] of driving) if (d.tab === tab) return { key, label: d.label };
    return null;
  }

  // The tab is gone, however it went: everyone pinned to it is unpinned.
  function forgetTab(tab) { for (const [key, d] of driving) if (d.tab === tab) driving.delete(key); }
  // The actor is gone (a subagent finished, a chat was forgotten). The tab stays.
  function forgetActor(actor) { driving.delete(keyOf(actor)); }
  function forgetChat(chat) { for (const key of driving.keys()) if (key.startsWith(`${chat}/`)) driving.delete(key); }

  return { tabFor, open, select, closable, driverOf, current, forgetTab, forgetActor, forgetChat };
}

module.exports = { createTabRouter, keyOf };
