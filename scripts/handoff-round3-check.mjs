/* Round three of the switch fixes, in plain node: the stitched-read cache,
   the window relay's timeout and reload, where a stretch starts after a
   resume comes back on a new session, and a handed-over call carried on a
   second time. A FAIL is a bug report, kept failing on purpose. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createStitchCache } = require('../src/main/stitch-cache.js');
const { createRelay } = require('../src/main/window-relay.js');
const { cutFor, withSession, switchChat } = require('../src/shared/chat-segments.js');
const { buildHandoff, unwrapHandoff, wrapMessage, itemsFromEntries, entriesOf } = require('../src/shared/handoff.js');
const { deleteNote } = require('../src/shared/delete-note.js');

const failures = [];
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`); } catch (e) { failures.push(name); console.log(`FAIL ${name}: ${e.message.split('\n')[0]}`); }
};

await check('cache: a changed stamp reads again, an unchanged one does not, no stamp is never kept', async () => {
  let reads = 0;
  let stamp = { a: 's1', b: 's1' };
  const get = createStitchCache({ read: async () => { reads += 1; return [reads]; }, stampOf: (_d, s) => stamp[s] });
  const segs = [{ session: 'a', provider: 'claude' }, { session: 'b', provider: 'codex' }];
  assert.deepEqual(await get('/p', segs), [1]);
  assert.deepEqual(await get('/p', segs), [1]);
  stamp = { a: 's1', b: 's2' };
  assert.deepEqual(await get('/p', segs), [2]);
  stamp = { a: 's1', b: null };
  assert.deepEqual(await get('/p', segs), [3]);
  assert.deepEqual(await get('/p', segs), [4]);
});

await check('relay: the window\'s answer settles it; silence times out; a reload fails what is waiting', async () => {
  const timers = [];
  const sent = [];
  const relay = createRelay({ send: (p) => { sent.push(p); return true; }, timeoutMs: 8000, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {} });
  const a = relay.forward({ chat: 'k', text: 'hi' });
  relay.settle(sent[0].id, { ok: true });
  assert.deepEqual(await a, { ok: true });
  const b = relay.forward({ chat: 'k', text: 'two' });
  timers.at(-1).fn();
  assert.match((await b).error, /did not take/);
  const c = relay.forward({ chat: 'k', text: 'three' });
  relay.failAll('reloaded');
  assert.equal((await c).error, 'reloaded');
  const none = createRelay({ send: () => false, setTimer: () => 0, clearTimer: () => {} });
  assert.match((await none.forward({ chat: 'k' })).error, /no window/);
});

await check('cut: counted from the stretch\'s own session\'s handoff rows, fork included', () => {
  const H = (id, extra = {}) => ({ id, kind: 'handoff', ...extra });
  const U = (id) => ({ id, kind: 'user' });
  // A fork F (its own handoff row first) -> B -> back to F.
  const items = [{ id: 'c1', kind: 'user', carried: true }, H('x0', { fork: true }), U('u1'), H('x2'), U('u2'), H('x3')];
  const segs = [{ session: 'F', from: 0 }, { session: 'B', from: 3 }, { session: 'F', from: 5 }];
  assert.equal(cutFor(items, segs), 1);
});

// A fork made from a chat that had itself changed agent copies that chat's
// handoff rows into its first stretch. They are not in the fork's own
// transcript, which holds only its own handoff and the ones sent into it.
await check('cut: a live fork of a switched chat, switched away and back, starts at its own transcript\'s handoff', () => {
  const H = (id, extra = {}) => ({ id, kind: 'handoff', ...extra });
  const U = (id) => ({ id, kind: 'user' });
  const items = [U('h0'), H('s1:h0:handoff'), U('s1:h0'), H('h2:handoff'), U('h2'), H('hF', { fork: true }), U('u1'), H('hB'), U('u2'), H('hC')];
  const segs = [{ session: 'F', from: 0 }, { session: 'B', from: 7 }, { session: 'F', from: 9 }];
  assert.equal(cutFor(items, segs), 1, `counted ${cutFor(items, segs)}: the copied rows are counted as the fork's own`);
});

await check('cut: a resume that comes back on a new session starts that session at 0', () => {
  const c = { provider: 'claude', session: 'A-old', segments: [{ provider: 'codex', session: 'B', from: 0 }, { provider: 'claude', session: 'A-old', from: 3, cut: 2 }], items: [] };
  const moved = withSession(c, 'A-new', 'claude');
  assert.deepEqual(moved.segments.at(-1), { provider: 'claude', session: 'A-new', from: 3, cut: 0 });
  const same = withSession(c, 'A-old', 'claude');
  assert.equal(same.segments.at(-1).cut, 2);
});

await check('handed over: a running call carried into a fork draws as handed over', () => {
  const h = buildHandoff({ items: [{ id: 't', kind: 'tool', name: 'Bash', input: { command: 'make' }, state: 'input-available' }], from: 'claude', to: 'codex', window: 200000, fork: true });
  const [item] = itemsFromEntries(unwrapHandoff(wrapMessage(h.text, 'x')).entries(), 'p:');
  assert.equal(item.state, 'handed-over');
});

await check('handed over: carried on again, it still reads as running, not done', () => {
  const [e] = entriesOf([{ id: 't', kind: 'tool', name: 'Bash', input: { command: 'make' }, state: 'handed-over' }]);
  assert.equal(e.status, 'running', `a handed-over call goes to the next agent as "${e.status}"`);
});

await check('toast: every part kept, some kept, none kept', () => {
  assert.equal(deleteNote({ left: [], deleted: ['claude'] }), null);
  assert.equal(deleteNote({ left: [{ provider: 'copilot' }], deleted: [] }).title, 'Removed from Conn.');
  const some = deleteNote({ left: [{ provider: 'copilot' }], deleted: ['claude'] });
  assert.equal(some.title, 'Deleted the Claude part.');
  assert.match(some.description, /^Copilot kept its part on disk\./);
});

console.log(failures.length ? `\n${failures.length} failed: ${failures.join(', ')}` : '\nall passed');
process.exit(failures.length ? 1 : 0);
