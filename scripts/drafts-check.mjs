/* Drafts kept across reloads, under plain node with a stand-in storage and timer. */
import assert from 'node:assert/strict';
import './renderer-esm.mjs';

const { createDrafts, ownedStorageKey, storageKeyOf, storageKeyOfRow } = await import('../src/renderer/ui/lib/drafts.js');

const KEY = 'conn.drafts';

function rig({ saved, broken = false } = {}) {
  const data = new Map(saved === undefined ? [] : [[KEY, typeof saved === 'string' ? saved : JSON.stringify(saved)]]);
  const writes = [];
  const storage = {
    getItem: (k) => {
      if (broken) throw new Error('storage is blocked');
      return data.get(k) ?? null;
    },
    setItem: (k, v) => {
      if (broken) throw new Error('quota exceeded');
      writes.push(v);
      data.set(k, v);
    },
  };
  const pending = new Map();
  let next = 0;
  const schedule = (fn, ms) => {
    pending.set(++next, { fn, ms });
    return next;
  };
  const cancel = (id) => pending.delete(id);
  const drafts = createDrafts({ storage: () => storage, schedule, cancel });
  return {
    drafts,
    writes,
    pending,
    stored: () => JSON.parse(data.get(KEY) ?? '{}'),
    elapse: () => {
      const due = [...pending.values()];
      pending.clear();
      for (const { fn } of due) fn();
    },
    reopen: () => createDrafts({ storage: () => storage, schedule, cancel }),
  };
}

{
  assert.equal(storageKeyOf({ session: 's1', project: '/a' }), 's1', 'a chat with a session is stored under it');
  assert.equal(storageKeyOf({ session: null, project: '/a' }), 'new:/a', 'an unsent chat is stored under its project');
  assert.equal(storageKeyOf({ session: null, project: null }), null, 'a chat with neither is not stored');
  assert.equal(storageKeyOf(undefined), null, 'no chat is not stored');

  const first = { key: 'c1', session: null, project: '/a' };
  const second = { key: 'c2', session: null, project: '/a' };
  const sent = { key: 'c3', session: 's1', project: '/a' };
  const chats = [sent, first, second];
  assert.equal(ownedStorageKey(chats, first), 'new:/a', 'the first unsent chat in a folder holds its key');
  assert.equal(ownedStorageKey(chats, second), null, 'a second unsent chat in that folder is not stored');
  assert.equal(ownedStorageKey(chats, sent), 's1', 'a chat with a session holds its own key');
  assert.equal(storageKeyOfRow(chats, { key: 'c2', id: 'c2' }), null, 'deleting the second unsent chat leaves the folder key alone');
  assert.equal(storageKeyOfRow(chats, { id: 's9' }), 's9', 'a row never opened here is dropped by its session id');
}

{
  const { drafts, writes, pending, elapse } = rig();
  drafts.writeDraft('s1', 'h');
  drafts.writeDraft('s1', 'he');
  drafts.writeDraft('s1', 'hello');
  assert.equal(writes.length, 0, 'nothing is written while the keystrokes are still coming');
  assert.equal(pending.size, 1, 'a burst of keystrokes leaves one write waiting');
  assert.equal([...pending.values()][0].ms, 400, 'the write waits 400 ms');
  assert.equal(drafts.readDraft('s1'), 'hello', 'the box reads back what was typed before anything is stored');
  elapse();
  assert.equal(writes.length, 1, 'one write per window');
  assert.deepEqual(JSON.parse(writes[0]), { s1: 'hello' }, 'the write holds the latest text');
}

{
  const { drafts, writes, pending, elapse, stored } = rig();
  drafts.writeDraft('s1', 'typed a moment ago');
  drafts.flushDrafts();
  assert.deepEqual(stored(), { s1: 'typed a moment ago' }, 'flush writes without waiting for the timer');
  assert.equal(pending.size, 0, 'and cancels the write that was waiting');
  elapse();
  assert.equal(writes.length, 1, 'so the timer finds nothing left to write');
  drafts.flushDrafts();
  assert.equal(writes.length, 1, 'a flush with nothing new writes nothing');
}

{
  const { drafts, reopen, elapse } = rig();
  drafts.writeDraft('s1', 'first');
  drafts.writeDraft('new:/a', 'second');
  elapse();
  const later = reopen();
  assert.equal(later.readDraft('s1'), 'first', 'a draft comes back after a reload');
  assert.equal(later.readDraft('new:/a'), 'second', 'so does one in an unsent chat');
  assert.equal(later.readDraft('s2'), '', 'a chat with no draft reads empty');
  assert.equal(later.readDraft(null), '', 'and so does a chat with no key');
}

{
  const { drafts, writes, pending, elapse, stored } = rig({ saved: { s1: 'keep', s2: 'other' } });
  drafts.writeDraft('s1', 'keep');
  assert.equal(pending.size, 0, 'writing the text already stored schedules nothing');
  drafts.writeDraft('s1', '');
  elapse();
  assert.deepEqual(stored(), { s2: 'other' }, 'empty text deletes the key and leaves the others');
  drafts.writeDraft('s2', ' \n\t ');
  elapse();
  assert.deepEqual(stored(), {}, 'whitespace-only text deletes the key');
  drafts.writeDraft('s2', '');
  assert.equal(pending.size, 0, 'clearing a box with no stored draft schedules nothing');
  assert.equal(writes.length, 2, 'two deletes, two writes');
}

{
  const { drafts, pending, elapse, stored } = rig();
  drafts.writeDraft(null, 'nowhere to go');
  assert.equal(pending.size, 0, 'a chat with no key never schedules a write');
  assert.equal(drafts.readDraft(null), '', 'and nothing is kept for it');
  drafts.writeDraft('s1', '  indented\n');
  elapse();
  assert.equal(stored().s1, '  indented\n', 'the text is stored as typed, not trimmed');
}

{
  const { drafts, elapse, stored } = rig();
  drafts.writeDraft('new:/a', 'typed before the first send finished');
  drafts.moveDraft('new:/a', 's1');
  elapse();
  assert.deepEqual(stored(), { s1: 'typed before the first send finished' }, 'the draft moves to the session id');
  assert.equal(drafts.readDraft('new:/a'), '', 'and the unsent key is gone');

  drafts.writeDraft('new:/a', 'newer');
  drafts.writeDraft('s1', 'older');
  drafts.moveDraft('new:/a', 's1');
  elapse();
  assert.deepEqual(stored(), { s1: 'newer' }, 'a draft moved onto an existing one replaces it');

  drafts.moveDraft('new:/a', 's1');
  elapse();
  assert.deepEqual(stored(), { s1: 'newer' }, 'moving an empty draft keeps what the session had');
  drafts.moveDraft('new:/a', 'new:/a');
  drafts.moveDraft(null, 's1');
  drafts.moveDraft('new:/a', null);
  assert.deepEqual(stored(), { s1: 'newer' }, 'a move with nothing to move or nowhere to go changes nothing');
}

{
  const { drafts, pending, elapse, stored } = rig({ saved: { s1: 'gone soon', s2: 'stays' } });
  drafts.dropDraft('s1');
  elapse();
  assert.deepEqual(stored(), { s2: 'stays' }, 'a dropped draft leaves no key behind');
  drafts.dropDraft('s1');
  drafts.dropDraft(null);
  assert.equal(pending.size, 0, 'dropping what is not there schedules nothing');
  assert.equal(drafts.readDraft('s1'), '', 'a dropped draft reads empty at once');
}

{
  const { drafts, elapse } = rig({ broken: true });
  assert.doesNotThrow(() => {
    drafts.writeDraft('s1', 'still typing');
    elapse();
    drafts.flushDrafts();
  }, 'storage that refuses to write costs persistence, never a keystroke');
  assert.equal(drafts.readDraft('s1'), 'still typing', 'and the box still reads back what was typed');
}

{
  assert.equal(rig({ saved: '{not json' }).drafts.readDraft('s1'), '', 'unparseable storage reads empty');
  assert.equal(rig({ saved: '["s1"]' }).drafts.readDraft('s1'), '', 'a stored array reads empty');
  const odd = rig({ saved: { s1: 7, s2: 'real' } }).drafts;
  assert.equal(odd.readDraft('s1'), '', 'a stored non-string is not a draft');
  assert.equal(odd.readDraft('s2'), 'real', 'the strings beside it still are');
}

console.log('drafts-check: all passed');
