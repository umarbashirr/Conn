/* The unified-diff parser and the two mappers that feed it, under plain node.
   The Codex shapes are codex 0.158.0's; see codexFiles. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseUnifiedDiff, codexFiles, acpFiles } = require('../src/shared/unified-diff.js');

{
  const got = parseUnifiedDiff('@@ -1,4 +1,4 @@\n button {\n-  color: blue;\n+  color: red;\n   margin: 0;\n }\n');
  assert.deepEqual(got, [{
    before: 'button {\n  color: blue;\n  margin: 0;\n}',
    after: 'button {\n  color: red;\n  margin: 0;\n}',
  }], 'an update hunk keeps its context on both sides and splits the change');
}

{
  const text = '@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n@@ -20,3 +20,4 @@\n x\n y\n+z\n w\n';
  assert.deepEqual(parseUnifiedDiff(text), [
    { before: 'a\nb\nc', after: 'a\nB\nc' },
    { before: 'x\ny\nw', after: 'x\ny\nz\nw' },
  ], 'two @@ hunks come back as two hunks, in order');
}

{
  const headed = '--- a/src/a.js\n+++ b/src/a.js\n@@ -1,2 +1,2 @@\n one\n-two\n+three\n';
  const bare = '@@ -1,2 +1,2 @@\n one\n-two\n+three\n';
  assert.deepEqual(parseUnifiedDiff(headed), parseUnifiedDiff(bare), 'a ---/+++ header changes nothing');
  assert.deepEqual(parseUnifiedDiff(bare), [{ before: 'one\ntwo', after: 'one\nthree' }]);
}

{
  const text = '@@ -1,2 +1,2 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n';
  assert.deepEqual(parseUnifiedDiff(text), [{ before: 'old', after: 'new' }], 'the no-newline marker is not a line of either side');
}

{
  const text = '@@ -1,3 +1,3 @@\n-- not a header\n+++ not a header either\n x\n';
  assert.deepEqual(
    parseUnifiedDiff(text),
    [{ before: '- not a header\nx', after: '++ not a header either\nx' }],
    'inside a hunk a line starting --- or +++ is still a removed or added line',
  );
}

{
  const text = '@@ -1,3 +1,3 @@\n a\n\n b\n';
  assert.deepEqual(parseUnifiedDiff(text), [{ before: 'a\n\nb', after: 'a\n\nb' }], 'a blank line inside a hunk is blank context');
}

assert.deepEqual(parseUnifiedDiff(''), [], 'no text, no hunks');
assert.deepEqual(parseUnifiedDiff(null), [], 'not text, no hunks');

{
  const got = codexFiles([
    { path: '/p/notes.txt', kind: { type: 'add' }, diff: 'first\nsecond\n' },
    { path: '/p/old.txt', kind: { type: 'delete' }, diff: 'bye\n' },
    { path: '/p/a.js', kind: { type: 'update', move_path: '/q/a.js' }, diff: '@@ -1 +1 @@\n-x\n+y\n' },
    { path: '/p/b.js', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-x\n+y\n' },
    { path: '/p/c.js', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-x\n+y\n' },
  ]);
  assert.deepEqual(got, [
    { path: '/p/notes.txt', kind: 'add', movePath: null, hunks: [{ before: '', after: 'first\nsecond\n' }] },
    { path: '/p/old.txt', kind: 'delete', movePath: null, hunks: [{ before: 'bye\n', after: '' }] },
    { path: '/p/a.js', kind: 'update', movePath: '/q/a.js', hunks: [{ before: 'x', after: 'y' }] },
    { path: '/p/b.js', kind: 'update', movePath: null, hunks: [{ before: 'x', after: 'y' }] },
    { path: '/p/c.js', kind: 'update', movePath: null, hunks: [{ before: 'x', after: 'y' }] },
  ], 'add and delete carry the whole file, a move names its destination');
}

assert.deepEqual(codexFiles(undefined), [], 'no changes, no files');
assert.deepEqual(codexFiles([{ kind: { type: 'add' }, diff: 'x' }]), [], 'a change with no path is dropped');

{
  const got = acpFiles([
    { type: 'content', content: { type: 'text', text: 'done' } },
    { type: 'diff', path: '/p/style.css', oldText: 'a\nb\n', newText: 'a\nc\n' },
    { type: 'diff', path: '/p/new.txt', oldText: null, newText: 'hi\n' },
    { type: 'diff', path: '/p/absent.txt', newText: 'hi\n' },
  ]);
  assert.deepEqual(got, [
    { path: '/p/style.css', kind: 'update', movePath: null, hunks: [{ before: 'a\nb\n', after: 'a\nc\n' }] },
    { path: '/p/new.txt', kind: 'add', movePath: null, hunks: [{ before: '', after: 'hi\n' }] },
    { path: '/p/absent.txt', kind: 'add', movePath: null, hunks: [{ before: '', after: 'hi\n' }] },
  ], 'diff content maps to files, a missing old text is a new file, other content is ignored');
}

assert.deepEqual(acpFiles([{ type: 'content', content: { type: 'text', text: 'x' } }]), [], 'content with no diff has no files');
assert.deepEqual(acpFiles(undefined), [], 'no content, no files');

{
  const lines = Array.from({ length: 1000 }, (_, i) => `line ${i}`);
  const edited = lines.map((l, i) => (i === 500 ? 'line 500 edited' : l));
  const [file] = acpFiles([{ type: 'diff', path: '/p/big.js', oldText: lines.join('\n'), newText: edited.join('\n') }]);
  assert.deepEqual(file.hunks, [{
    before: lines.slice(497, 504).join('\n'),
    after: edited.slice(497, 504).join('\n'),
  }], 'a whole-file update is cut to the changed lines and three either side');
}

console.log('unified-diff-check: all passed');
