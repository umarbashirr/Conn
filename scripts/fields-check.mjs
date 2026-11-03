import assert from 'node:assert/strict';
import './renderer-esm.mjs';

const { inputFields, INLINE_MAX } = await import('../src/renderer/ui/lib/fields.js');

assert.equal(INLINE_MAX, 80, 'a string stays inline up to 80 characters');
assert.deepEqual(inputFields({ command: 'git status' }), [{ key: 'command', kind: 'inline', text: 'git status' }], 'a short string is inline');
assert.equal(inputFields({ a: 'x'.repeat(80) })[0].kind, 'inline', 'exactly 80 characters is inline');
assert.equal(inputFields({ a: 'x'.repeat(81) })[0].kind, 'block', 'past 80 characters is a block');
assert.deepEqual(inputFields({ a: 'one\ntwo' }), [{ key: 'a', kind: 'block', text: 'one\ntwo' }], 'multi-line text is a block, kept as written');
assert.deepEqual(inputFields({ n: 3, ok: false, none: null }), [
  { key: 'n', kind: 'inline', text: '3' },
  { key: 'ok', kind: 'inline', text: 'false' },
  { key: 'none', kind: 'inline', text: 'null' },
], 'numbers, booleans and null are inline');
assert.deepEqual(inputFields({ opts: { a: 1, b: [2, 3] } }), [{ key: 'opts', kind: 'json', text: '{"a":1,"b":[2,3]}' }], 'a nested object is compact JSON');
assert.deepEqual(inputFields({ list: ['a', 'b'] }), [{ key: 'list', kind: 'json', text: '["a","b"]' }], 'an array is compact JSON');
assert.deepEqual(inputFields({ a: 1, gone: undefined, b: 2 }).map((f) => f.key), ['a', 'b'], 'undefined values are left out and order is kept');
assert.deepEqual(inputFields({}), [], 'no input has no fields');
assert.deepEqual(inputFields(undefined), [], 'a missing input has no fields');
assert.deepEqual(inputFields('raw'), [{ key: 'input', kind: 'inline', text: 'raw' }], 'a bare string input is one field');

console.log('fields-check: all passed');
