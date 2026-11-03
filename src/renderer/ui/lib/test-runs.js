// A test run read out of a command's output. The data shape:
//   { runner, total, passed, failed, skipped,
//     suites: [{ name, passed, failed, skipped, tests: [{ name, status, error? }] }] }
// The totals and each suite's counts come from what the runner printed. `tests`
// is only the tests the output named, so a suite can count more tests than it
// lists (jest and vitest name just the failures unless run verbose).
// A false positive hides output behind a summary that is wrong, so each runner
// needs its summary line and a second mark that only that runner prints.
import { stripAnsi } from './stacks.js';

const TIMING = /\s+\(\d+(?:\.\d+)?\s?m?s\)$/;

const trimBlock = (lines) => {
  const out = [...lines];
  while (out.length && !out[0].trim()) out.shift();
  while (out.length && !out.at(-1).trim()) out.pop();
  const indent = Math.min(...out.filter((l) => l.trim()).map((l) => l.search(/\S/)));
  return out.map((l) => l.slice(Number.isFinite(indent) ? indent : 0)).join('\n');
};

const indentOf = (line) => line.search(/\S|$/);

function tally(text, words) {
  const got = {};
  for (const [, n, word] of text.matchAll(new RegExp(`(\\d+) (${words.join('|')})`, 'g'))) got[word] = (got[word] || 0) + Number(n);
  return got;
}

// Suites keep first-seen order, and their counts follow their tests unless the
// runner printed counts of its own.
function suites() {
  const list = [];
  const byName = new Map();
  return {
    list,
    get(name) {
      if (!byName.has(name)) {
        const s = { name, passed: 0, failed: 0, skipped: 0, tests: [] };
        byName.set(name, s);
        list.push(s);
      }
      return byName.get(name);
    },
    add(name, test) {
      const s = this.get(name);
      s.tests.push(test);
      s[test.status] += 1;
      return test;
    },
  };
}

function nodeTest(lines) {
  const summary = lines.findIndex((l) => /^ℹ tests \d+$/.test(l));
  if (summary < 0 || !lines.some((l) => /^ℹ duration_ms /.test(l))) return null;
  const num = (key) => Number(lines.find((l) => l.startsWith(`ℹ ${key} `))?.slice(key.length + 3)) || 0;

  const all = suites();
  const open = [];
  for (const line of lines.slice(0, summary)) {
    const m = /^(\s*)(▶|✔|✖|﹣)\s+(.*)$/.exec(line);
    if (!m) continue;
    const indent = m[1].length;
    const label = m[3].replace(/\s+# (SKIP|TODO).*$/, '').replace(TIMING, '');
    if (m[2] === '▶') { open.push({ indent, name: label }); continue; }
    const top = open.at(-1);
    if (top && top.indent === indent && top.name === label) { open.pop(); continue; }
    const status = m[2] === '✔' ? 'passed' : m[2] === '✖' ? 'failed' : 'skipped';
    all.add(open.length ? open.map((s) => s.name).join(' > ') : 'Tests', { name: label, status });
  }

  const failing = lines.findIndex((l) => l.startsWith('✖ failing tests:'));
  if (failing >= 0) {
    let current = null;
    const flush = () => {
      if (!current) return;
      const test = all.list.flatMap((s) => s.tests).find((t) => t.status === 'failed' && t.name === current.name && !t.error);
      const error = trimBlock(current.body);
      if (test && error) test.error = error;
      current = null;
    };
    for (const line of lines.slice(failing + 1)) {
      if (/^test at /.test(line)) { flush(); current = { name: null, body: [] }; continue; }
      if (!current) continue;
      const head = /^✖ (.*)$/.exec(line);
      if (head && current.name === null) current.name = head[1].replace(TIMING, '');
      else if (current.name !== null) current.body.push(line);
    }
    flush();
  }

  return {
    runner: 'node:test',
    total: num('tests'),
    passed: num('pass'),
    failed: num('fail') + num('cancelled'),
    skipped: num('skipped') + num('todo'),
    suites: all.list,
  };
}

function jest(lines) {
  const sumAt = lines.findIndex((l) => /^Tests:\s+.*\btotal\s*$/.test(l));
  if (sumAt < 0 || !lines.some((l) => /^Test Suites:\s/.test(l))) return null;
  const got = tally(lines[sumAt], ['failed', 'passed', 'skipped', 'todo', 'total']);

  const firstFailure = lines.findIndex((l) => /^\s*● /.test(l));
  const listEnd = firstFailure >= 0 ? firstFailure : sumAt;
  const all = suites();
  const crumbs = [];
  for (const line of lines.slice(0, listEnd)) {
    const mark = /^(\s+)(✓|✕|○|✔|✘)\s+(?:skipped\s+)?(.*?)\s*$/.exec(line);
    if (mark) {
      const status = mark[2] === '✓' || mark[2] === '✔' ? 'passed' : mark[2] === '✕' || mark[2] === '✘' ? 'failed' : 'skipped';
      all.add(crumbs.map((c) => c.name).join(' › ') || 'Tests', { name: mark[3].replace(TIMING, ''), status });
      continue;
    }
    const head = /^(\s+)(\S.*?)\s*$/.exec(line);
    if (!head) continue;
    while (crumbs.length && crumbs.at(-1).indent >= head[1].length) crumbs.pop();
    crumbs.push({ indent: head[1].length, name: head[2] });
  }
  const verbose = all.list.length > 0;

  let current = null;
  const flush = () => {
    if (!current) return;
    const parts = current.title.split(' › ');
    const name = parts.pop();
    const suite = parts.join(' › ') || 'Tests';
    const error = trimBlock(current.body);
    const known = verbose && all.get(suite).tests.find((t) => t.name === name && t.status === 'failed' && !t.error);
    if (known) known.error = error;
    else if (!verbose) all.add(suite, { name, status: 'failed', error });
    else all.add(suite, { name, status: 'failed', error });
    current = null;
  };
  for (const line of lines.slice(listEnd, sumAt)) {
    const head = /^\s*● (.+?)\s*$/.exec(line);
    if (head) {
      flush();
      if (head[1] !== 'Console') current = { title: head[1], body: [] };
      else current = null;
    } else if (current && !/^(Test Suites|Snapshot Summary):/.test(line)) {
      current.body.push(line);
    }
  }
  flush();

  if (verbose) {
    for (const s of all.list) s.failed = s.tests.filter((t) => t.status === 'failed').length;
  }
  return {
    runner: 'jest',
    total: got.total,
    passed: got.passed || 0,
    failed: got.failed || 0,
    skipped: (got.skipped || 0) + (got.todo || 0),
    suites: all.list,
  };
}

function vitest(lines) {
  const sumAt = lines.findIndex((l) => /^\s*Tests\s+.*\(\d+\)\s*$/.test(l));
  if (sumAt < 0 || !lines.some((l) => /^\s*Test Files\s+/.test(l))) return null;
  const got = tally(lines[sumAt], ['failed', 'passed', 'skipped', 'todo']);
  const total = Number(/\((\d+)\)\s*$/.exec(lines[sumAt])[1]);

  const all = suites();
  const failureAt = lines.findIndex((l) => /^\s*FAIL\s+\S+ > /.test(l));
  for (const line of lines.slice(0, failureAt >= 0 ? failureAt : sumAt)) {
    const file = /^\s*(?:✓|❯|↓|×)\s+(\S+\.[cm]?[jt]sx?)\s+\((\d+) tests?(?:\s*\|\s*([^)]*))?\)/.exec(line);
    if (file) {
      const s = all.get(file[1]);
      const n = tally(file[3] || '', ['failed', 'skipped', 'todo']);
      s.failed = n.failed || 0;
      s.skipped = (n.skipped || 0) + (n.todo || 0);
      s.passed = Number(file[2]) - s.failed - s.skipped;
      continue;
    }
    const one = /^\s*(✓|×|↓)\s+(\S+\.[cm]?[jt]sx?) > (.+?)(?:\s+\d+ms)?\s*$/.exec(line);
    if (one) {
      all.add(one[2], { name: one[3], status: one[1] === '✓' ? 'passed' : one[1] === '×' ? 'failed' : 'skipped' });
    }
  }

  let current = null;
  const flush = () => {
    if (!current) return;
    const error = trimBlock(current.body);
    const s = all.get(current.file);
    const known = s.tests.find((t) => t.name === current.name && t.status === 'failed');
    if (known) known.error = error;
    else s.tests.push({ name: current.name, status: 'failed', error });
    current = null;
  };
  for (const line of lines.slice(failureAt >= 0 ? failureAt : sumAt, sumAt)) {
    const head = /^\s*FAIL\s+(\S+) > (.+?)\s*$/.exec(line);
    if (head) { flush(); current = { file: head[1], name: head[2], body: [] }; continue; }
    if (/^\s*⎯{3,}/.test(line)) { flush(); continue; }
    if (current) current.body.push(line);
  }
  flush();

  return {
    runner: 'vitest',
    total,
    passed: got.passed || 0,
    failed: got.failed || 0,
    skipped: (got.skipped || 0) + (got.todo || 0),
    suites: all.list,
  };
}

function pytest(lines) {
  const sumAt = lines.findLastIndex((l) => /^(=+ )?\d+ (passed|failed|skipped|errors?|xfailed|xpassed|deselected|warnings?)\b.* in \d+(\.\d+)?s\b.*$/.test(l.trim()));
  if (sumAt < 0) return null;
  const progress = lines.some((l) => /^\S+\.py \S+\s+(\[\s*\d+%\])?\s*$/.test(l) && /[.FEsxXR]/.test(l));
  const verbose = lines.some((l) => /^\S+\.py::\S+ (PASSED|FAILED|SKIPPED|XFAIL|XPASS|ERROR)\b/.test(l));
  if (!lines.some((l) => /^=+ test session starts =+$/.test(l)) && !progress && !verbose) return null;

  const got = tally(lines[sumAt], ['passed', 'failed', 'skipped', 'errors?', 'xfailed', 'xpassed']);
  const failed = (got.failed || 0) + (got.error || 0) + (got.errors || 0);
  const passed = (got.passed || 0) + (got.xpassed || 0);
  const skipped = (got.skipped || 0) + (got.xfailed || 0);

  const all = suites();
  const STATUS = { '.': 'passed', X: 'passed', F: 'failed', E: 'failed', s: 'skipped', x: 'skipped', R: 'skipped' };
  const VSTATUS = { PASSED: 'passed', XPASS: 'passed', FAILED: 'failed', ERROR: 'failed', SKIPPED: 'skipped', XFAIL: 'skipped' };
  for (const line of lines.slice(0, sumAt)) {
    const dots = /^(\S+?\.py)\s+([.FEsxXR]+)\s*(?:\[\s*\d+%\])?\s*$/.exec(line);
    if (dots) {
      const s = all.get(dots[1]);
      for (const ch of dots[2]) s[STATUS[ch]] += 1;
      continue;
    }
    const v = /^(\S+?\.py)::(\S+)\s+(PASSED|FAILED|SKIPPED|XFAIL|XPASS|ERROR)\b/.exec(line);
    if (v) all.add(v[1], { name: v[2].replace(/::/g, ' > '), status: VSTATUS[v[3]] });
  }

  const fileOf = new Map();
  for (const line of lines) {
    const m = /^(?:FAILED|ERROR) (\S+?\.py)::(\S+?)(?: - .*)?$/.exec(line);
    if (m) fileOf.set(m[2].split('::').join('.'), m[1]);
  }
  const section = lines.findIndex((l) => /^=+ (FAILURES|ERRORS) =+$/.test(l));
  if (section >= 0) {
    let current = null;
    const flush = () => {
      if (!current) return;
      const error = trimBlock(current.body);
      const file = fileOf.get(current.name)
        || all.list.find((s) => s.failed > s.tests.filter((t) => t.status === 'failed').length)?.name
        || 'Tests';
      const s = all.get(file);
      const known = s.tests.find((t) => t.status === 'failed' && (t.name === current.name || t.name.replace(/ > /g, '.') === current.name));
      if (known) known.error = error;
      else s.tests.push({ name: current.name, status: 'failed', error });
      current = null;
    };
    for (const line of lines.slice(section + 1, sumAt)) {
      const head = /^_{2,} (.+?) _{2,}$/.exec(line);
      if (head) { flush(); current = { name: head[1], body: [] }; continue; }
      if (/^=+ .* =+$/.test(line)) { flush(); break; }
      if (current) current.body.push(line);
    }
    flush();
  }

  return { runner: 'pytest', total: failed + passed + skipped, passed, failed, skipped, suites: all.list };
}

const seen = new Map();
const SEEN_LIMIT = 40;

// A row re-renders while its output streams in, and the same text should not
// be read again for each of those.
export function parseTestRun(text) {
  if (typeof text !== 'string' || text.length < 20) return null;
  if (seen.has(text)) return seen.get(text);
  const lines = stripAnsi(text).replace(/\r\n/g, '\n').split('\n');
  const run = nodeTest(lines) || jest(lines) || vitest(lines) || pytest(lines);
  const result = run && run.total > 0 ? run : null;
  if (seen.size >= SEEN_LIMIT) seen.delete(seen.keys().next().value);
  seen.set(text, result);
  return result;
}

export function testSummary(run) {
  const bits = [`${run.total} ${run.total === 1 ? 'test' : 'tests'}`];
  if (run.failed) bits.push(`${run.failed} failed`);
  if (run.skipped) bits.push(`${run.skipped} skipped`);
  return bits.join(', ');
}
