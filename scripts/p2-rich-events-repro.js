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

function blocks(msgs) {
  return msgs.flatMap((m) => {
    const e = m.event;
    if (m.type === 'stream_event' && e.type === 'content_block_start') return [`start:${e.content_block.type}`];
    if (m.type === 'stream_event' && e.type === 'content_block_stop') return ['stop'];
    if (m.type === 'stream_event' && e.type === 'content_block_delta') {
      return [e.delta.type === 'thinking_delta' ? `d:thinking:${e.delta.thinking}` : `d:text:${e.delta.text}`];
    }
    if (m.type === 'assistant') return m.message.content.filter((b) => b.type === 'tool_use').map(() => 'tool_use');
    if (m.type === 'user') return m.message.content.filter((b) => b.type === 'tool_result').map(() => 'tool_result');
    if (m.type === 'result') return ['result'];
    return [];
  });
}

function balanced(tokens) {
  let open = null;
  tokens.forEach((t, i) => {
    const [what, kind] = t.split(':', 2);
    if (what === 'start') {
      assert.strictEqual(open, null, `${t} at ${i} while ${open} is open`);
      open = kind;
    } else if (what === 'stop') {
      assert.ok(open, `stop at ${i} with nothing open`);
      open = null;
    } else if (what === 'd') {
      assert.strictEqual(open, kind, `${kind} delta at ${i} inside ${open}`);
    } else if (what === 'tool_use' || what === 'result') {
      assert.strictEqual(open, null, `${what} at ${i} while ${open} is open`);
    }
  });
}

const indexOfRun = (tokens, run) => tokens.findIndex((_, i) => run.every((t, j) => tokens[i + j] === t));
const thinking = (tokens) => tokens.filter((t) => t.startsWith('d:thinking:')).map((t) => t.slice('d:thinking:'.length));
const blockTexts = (tokens) => tokens.reduce((out, t) => {
  const [what, kind] = t.split(':', 2);
  if (what === 'start') out.push(`${kind}:`);
  if (what === 'd') out[out.length - 1] += t.slice(`d:${kind}:`.length);
  return out;
}, []);

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

async function acpThink() {
  const { AcpSession } = require(path.join(ROOT, 'src/main/providers/acp-session.js'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-think-acp-'));
  const spec = {
    id: 'cursor',
    cli: 'agent',
    argv: [path.join(ROOT, 'scripts/mock-acp-cli.js'), 'acp'],
    modes: Object.fromEntries(['ask', 'edit', 'plan', 'bypass'].map((m) => [m, { env: { MOCK_ACP_THINK: '1' } }])),
    binary: () => process.execPath,
  };
  const session = new AcpSession({ spec, cwd, mode: 'ask', model: 'mock-1' });
  const seen = [];
  session.on('message', (m) => seen.push(m));
  try {
    await session.start();
    session.send('think it through');
    await until(() => seen.some((m) => m.type === 'result'));

    await check('acp-thought-and-message-alternate', () => {
      const tokens = blocks(seen);
      assert.deepStrictEqual(tokens, [
        'start:thinking', 'd:thinking:Looking ', 'd:thinking:around', 'stop',
        'start:text', 'd:text:Found it.', 'stop',
        'start:thinking', 'd:thinking:Now run it', 'stop',
        'tool_use', 'tool_result',
        'start:thinking', 'd:thinking:It worked', 'stop',
        'start:text', 'd:text:Done.', 'stop',
        'result',
      ]);
      balanced(tokens);
    });
    await check('acp-tool-call-closes-an-open-thought', () => {
      const tokens = blocks(seen);
      assert.ok(indexOfRun(tokens, ['d:thinking:Now run it', 'stop', 'tool_use']) >= 0, tokens.join(' | '));
    });

    const mark = seen.length;
    session.send('think hang');
    await check('acp-stop-mid-thought', async () => {
      await until(() => blocks(seen.slice(mark)).includes('d:thinking:Looking '));
      await session.interrupt();
      await until(() => seen.slice(mark).some((m) => m.type === 'result'));
      const tokens = blocks(seen.slice(mark));
      assert.deepStrictEqual(tokens, ['start:thinking', 'd:thinking:Looking ', 'stop', 'result']);
      assert.strictEqual(seen.at(-1).subtype, 'cancelled');
      balanced(tokens);
    });
  } finally {
    session.stop();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function codexReason() {
  const { CodexSession } = require(path.join(ROOT, 'src/main/codex.js'));
  const { preferBinary } = require(path.join(ROOT, 'src/main/codex-driver.js'));
  const history = require(path.join(ROOT, 'src/main/codex-history.js'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-reason-codex-'));
  const bin = path.join(cwd, 'codex');
  fs.writeFileSync(bin, `#!/bin/sh\nMOCK_CODEX_REASON=1 exec "${process.execPath}" "${path.join(ROOT, 'scripts/mock-codex-cli.js')}" "$@"\n`);
  fs.chmodSync(bin, 0o755);
  preferBinary(bin);
  const session = new CodexSession({ cwd, mode: 'ask' });
  const seen = [];
  session.on('message', (m) => seen.push(m));
  try {
    await session.start();
    session.send('think it through');
    await until(() => seen.some((m) => m.type === 'result'));
    const tokens = blocks(seen);
    const shown = tokens.join(' | ');

    await check('codex-reasoning-streams-then-message', () => {
      const first = ['start:thinking', 'd:thinking:Reading ', 'd:thinking:the file', 'd:thinking:\n\nThen edit', 'stop', 'start:text'];
      assert.strictEqual(indexOfRun(tokens, first), 0, shown);
      balanced(tokens);
    });
    await check('codex-reasoning-without-deltas-arrives-whole', () => {
      assert.ok(indexOfRun(tokens, ['start:thinking', 'd:thinking:Whole', 'stop']) >= 0, shown);
      assert.strictEqual(thinking(tokens).filter((t) => t === 'Whole').length, 1, shown);
    });
    await check('codex-empty-reasoning-has-no-text', () => {
      assert.ok(indexOfRun(tokens, ['d:thinking:Whole', 'stop', 'start:thinking', 'stop', 'start:thinking']) >= 0, shown);
      assert.ok(!thinking(tokens).includes(''), 'an empty thinking delta went out');
    });
    await check('codex-force-closed-thought-is-not-repeated', () => {
      assert.deepStrictEqual(tokens.slice(-6), ['start:thinking', 'd:thinking:Peek', 'stop', 'tool_use', 'tool_result', 'result'], shown);
    });
    await check('codex-no-thinking-in-assistant-messages', () => {
      assert.ok(thinking(tokens).length, 'no thinking reached the stream');
      const whole = seen.filter((m) => m.type === 'assistant').flatMap((m) => m.message.content).filter((b) => b.type === 'thinking');
      assert.deepStrictEqual(whole, []);
    });
    await check('codex-reasoning-replay-matches-live', async () => {
      const { messages } = await history.readSession(cwd, '00000000-0000-4000-8000-000000000000');
      const replayed = messages.flatMap((m) => m.message.content)
        .map((b) => (b.type === 'thinking' ? `thinking:${b.thinking}` : `${b.type}:${b.text}`));
      assert.deepStrictEqual(replayed, ['thinking:Reading the file\n\nThen edit', 'text:Done editing.']);
      assert.deepStrictEqual(blockTexts(tokens).slice(0, 2), replayed, 'replayed blocks equal the live ones');
    });

    const mark = seen.length;
    session.send('hang');
    await check('codex-stop-mid-reasoning', async () => {
      await until(() => blocks(seen.slice(mark)).includes('d:thinking:Halfway'));
      await session.interrupt();
      await until(() => seen.slice(mark).some((m) => m.type === 'result'));
      const tail = blocks(seen.slice(mark));
      assert.deepStrictEqual(tail, ['start:thinking', 'd:thinking:Halfway', 'stop', 'result']);
      balanced(tail);
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
  await acpThink().catch((e) => { console.log(`FAIL acp-think: ${e.message}`); failures.push('acp-think'); });
  await codexReason().catch((e) => { console.log(`FAIL codex-reason: ${e.message}`); failures.push('codex-reason'); });
  if (failures.length) {
    console.log(`\n${failures.length} failure(s)`);
    process.exit(1);
  }
  console.log('\nall passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
