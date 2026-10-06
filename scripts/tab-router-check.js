'use strict';
/* The tab-routing rule, driven under plain node with a stand-in for the
   window's panes. This is the half the ACP mock cannot reach end to end: a
   Claude subagent is a background actor, and the rule that gives it a tab of
   its own on its first navigate only runs inside a real Claude turn. */
const assert = require('assert');
const { createTabRouter, keyOf } = require('../src/main/tab-router');

function fakePanes() {
  const tabs = new Map(); // tab -> chat
  const made = [];        // every newTab call, with how it was asked for
  let seq = 0;
  let shown = null;
  const mint = (chat, activate) => {
    const tab = `t${++seq}`;
    tabs.set(tab, chat);
    made.push({ tab, chat, activate });
    return tab;
  };
  return {
    made,
    show: (tab) => { shown = tab; },
    drop: (tab) => tabs.delete(tab),
    has: (tab) => tabs.has(tab),
    ofChat: (chat) => [...tabs].filter(([, c]) => c === chat).map(([t]) => t),
    defaultTab: (cwd, chat) => (shown && tabs.get(shown) === chat ? shown : [...tabs].find(([, c]) => c === chat)?.[0] || mint(chat, true)),
    newTab: (cwd, chat, { activate }) => mint(chat, activate),
  };
}

const main = { id: 'main:A', label: 'the main thread', chat: 'A' };
const researcher = { id: 'task9', label: 'research subagent', chat: 'A', background: true };
const reader = { id: 'task10', label: 'reading subagent', chat: 'A', background: true };
const other = { id: 'main:B', label: 'the main thread', chat: 'B' };

const panes = fakePanes();
const router = createTabRouter(panes);

const t1 = router.tabFor(main, 'navigate', '/p', { pageChange: true });
assert.strictEqual(router.current(main), t1, 'the main thread is pinned to the tab its navigate landed on');
assert.strictEqual(router.tabFor(main, 'snapshot', '/p', { pageChange: false }), t1, 'the main thread reads its own tab');
panes.show(t1);

const t2 = router.tabFor(researcher, 'navigate', '/p', { pageChange: true });
assert.notStrictEqual(t2, t1, 'a subagent\'s first navigate opens a tab of its own');
assert.deepStrictEqual(panes.made.at(-1), { tab: t2, chat: 'A', activate: false }, 'the subagent\'s tab is opened quietly');
assert.strictEqual(router.current(main), t1, 'the main thread\'s pin is untouched by the subagent');
assert.strictEqual(router.tabFor(researcher, 'click', '/p', { pageChange: true }), t2, 'the subagent keeps driving its own tab');

assert.strictEqual(router.tabFor(reader, 'snapshot', '/p', { pageChange: false }), t1, 'a subagent that only reads sees the chat\'s default tab');
assert.strictEqual(router.current(reader), null, 'a read pins nothing');
assert.strictEqual(panes.made.length, 2, 'a read opens no tab');

assert.throws(() => router.select(other, t1), /not a tab in this chat/, 'select refuses another chat\'s tab');
assert.strictEqual(router.select(main, t2), t2, 'select moves the driver');
assert.throws(() => router.closable(researcher, t2), /being driven by another agent \(the main thread\)/, 'close is refused while another actor drives the tab');
router.select(main, t1);
assert.strictEqual(router.closable(researcher), t2, 'an actor may close the tab only it drives');
assert.strictEqual(router.closable(researcher, null), t2, 'a null tab means the one the actor drives, as a raw bridge call may send it');
assert.throws(() => router.closable(reader), /not driving a tab/, 'an actor with no tab has nothing to close by default');
assert.throws(() => router.closable(main, 'nope'), /not a tab in this chat/, 'close refuses a tab outside the chat');
assert.deepStrictEqual(router.driverOf(t2), { key: keyOf(researcher), label: 'research subagent' }, 'driverOf names the pinned actor');
assert.strictEqual(router.driverOf('nope'), null, 'an undriven tab has no driver');

const t3 = router.open(main, '/p');
assert.deepStrictEqual(panes.made.at(-1), { tab: t3, chat: 'A', activate: true }, 'a foreground actor\'s new tab comes to the front');
assert.strictEqual(router.current(main), t3, 'tab_new pins the opener');
const t4 = router.open(researcher, '/p');
assert.deepStrictEqual(panes.made.at(-1), { tab: t4, chat: 'A', activate: false }, 'a subagent\'s new tab is filed quietly');

router.forgetActor(researcher);
assert.strictEqual(router.current(researcher), null, 'a finished subagent is unpinned');
assert.ok(panes.has(t4), 'its tab stays');

router.select(main, t1);
router.select(reader, t1);
panes.drop(t1);
router.forgetTab(t1);
assert.strictEqual(router.current(main), null, 'closing a tab unpins the main thread');
assert.strictEqual(router.current(reader), null, 'closing a tab unpins every actor on it');
assert.ok(panes.has(router.tabFor(main, 'navigate', '/p', { pageChange: true })), 'the next navigate lands on a live tab');

const t5 = router.open(main, '/p');
panes.drop(t5);
assert.notStrictEqual(router.tabFor(main, 'navigate', '/p', { pageChange: true }), t5, 'a pin on a tab that is gone is dropped on the next call');

router.forgetChat('A');
assert.strictEqual(router.current(main), null, 'forgetting a chat unpins its actors');

console.log('tab-router-check: all passed');
