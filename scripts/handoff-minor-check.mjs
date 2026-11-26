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

fs.rmSync(home, { recursive: true, force: true });
console.log(failures.length ? `\n${failures.length} failed: ${failures.join(', ')}` : '\nhandoff-minor-check: all passed');
process.exit(failures.length ? 1 : 0);
