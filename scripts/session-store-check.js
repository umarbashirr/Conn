'use strict';
/* What a chat's name and a chat's board id have in common is the file they live
   in: one JSON object in ~/.conn keyed by session id, read once, each entry
   checked as it is read, written whole. This holds that contract in plain node
   against the real modules on a throwaway HOME, so moving the code behind them
   cannot change what a person's saved names do. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-session-store-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
};

const fresh = (mod) => {
  for (const key of Object.keys(require.cache)) if (key.startsWith(path.join(ROOT, 'src'))) delete require.cache[key];
  return require(path.join(ROOT, 'src', mod));
};
const throws = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
const onDisk = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const NUMERIC = '33333333-3333-4333-8333-333333333333';

function titles() {
  let t = fresh('main/chat-titles.js');
  check('titles-file-is-in-the-conn-folder', t.FILE === path.join(home, '.conn', 'chat-titles.json'), t.FILE);
  check('titles-unknown-is-null', t.get(ID) === null, String(t.get(ID)));
  check('titles-set-trims-and-caps', t.set(ID, `  ${'x'.repeat(100)}  `) === 'x'.repeat(80), 'not trimmed to 80');
  check('titles-get-returns-it', t.get(ID) === 'x'.repeat(80), String(t.get(ID)));
  check('titles-set-refuses-an-id-that-is-not-a-session', /not a session id/.test(throws(() => t.set('short', 'a')) || ''), 'accepted');
  check('titles-set-refuses-a-blank-name', throws(() => t.set(ID, '   ')) === 'Give the chat a name.', 'accepted');
  check('titles-written-whole', JSON.stringify(onDisk(t.FILE)) === JSON.stringify({ [ID]: 'x'.repeat(80) }), JSON.stringify(onDisk(t.FILE)));

  fs.writeFileSync(t.FILE, `{"${ID}":" kept ","${OTHER}":"   ","short":"bad id","${NUMERIC}":7}`);
  t = fresh('main/chat-titles.js');
  check('titles-read-keeps-only-valid-entries', t.get(ID) === 'kept' && t.get(OTHER) === null && t.get('short') === null && t.get(NUMERIC) === null, 'bad entries survived');

  check('titles-forget-reports-what-it-removed', t.forget(ID) === true && t.forget(ID) === false, 'wrong report');
  check('titles-forgotten-is-gone-from-disk', !(ID in onDisk(t.FILE)), JSON.stringify(onDisk(t.FILE)));
}

titles();
fs.rmSync(home, { recursive: true, force: true });
console.log(failures.length ? `\n${failures.length} failed` : '\nall passed');
process.exit(failures.length ? 1 : 0);
