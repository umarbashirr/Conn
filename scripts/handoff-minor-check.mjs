/* The verifier's round-three minor findings on switching a chat between
   agents, under plain node, on a throwaway HOME. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-handoff-minor-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.SHELL = '/bin/false';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const A = 'aaaaaaaa-1111';
const B = 'bbbbbbbb-2222';
const C = 'cccccccc-3333';
const failures = [];
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`); } catch (e) { failures.push(name); console.log(`FAIL ${name}: ${e.message.split('\n')[0]}`); }
};

// A call handed over while still running is still running when carried on again.
await check('a handed-over call goes to the next agent as running, not done', () => {
  const { entriesOf } = require('../src/shared/handoff.js');
  const [e] = entriesOf([{ id: 't', kind: 'tool', name: 'Bash', input: { command: 'make' }, state: 'handed-over' }]);
  assert.equal(e.status, 'running');
});

// Show again gives back one chat, not one row per part.
await check('the parts a delete left of one chat come back as that one chat', () => {
  const hidden = require('../src/main/hidden-sessions.js');
  const records = require('../src/main/chat-segments.js');
  const { hideParts, showAgain } = require('../src/main/hidden-chats.js');
  const { collapseRows } = require('../src/shared/chat-segments.js');
  assert.ok(hidden.FILE.startsWith(home) && records.FILE.startsWith(home));
  // Claude A -> Copilot B -> Cursor C, deleted: Claude went, Copilot and Cursor stayed.
  const segs = [{ provider: 'claude', session: A }, { provider: 'copilot', session: B, cut: 0, context: 40 }, { provider: 'cursor', session: C, cut: 0 }];
  hideParts({ hidden, head: A, segments: segs, left: [{ session: B, provider: 'copilot' }, { session: C, provider: 'cursor' }], meta: { project: '/w', title: 'Fix login', atOf: () => 5 } });
  const rows = hidden.list();
  assert.equal(rows.length, 1, 'Settings lists the chat once');
  assert.deepEqual([rows[0].title, rows[0].sessions, rows[0].providers], ['Fix login', [B, C], ['copilot', 'cursor']]);
  const res = showAgain({ hidden, records, session: C });
  assert.deepEqual([res.ok, res.sessions, res.joined], [true, [B, C], true]);
  assert.deepEqual(hidden.list(), [], 'every part is shown again, not only the one clicked');
  assert.deepEqual(records.get(B), [{ provider: 'copilot', session: B, context: 40, cut: 0 }, { provider: 'cursor', session: C, cut: 0 }], 'the record is back, under the first part that stayed');
  assert.deepEqual(collapseRows([{ id: B, at: 1 }, { id: C, at: 2 }], records.all()).map((r) => r.id), [B], 'the rail draws it as one row');
  records.forget(B);
});
await check('a chat that left one part comes back as that part, and a retry keeps the rest together', () => {
  const hidden = require('../src/main/hidden-sessions.js');
  const records = require('../src/main/chat-segments.js');
  const { hideParts, showAgain, afterRetry } = require('../src/main/hidden-chats.js');
  hideParts({ hidden, head: A, segments: [{ provider: 'claude', session: A }, { provider: 'copilot', session: B, cut: 0 }], left: [{ session: B, provider: 'copilot' }], meta: { title: 'One' } });
  assert.deepEqual(showAgain({ hidden, records, session: B }), { ok: true, sessions: [B], joined: false });
  assert.equal(records.get(B), null, 'one part needs no record');
  const segs = [{ provider: 'claude', session: A }, { provider: 'copilot', session: B, cut: 0 }, { provider: 'cursor', session: C, cut: 0 }];
  hideParts({ hidden, head: A, segments: [...segs, { provider: 'grok', session: 'dddddddd-4444', cut: 0 }], left: [{ session: B, provider: 'copilot' }, { session: C, provider: 'cursor' }, { session: 'dddddddd-4444', provider: 'grok' }], meta: { title: 'Three' } });
  assert.deepEqual(afterRetry({ hidden, session: B, removed: ['dddddddd-4444'] }).left, [B, C]);
  assert.deepEqual(hidden.list()[0].sessions, [B, C], 'still one chat');
  assert.deepEqual(hidden.get(B).segments.map((s) => s.session), [B, C], 'and its run is what is left');
  showAgain({ hidden, records, session: B });
  records.forget(B);
  const main = read('src/main/index.js');
  assert.ok(/hideParts\(\{/.test(main) && /showAgain\(\{ hidden: hiddenSessions, records: chatSegments, session \}\)/.test(main) && /afterRetry\(\{ hidden: hiddenSessions, session, removed \}\)/.test(main), 'main hides, shows and retries by chat');
});

fs.rmSync(home, { recursive: true, force: true });
console.log(failures.length ? `\n${failures.length} failed: ${failures.join(', ')}` : '\nhandoff-minor-check: all passed');
process.exit(failures.length ? 1 : 0);
