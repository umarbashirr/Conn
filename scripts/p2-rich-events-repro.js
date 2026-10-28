'use strict';
/* Codex and ACP edits reach the panel as `input.files` (CUX-12), however the
   agent said them. An ACP tool call with diff content, and Codex fileChange
   items of every kind, both arrive as tool_use rows and permission requests
   carrying `{ files: [{ path, kind, movePath, hunks: [{ before, after }] }] }`,
   and a Codex chat read back from history carries the same files as the one
   that ran. Runs the real sessions against the mock CLIs; no window needed. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = process.env.CONN_ROOT || path.join(__dirname, '..');
const failures = [];
const check = (name, fn) => Promise.resolve().then(fn).then(
  () => console.log(`PASS ${name}`),
  (e) => { console.log(`FAIL ${name}: ${e.message}`); failures.push(name); },
);

function until(fn, ms = 8000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const v = fn();
      if (v) return resolve(v);
      if (Date.now() - start > ms) return reject(new Error('timed out'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

const toolUses = (seen) => seen.flatMap((m) => (m.type === 'assistant' ? m.message.content : []).filter((b) => b.type === 'tool_use'));
const resultOf = (seen, id) => seen
  .flatMap((m) => (m.type === 'user' ? m.message.content : []))
  .find((b) => b.type === 'tool_result' && b.tool_use_id === id);

async function acp() {
  const { AcpSession } = require(path.join(ROOT, 'src/main/providers/acp-session.js'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-rich-acp-'));
  const spec = {
    id: 'cursor',
    cli: 'agent',
    argv: [path.join(ROOT, 'scripts/mock-acp-cli.js'), 'acp'],
    modes: Object.fromEntries(['ask', 'edit', 'plan', 'bypass'].map((m) => [m, { env: { MOCK_ACP_RICH: '1' } }])),
    binary: () => process.execPath,
  };
  const session = new AcpSession({ spec, cwd, mode: 'ask', model: 'mock-1' });
  const seen = [];
  const asked = [];
  session.on('message', (m) => seen.push(m));
  session.on('permission', (p) => asked.push(p));
  const files = [
    { path: `${cwd}/style.css`, kind: 'update', movePath: null, hunks: [{ before: 'button {\n  color: blue;\n  margin: 0;\n}\n', after: 'button {\n  color: red;\n  margin: 0;\n}\n' }] },
    { path: `${cwd}/notes.txt`, kind: 'add', movePath: null, hunks: [{ before: '', after: 'first line\nsecond line\n' }] },
  ];
  try {
    await session.start();
    session.send('change the button to red');
    await until(() => asked.length);

    await check('acp-tool-row-is-an-edit-with-files', () => {
      const call = toolUses(seen).find((b) => b.id === 't-rich');
      assert.ok(call, 'no tool_use for the diff call');
      assert.strictEqual(call.name, 'Edit');
      assert.deepStrictEqual(call.input.files, files);
    });
    await check('acp-permission-carries-the-same-files', () => {
      assert.strictEqual(asked[0].tool, 'Edit');
      assert.strictEqual(asked[0].forId, 't-rich');
      assert.deepStrictEqual(asked[0].input.files, files);
    });

    session.decide(asked[0].id, 'allow');
    await until(() => seen.some((m) => m.type === 'result'));
    await check('acp-update-with-diff-content-carries-files-too', () => {
      const update = seen.find((m) => m.type === 'tool_input' && m.tool_use_id === 't-rich');
      assert.ok(update, 'no tool_input for the completed call');
      assert.deepStrictEqual(update.input.files, files);
    });
    await check('acp-result-names-the-files-not-the-json', () => {
      const out = resultOf(seen, 't-rich');
      assert.ok(out, 'no tool_result');
      assert.strictEqual(out.content, `${cwd}/style.css\n${cwd}/notes.txt`);
    });
  } finally {
    session.stop();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function codex() {
  const { CodexSession } = require(path.join(ROOT, 'src/main/codex.js'));
  const { preferBinary } = require(path.join(ROOT, 'src/main/codex-driver.js'));
  const history = require(path.join(ROOT, 'src/main/codex-history.js'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-rich-codex-'));
  const bin = path.join(cwd, 'codex');
  fs.writeFileSync(bin, `#!/bin/sh\nMOCK_CODEX_EDITS=1 exec "${process.execPath}" "${path.join(ROOT, 'scripts/mock-codex-cli.js')}" "$@"\n`);
  fs.chmodSync(bin, 0o755);
  preferBinary(bin);
  const session = new CodexSession({ cwd, mode: 'ask' });
  const seen = [];
  const asked = [];
  session.on('message', (m) => seen.push(m));
  session.on('permission', (p) => asked.push(p));
  const want = {
    'mock-add': [{ path: '/proj/notes.txt', kind: 'add', movePath: null, hunks: [{ before: '', after: 'first line\nsecond line\n' }] }],
    'mock-delete': [{ path: '/proj/old.txt', kind: 'delete', movePath: null, hunks: [{ before: 'goodbye\nworld\n', after: '' }] }],
    'mock-move': [{
      path: '/proj/src/a.js',
      kind: 'update',
      movePath: '/proj/lib/a.js',
      hunks: [{ before: 'const a = 1;\nexport default a;\nconst b = 2;', after: 'const a = 1;\nmodule.exports = a;\nconst b = 2;' }],
    }],
    'mock-update': [{
      path: '/proj/style.css',
      kind: 'update',
      movePath: null,
      hunks: [
        { before: 'button {\n  color: blue;\n  margin: 0;\n}', after: 'button {\n  color: red;\n  margin: 0;\n}' },
        { before: 'a {\n  color: green;\n}', after: 'a {\n  color: green;\n  text-decoration: none;\n}' },
      ],
    }],
  };
  try {
    await session.start();
    session.send('edit four files');
    await until(() => asked.length);

    await check('codex-live-rows-carry-files-of-every-kind', () => {
      const uses = toolUses(seen);
      for (const [id, files] of Object.entries(want)) {
        const call = uses.find((b) => b.id === id);
        assert.ok(call, `no tool_use for ${id}`);
        assert.strictEqual(call.name, 'Edit');
        assert.deepStrictEqual(call.input, { files }, `${id} input`);
      }
    });
    await check('codex-approval-carries-the-same-files', () => {
      assert.strictEqual(asked[0].tool, 'Edit');
      assert.strictEqual(asked[0].forId, 'mock-update');
      assert.deepStrictEqual(asked[0].input, { files: want['mock-update'] });
    });

    session.decide(asked[0].id, 'allow');
    await until(() => seen.some((m) => m.type === 'result'));

    await check('codex-replay-matches-live', async () => {
      const { messages } = await history.readSession(cwd, '00000000-0000-4000-8000-000000000000');
      const uses = messages.flatMap((m) => (m.message?.content || []).filter((b) => b.type === 'tool_use'));
      assert.deepStrictEqual(uses.map((b) => b.id), Object.keys(want));
      for (const call of uses) assert.deepStrictEqual(call.input, { files: want[call.id] }, `${call.id} replayed input`);
      const live = toolUses(seen).map((b) => [b.id, b.input]);
      assert.deepStrictEqual(uses.map((b) => [b.id, b.input]), live, 'replayed rows equal the live ones');
    });
    await check('codex-result-lists-paths', () => {
      assert.strictEqual(resultOf(seen, 'mock-update')?.content, '/proj/style.css');
    });
  } finally {
    session.stop();
    history.close();
    preferBinary(null);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function realAgent(name) {
  const { AcpSession } = require(path.join(ROOT, 'src/main/providers/acp-session.js'));
  const fixture = path.join(ROOT, 'scripts/fixtures/acp-real', `${name}.json`);
  const { frames } = JSON.parse(fs.readFileSync(fixture, 'utf8'));
  const edit = frames.find(([, f]) => (f.content || f.toolCall?.content || []).some((c) => c?.type === 'diff'));
  const editId = edit[1].toolCallId || edit[1].toolCall.toolCallId;
  const spec = {
    id: name,
    cli: name,
    argv: [path.join(ROOT, 'scripts/mock-acp-cli.js'), 'acp'],
    modes: Object.fromEntries(['ask', 'edit', 'plan', 'bypass'].map((m) => [m, { env: { MOCK_ACP_REPLAY: fixture } }])),
    binary: () => process.execPath,
  };
  const session = new AcpSession({ spec, cwd: fs.mkdtempSync(path.join(os.tmpdir(), `conn-real-${name}-`)), mode: 'ask', model: 'mock-1' });
  const seen = [];
  const rowAtAsk = [];
  session.on('message', (m) => seen.push(m));
  session.on('permission', (p) => {
    rowAtAsk.push(seen.filter((m) => m.type === 'tool_input' && m.tool_use_id === p.forId));
    session.decide(p.id, 'allow');
  });
  const filesFor = () => [
    ...toolUses(seen).filter((b) => b.id === editId).map((b) => b.input.files),
    ...seen.filter((m) => m.type === 'tool_input' && m.tool_use_id === editId).map((m) => m.input.files),
  ].filter(Boolean);
  try {
    await session.start();
    session.send('change beta to BETA in notes.txt');
    await until(() => seen.some((m) => m.type === 'result'));

    await check(`${name}-edit-row-is-named-edit`, () => {
      const call = toolUses(seen).find((b) => b.id === editId);
      assert.ok(call, 'no tool_use for the edit call');
      assert.strictEqual(call.name, 'Edit');
    });
    await check(`${name}-edit-row-gets-files`, () => {
      const files = filesFor().at(-1);
      assert.ok(files?.length, 'no files on the edit row');
      assert.ok(files.every((f) => typeof f.path === 'string' && Array.isArray(f.hunks)), JSON.stringify(files));
    });
    if (rowAtAsk.length) {
      await check(`${name}-waiting-edit-row-has-files-before-the-card`, () => {
        assert.ok(rowAtAsk[0].some((m) => m.input.files?.length), 'the row had no files when the permission arrived');
      });
    }
  } finally {
    session.stop();
  }
}

(async () => {
  for (const name of ['cursor', 'grok', 'opencode']) {
    await realAgent(name).catch((e) => { console.log(`FAIL ${name}: ${e.message}`); failures.push(name); });
  }
  await acp().catch((e) => { console.log(`FAIL acp: ${e.message}`); failures.push('acp'); });
  await codex().catch((e) => { console.log(`FAIL codex: ${e.message}`); failures.push('codex'); });
  if (failures.length) {
    console.log(`\n${failures.length} failure(s)`);
    process.exit(1);
  }
  console.log('\nall passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
