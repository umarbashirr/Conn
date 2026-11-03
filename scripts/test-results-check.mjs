import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './renderer-esm.mjs';

const { parseTestRun, testSummary } = await import('../src/renderer/ui/lib/test-runs.js');
const { parseStack, segmentStack, foldFrames, resolveFile } = await import('../src/renderer/ui/lib/stacks.js');

const fx = (name) => readFileSync(new URL(`./fixtures/test-runs/${name}`, import.meta.url), 'utf8');
const totals = (r) => [r.total, r.passed, r.failed, r.skipped];
const suite = (r, name) => r.suites.find((s) => s.name === name);
const counts = (s) => [s.passed, s.failed, s.skipped];

{
  const r = parseTestRun(fx('node-fail.txt'));
  assert.equal(r.runner, 'node:test', 'node:test spec output is recognised');
  assert.deepEqual(totals(r), [5, 3, 1, 1], 'node:test totals come from its own summary');
  assert.deepEqual(r.suites.map((s) => s.name), ['cart', 'coupon'], 'one suite per describe block');
  assert.deepEqual(counts(suite(r, 'cart')), [2, 1, 1], 'node:test suite counts follow its tests');
  const bad = suite(r, 'cart').tests.find((t) => t.status === 'failed');
  assert.equal(bad.name, 'applies coupon', 'the failed node:test test is named without its timing');
  assert.match(bad.error, /36 !== 35/, 'the failed node:test test carries its assertion message');
  assert.ok(suite(r, 'cart').tests.some((t) => t.status === 'skipped' && t.name === 'rounds tax'), 'a skipped node:test test keeps its name');
  assert.equal(parseTestRun(fx('node-pass.txt')).failed, 0, 'a passing node:test run reports no failures');
}

{
  const r = parseTestRun(fx('jest-fail.txt'));
  assert.equal(r.runner, 'jest', 'jest default output is recognised');
  assert.deepEqual(totals(r), [4, 2, 1, 1], 'jest totals come from its Tests: line');
  const bad = suite(r, 'cart').tests[0];
  assert.deepEqual([bad.name, bad.status], ['applies coupon', 'failed'], 'a jest failure is placed under its describe block');
  assert.match(bad.error, /Expected: 35/, 'the jest failure keeps its diff');
  assert.deepEqual(totals(parseTestRun(fx('jest-pass.txt'))), [4, 3, 0, 1], 'a passing jest run parses with no suites needed');

  const v = parseTestRun(fx('jest-verbose-fail.txt'));
  assert.deepEqual(counts(suite(v, 'cart')), [1, 1, 1], 'jest verbose suite counts follow its marks');
  assert.deepEqual(counts(suite(v, 'coupon')), [1, 0, 0], 'jest verbose lists passing suites too');
  assert.match(suite(v, 'cart').tests.find((t) => t.status === 'failed').error, /Received: 36/, 'jest verbose attaches the error to its test');
}

{
  const r = parseTestRun(fx('vitest-fail.txt'));
  assert.equal(r.runner, 'vitest', 'vitest default output is recognised');
  assert.deepEqual(totals(r), [6, 4, 1, 1], 'vitest totals come from its Tests line');
  assert.deepEqual(counts(suite(r, 'src/cart.test.ts')), [3, 0, 0], 'a vitest file with only passes is a passing suite');
  assert.deepEqual(counts(suite(r, 'src/coupon.test.ts')), [1, 1, 1], 'a vitest file line splits failed and skipped from the rest');
  const bad = suite(r, 'src/coupon.test.ts').tests.find((t) => t.status === 'failed');
  assert.equal(bad.name, 'coupon > applies SAVE10', 'the vitest failure keeps its describe path');
  assert.match(bad.error, /expected 36 to be 35/, 'the vitest failure carries its message');
  assert.deepEqual(totals(parseTestRun(fx('vitest-pass.txt'))), [6, 5, 0, 1], 'a passing vitest run parses');
}

{
  const r = parseTestRun(fx('pytest-fail.txt'));
  assert.equal(r.runner, 'pytest', 'pytest output is recognised');
  assert.deepEqual(totals(r), [5, 3, 1, 1], 'pytest totals come from its final line');
  assert.deepEqual(counts(suite(r, 'tests/test_cart.py')), [2, 1, 0], 'pytest progress dots become suite counts');
  assert.deepEqual(counts(suite(r, 'tests/test_coupon.py')), [1, 0, 1], 'pytest s marks a skip');
  const bad = suite(r, 'tests/test_cart.py').tests.find((t) => t.status === 'failed');
  assert.equal(bad.name, 'test_applies_coupon', 'the pytest failure is named from its section');
  assert.match(bad.error, /assert 36 == 35/, 'the pytest failure carries its assertion');
  assert.deepEqual(totals(parseTestRun(fx('pytest-pass.txt'))), [5, 4, 0, 1], 'a passing pytest run parses');
}

assert.equal(testSummary(parseTestRun(fx('node-fail.txt'))), '5 tests, 1 failed, 1 skipped', 'the summary names failures and skips');
assert.equal(testSummary(parseTestRun(fx('pytest-pass.txt'))), '5 tests, 1 skipped', 'a passing run names no failures');
assert.equal(testSummary({ total: 1, failed: 0, skipped: 0 }), '1 test', 'one test is singular');

for (const name of ['not-a-test.txt', 'README-prose.txt', 'node-trace.txt', 'python-traceback.txt']) {
  assert.equal(parseTestRun(fx(name)), null, `${name} is not a test run`);
}
assert.equal(parseTestRun(''), null, 'empty output is not a test run');
assert.equal(parseTestRun('3 passed, 1 failed in 0.2s'), null, 'a bare summary-shaped line is not a pytest run');
assert.equal(parseTestRun('Tests: 3 passed, 3 total'), null, 'a lone jest-shaped line is not a jest run');

{
  const s = parseStack(fx('node-trace.txt'));
  assert.equal(s.frames.length, 10, 'every "at" line of a V8 trace is a frame');
  const [, load, main] = s.frames;
  assert.deepEqual([load.fn, load.file, load.line, load.col, load.framework], ['load', '/tmp/u7scratch/trace.js', 2, 41, false], 'a V8 frame with a function splits into fn, file, line, col');
  assert.equal(main.fn, 'main', 'the next app frame follows');
  const first = parseStack('    at Object.readFileSync (node:fs:539:20)').frames[0];
  assert.deepEqual([first.file, first.line, first.framework], ['node:fs', 539, true], 'node: frames are framework');
  assert.equal(parseStack('    at /app/src/a.js:3:9').frames[0].fn, '', 'a V8 frame without a function has an empty fn');
  assert.equal(parseStack('    at async Promise.all (index 0)').frames[0].framework, true, 'a frame with no file is framework');
  assert.equal(parseStack('    at x (/app/node_modules/foo/index.js:1:1)').frames[0].framework, true, 'node_modules frames are framework');
  assert.equal(parseStack('    at x (file:///app/src/a.mjs:4:5)').frames[0].file, '/app/src/a.mjs', 'a file:// URL is turned back into a path');
  assert.equal(parseStack('    at Test.run (node:internal/test_runner/test:1397:25)').frames[0].framework, true, 'node:internal frames are framework');
}

{
  const s = parseStack(fx('python-traceback.txt'));
  assert.equal(s.frames.length, 3, 'every File line of a Python traceback is a frame');
  const [top, , leaf] = s.frames;
  assert.deepEqual([top.fn, top.file, top.line, top.framework], ['<module>', '/tmp/u7scratch/trace.py', 10, false], 'a Python frame splits into fn, file and line');
  assert.equal(leaf.fn, 'load', 'the innermost Python frame is last');
  assert.equal(leaf.code, 'with open(path) as f:', 'a Python frame keeps its source line');
  const lib = parseStack('  File "/usr/lib/python3.12/json/__init__.py", line 293, in load\n  File "/home/u/.venv/lib/python3.12/site-packages/x/y.py", line 2, in z').frames;
  assert.deepEqual(lib.map((f) => f.framework), [true, true], 'Python stdlib and site-packages frames are framework');
}

{
  const [app, fw] = parseStack(' ❯ src/coupon.test.ts:8:36\n ❯ node_modules/@vitest/runner/dist/chunk-hooks.js:155:11').frames;
  assert.deepEqual([app.file, app.line, app.framework, fw.framework], ['src/coupon.test.ts', 8, false, true], 'a vitest ❯ frame parses and node_modules in it is framework');
  const folded = foldFrames(parseStack(fx('python-traceback.txt')).frames);
  assert.deepEqual(folded.map((r) => r.type), ['app', 'app', 'app'], 'app-only Python frames never fold');
}

assert.equal(parseStack('hello\nworld'), null, 'text with no frames is not a stack');
assert.equal(parseStack('see src/a.js:3:9 for details'), null, 'a bare file:line mention is not a stack');
assert.equal(parseStack('at the end of the day (we shipped)'), null, 'prose starting with "at" is not a frame');

{
  const segs = segmentStack(fx('node-trace.txt'));
  assert.deepEqual(segs.map((s) => s.type), ['text', 'stack', 'text'], 'a trace splits the text around its frames');
  assert.match(segs[0].text, /ENOENT/, 'the text before the frames is kept');
  assert.match(segs[2].text, /errno: -2/, 'the text after the frames is kept');
  assert.equal(segmentStack('plain\ntext').length, 1, 'text without frames stays one segment');
  assert.equal(segmentStack('plain\ntext')[0].type, 'text', 'and it is a text segment');
  const joined = segs.map((s) => (s.type === 'text' ? s.text : s.frames.map((f) => f.raw).join('\n'))).join('\n');
  const lines = (t) => t.split('\n').map((l) => l.trim()).filter(Boolean);
  assert.deepEqual(lines(joined), lines(fx('node-trace.txt')), 'segments lose no line of the output');
}

{
  const rows = foldFrames(parseStack(fx('node-trace.txt')).frames);
  assert.deepEqual(rows.map((r) => r.type), ['fold', 'app', 'app', 'app', 'fold'], 'consecutive framework frames fold into one row');
  const folds = rows.filter((r) => r.type === 'fold');
  assert.deepEqual(folds.map((f) => f.frames.length), [1, 6], 'each fold holds its whole run of framework frames');
  const err = parseStack(parseTestRun(fx('node-fail.txt')).suites[0].tests.find((t) => t.status === 'failed').error);
  const shaped = foldFrames(err.frames).map((r) => r.type);
  assert.deepEqual(shaped, ['app', 'fold'], 'a failed test error shows its app frame and folds the runner internals');
  assert.equal(foldFrames([]).length, 0, 'no frames fold to nothing');
}

assert.equal(resolveFile('/proj/src/a.js', '/proj'), 'src/a.js', 'an absolute path inside the project becomes project-relative');
assert.equal(resolveFile('src/a.js', '/proj'), 'src/a.js', 'a relative path stays as it is');
assert.equal(resolveFile('./a.js', '/proj'), 'a.js', 'a leading ./ is dropped');
assert.equal(resolveFile('/etc/hosts', '/proj'), null, 'a path outside the project is not openable');
assert.equal(resolveFile('/proj/../etc/hosts', '/proj'), null, 'a path that climbs out of the project is not openable');
assert.equal(resolveFile('../x.js', '/proj'), null, 'a relative path that climbs out is not openable');
assert.equal(resolveFile('/proj/a.js', null), null, 'with no project nothing resolves');
assert.equal(resolveFile('node:fs', '/proj'), null, 'a node: module has no file');
assert.equal(resolveFile('<anonymous>', '/proj'), null, 'an anonymous frame has no file');
assert.equal(resolveFile('/projx/a.js', '/proj'), null, 'a sibling folder sharing the prefix is outside');

console.log('test-results-check: ok');

{
  const v = parseTestRun(fx('vitest-real-fail.txt'));
  assert.deepEqual([v.runner, ...totals(v)], ['vitest', 4, 2, 1, 1], 'real vitest 5.1 output parses with its totals');
  const bad = suite(v, 'cart.test.js').tests[0];
  assert.deepEqual([bad.name, bad.status], ['cart > discount', 'failed'], 'a real vitest failure is named by its path');
  assert.match(bad.error, /expected 8 to be 7/, 'a real vitest failure carries its assertion');

  const p = parseTestRun(fx('pytest-real-fail.txt'));
  assert.deepEqual([p.runner, ...totals(p)], ['pytest', 5, 2, 2, 1], 'real pytest 9 output parses with its totals');
  assert.deepEqual(suite(p, 'test_cart.py').tests.map((t) => t.name), ['test_discount', 'TestCoupon.test_bad'], 'real pytest failures are named');
  assert.match(suite(p, 'test_cart.py').tests[1].error, /ValueError: bad coupon/, 'a real pytest failure carries its exception');
}
