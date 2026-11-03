import assert from 'node:assert/strict';
import './renderer-esm.mjs';

const { PEEK, following, pinned, pinTop, room, settle, land } = await import('../src/renderer/ui/lib/scroll-pin.js');

const view = 600;

assert.equal(pinTop(500), 500 - PEEK, 'a pinned message sits PEEK pixels below the top of the view');
assert.equal(pinTop(10), 0, 'a message near the start of the transcript pins at the very top');

assert.equal(room({ anchorTop: 1000, natural: 1100, viewport: view }), 1000 - PEEK + view - 1100,
  'a short turn gets enough room below it to scroll its message up to the pin');
assert.equal(room({ anchorTop: 1000, natural: 1000 - PEEK + view, viewport: view }), 0,
  'a turn that exactly fills the view needs no room');
assert.ok(room({ anchorTop: 1000, natural: 1000 + view, viewport: view }) < 0,
  'a turn taller than the view has outgrown its pin');

const short = { anchorTop: 1000, natural: 1100, viewport: view };
const tall = { anchorTop: 1000, natural: 2000, viewport: view };

assert.deepEqual(settle(pinned('u2'), short), pinned('u2'), 'a pin holds while its turn fits below it');
assert.deepEqual(settle(pinned('u2'), tall), following, 'a pin lets go once the reply grows past the bottom of the view');
assert.deepEqual(settle(pinned('u2'), null), following, 'a pin whose message is not on screen lets go');
assert.deepEqual(settle(following, short), following, 'following never turns back into a pin by itself');

assert.deepEqual(land('u2', short), { mode: pinned('u2'), free: false },
  'opening a chat whose last turn fits pins its last message, as a fresh send would');
assert.deepEqual(land('u2', tall), { mode: following, free: true },
  'opening a chat whose last turn is long lands free at its message, not at the end');
assert.deepEqual(land('u2', null), { mode: following, free: false },
  'opening a chat whose last message is not on screen follows the end as before');

console.log('scroll-pin-check: all passed');
