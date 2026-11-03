import assert from 'node:assert/strict';
import './renderer-esm.mjs';

const { permPreview } = await import('../src/renderer/ui/lib/perm-preview.js');

assert.deepEqual(permPreview('Bash', { command: 'ls\npwd', description: 'List' }),
  { kind: 'command', command: 'ls\npwd', description: 'List' },
  'Bash shows the whole multi-line command and its description');
assert.deepEqual(permPreview('Bash', { command: 'ls' }),
  { kind: 'command', command: 'ls', description: '' },
  'a command without a description gets an empty one');
assert.equal(permPreview('Bash', {}), null, 'a Bash call with no command falls back to the summary line');

const edit = permPreview('Edit', { file_path: '/a', old_string: 'x', new_string: 'y' });
assert.equal(edit.kind, 'diff', 'Edit previews as a diff');
assert.deepEqual(edit.hunks, [{ before: 'x', after: 'y' }], 'Edit hunks come from the shared tool-row builder');

assert.deepEqual(permPreview('Write', { file_path: '/a', content: 'one\ntwo' }).hunks,
  [{ before: '', after: 'one\ntwo' }], 'Write is all added lines');
assert.equal(permPreview('MultiEdit', { edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] }).hunks.length, 2,
  'MultiEdit gives one hunk per edit');

const files = [{ path: 'a.js', kind: 'update', hunks: [{ before: 'a', after: 'b' }] }];
assert.deepEqual(permPreview('Edit', { files }).files, files, 'a Codex patch keeps its per-file grouping');

assert.equal(permPreview('Read', { file_path: '/a' }), null, 'other tools keep the summary line');
assert.equal(permPreview('Edit', { file_path: '/a' }), null, 'an edit with nothing to show keeps the summary line');
console.log('perm-preview-check ok');

assert.equal(permPreview('Edit', { file_path: '/a', old_string: 'x', new_string: 'y' }, { rowShown: true }), null,
  'an edit whose call row is on screen is not previewed twice');
assert.equal(permPreview('Bash', { command: 'ls' }, { rowShown: true }).kind, 'command',
  'a command is still shown in full when its row is on screen, since the row truncates it');
