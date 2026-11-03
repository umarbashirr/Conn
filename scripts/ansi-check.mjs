import assert from 'node:assert/strict';
import './renderer-esm.mjs';

const { parseAnsi, plainText, clipSpans } = await import('../src/renderer/ui/lib/ansi.js');

const E = '\x1b';
const plain = (t) => ({ text: t, fg: null, bold: false, dim: false });
const s = (text, over = {}) => ({ ...plain(text), ...over });

assert.deepEqual(parseAnsi(''), [], 'empty text has no spans');
assert.deepEqual(parseAnsi('hello'), [plain('hello')], 'plain text is one unstyled span');
assert.deepEqual(parseAnsi(`${E}[31mred${E}[0m ok`), [s('red', { fg: 1 }), plain(' ok')], 'red then reset');
assert.deepEqual(parseAnsi(`${E}[m${E}[32mg`), [s('g', { fg: 2 })], 'an empty SGR resets, and 32 is green');
assert.deepEqual(parseAnsi(`${E}[91mx`), [s('x', { fg: 9 })], 'bright red is colour 9');
assert.deepEqual(parseAnsi(`${E}[1;31mx${E}[22my${E}[39mz`),
  [s('x', { fg: 1, bold: true }), s('y', { fg: 1 }), plain('z')], 'bold with colour, 22 clears bold, 39 clears colour');
assert.deepEqual(parseAnsi(`${E}[2mx${E}[22my`), [s('x', { dim: true }), plain('y')], 'dim, and 22 clears it');
assert.deepEqual(parseAnsi(`${E}[1m${E}[2mx${E}[22my`), [s('x', { bold: true, dim: true }), plain('y')], 'bold and dim stack, and 22 clears both');
assert.deepEqual(parseAnsi(`${E}[31m${E}[0;1mx`), [s('x', { bold: true })], '0 inside a list resets before the rest applies');

assert.deepEqual(parseAnsi(`${E}[44mbg${E}[49m`), [plain('bg')], 'a background colour is dropped, the text stays');
assert.deepEqual(parseAnsi(`${E}[38;5;196mx`), [plain('x')], '256-colour is dropped without eating the text');
assert.deepEqual(parseAnsi(`${E}[38;2;1;2;3;1mx`), [s('x', { bold: true })], 'truecolour is skipped whole and later params still apply');
assert.deepEqual(parseAnsi(`${E}[4;31mx`), [s('x', { fg: 1 })], 'underline is ignored, colour kept');

const stripped = [
  [`${E}[2K${E}[1Gdone`, 'done', 'erase line and cursor moves'],
  [`${E}[?25lhi${E}[?25h`, 'hi', 'private mode toggles'],
  [`${E}]0;title${String.fromCharCode(7)}text`, 'text', 'an OSC title ended by BEL'],
  [`${E}]8;;https://x.dev${E}\\link${E}]8;;${E}\\`, 'link', 'an OSC hyperlink ended by ST'],
  [`${E}(Bx${E}=y`, 'xy', 'charset and keypad escapes'],
  [`a${E}[3`, 'a', 'an escape cut off at the end'],
  [`a${E}`, 'a', 'a bare escape at the end'],
  [`\x9b31mx`, 'x', 'an 8-bit CSI'],
];
for (const [input, want, why] of stripped) {
  assert.equal(plainText(parseAnsi(input)), want, `strips ${why}`);
  assert.ok(!/[\x1b\x9b]/.test(plainText(parseAnsi(input))), `no escape byte survives ${why}`);
}
assert.equal(plainText(parseAnsi(`${E}[31mfoo\nbar${E}[0m`)), 'foo\nbar', 'newlines survive');
assert.deepEqual(parseAnsi(`${E}[31mfoo\nbar`), [s('foo\nbar', { fg: 1 })], 'a colour carries across a newline');

{
  const spans = parseAnsi(`${E}[31m${'a'.repeat(3)}${E}[0m${'b'.repeat(3)}`);
  assert.deepEqual(clipSpans(spans, 4), { spans: [s('aaa', { fg: 1 }), plain('b')], hidden: 2 }, 'clipping counts visible characters and cuts inside a span');
  assert.deepEqual(clipSpans(spans, 6), { spans, hidden: 0 }, 'at the limit nothing is hidden');
  assert.deepEqual(clipSpans(spans, 2), { spans: [s('aa', { fg: 1 })], hidden: 4 }, 'a clip inside the first span drops the rest');
  const long = parseAnsi('x'.repeat(9000));
  const cut = clipSpans(long, 4000);
  assert.equal(plainText(cut.spans).length, 4000, 'the existing 4000 character cap holds');
  assert.equal(cut.hidden, 5000, 'and counts what it left out');
}

console.log('ansi-check: all passed');
