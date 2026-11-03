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

const usageSpec = (env) => ({
  id: 'cursor',
  cli: 'agent',
  argv: [path.join(ROOT, 'scripts/mock-acp-cli.js'), 'acp'],
  modes: Object.fromEntries(['ask', 'edit', 'plan', 'bypass'].map((m) => [m, { env }])),
  binary: () => process.execPath,
});

async function acpUsage() {
  const { AcpSession, readingOf } = require(path.join(ROOT, 'src/main/providers/acp-session.js'));
  const open = async (env) => {
    const session = new AcpSession({ spec: usageSpec(env), cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'conn-usage-acp-')), mode: 'ask', model: 'mock-1' });
    const seen = [];
    session.on('message', (m) => seen.push(m));
    await session.start();
    const turn = async (text) => {
      const from = seen.length;
      const done = seen.filter((m) => m.type === 'result').length;
      session.send(text);
      await until(() => seen.filter((m) => m.type === 'result').length > done);
      return seen.slice(from);
    };
    return { session, seen, turn };
  };
  const readings = (msgs) => msgs.filter((m) => m.type === 'assistant' && m.message.usage);
  const WHY = 'this agent counts the window as one total, with no breakdown behind it';

  const billed = await open({ MOCK_ACP_USAGE: '1', MOCK_ACP_COST: 'USD', MOCK_ACP_TURN_USAGE: '1' });
  try {
    await check('acp-usage-before-any-reading-is-only-the-reason', async () => {
      assert.deepStrictEqual(await billed.session.contextUsage(), { error: WHY });
    });
    const first = await billed.turn('hello');
    await check('acp-usage-update-is-one-empty-main-thread-message', () => {
      const [one, ...more] = readings(first);
      assert.deepStrictEqual(more, [], 'more than one usage message in a turn');
      assert.deepStrictEqual(one.message.content, []);
      assert.strictEqual(one.parent_tool_use_id, null);
      assert.deepStrictEqual(one.message.usage, { input_tokens: 20000, context_window: 200000, cost_usd: 0.05 });
      assert.ok(first.indexOf(one) < first.findIndex((m) => m.type === 'result'), 'the reading came after the result');
    });
    await check('acp-usage-update-leaves-the-block-stream-balanced', () => balanced(blocks(first)));
    await check('acp-turn-usage-takes-the-cache-out-of-input', () => {
      const done = first.find((m) => m.type === 'result');
      assert.deepStrictEqual(done.modelUsage, { 'mock-1': { inputTokens: 400, outputTokens: 300, cacheReadInputTokens: 800, cacheCreationInputTokens: 0 } });
    });
    const second = await billed.turn('again');
    await check('acp-second-reading-moves-the-window', () => {
      assert.deepStrictEqual(readings(second)[0].message.usage, { input_tokens: 40000, context_window: 200000, cost_usd: 0.1 });
    });
    await check('acp-turn-usage-sums-across-turns', () => {
      assert.deepStrictEqual(second.find((m) => m.type === 'result').modelUsage['mock-1'], { inputTokens: 800, outputTokens: 600, cacheReadInputTokens: 1600, cacheCreationInputTokens: 0 });
    });
    await check('acp-context-usage-returns-used-and-size', async () => {
      assert.deepStrictEqual(await billed.session.contextUsage(), { totalTokens: 40000, rawMaxTokens: 200000, error: WHY });
    });
  } finally {
    billed.session.stop();
  }

  const euro = await open({ MOCK_ACP_USAGE: '1', MOCK_ACP_COST: 'EUR' });
  try {
    const turn = await euro.turn('hello');
    await check('acp-non-usd-cost-is-not-converted', () => {
      assert.deepStrictEqual(readings(turn)[0].message.usage, { input_tokens: 20000, context_window: 200000 });
    });
    await check('acp-no-turn-usage-means-no-model-usage', () => {
      assert.ok(!('modelUsage' in turn.find((m) => m.type === 'result')), 'modelUsage on a turn that reported none');
    });
  } finally {
    euro.session.stop();
  }

  const quiet = await open({});
  try {
    const turn = await quiet.turn('hello');
    await check('acp-turn-without-usage-sends-no-reading', async () => {
      assert.deepStrictEqual(readings(turn), []);
      assert.deepStrictEqual(await quiet.session.contextUsage(), { error: WHY });
      assert.ok(!turn.some((m) => m.type === 'result' && m.is_error), 'the turn errored');
    });
  } finally {
    quiet.session.stop();
  }

  await check('acp-cost-carries-forward-when-a-reading-omits-it', () => {
    const paid = readingOf({ used: 1, size: 10, cost: { amount: 0.5, currency: 'USD' } });
    assert.strictEqual(readingOf({ used: 2, size: 10 }, paid).costUSD, 0.5);
    assert.strictEqual(readingOf({ used: 2, size: 10, cost: { amount: 9, currency: 'EUR' } }, paid).costUSD, 0.5);
    assert.strictEqual(readingOf({ used: 2, size: 10, cost: { amount: 0, currency: 'USD' } }, paid).costUSD, 0);
    assert.strictEqual(readingOf({ used: 2, size: 10 }).costUSD, null);
  });
  await check('acp-garbage-reading-is-refused', () => {
    for (const bad of [null, {}, { used: '5', size: 10 }, { used: 5, size: 0 }, { used: -1, size: 10 }, { used: 5, size: NaN }, { used: 5 }]) {
      assert.strictEqual(readingOf(bad), null, JSON.stringify(bad));
    }
  });
}

async function acpMeter() {
  const { AcpSession } = require(path.join(ROOT, 'src/main/providers/acp-session.js'));
  const { usageOf } = require(path.join(ROOT, 'src/main/providers/acp-history.js'));
  const src = fs.readFileSync(path.join(ROOT, 'src/renderer/ui/lib/usage.js'), 'utf8');
  const lib = await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
  const feed = (msgs, from = { ...lib.blankUsage(), model: 'mock-1' }) => msgs.reduce(lib.account, from);
  const turnOf = async (env, turns) => {
    const session = new AcpSession({ spec: usageSpec(env), cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'conn-meter-acp-')), mode: 'ask', model: 'mock-1' });
    const seen = [];
    session.on('message', (m) => seen.push(m));
    try {
      await session.start();
      for (let i = 1; i <= turns; i++) {
        session.send('hello');
        await until(() => seen.filter((m) => m.type === 'result').length === i);
      }
    } finally {
      session.stop();
    }
    return seen;
  };

  const billed = await turnOf({ MOCK_ACP_USAGE: '1', MOCK_ACP_COST: 'USD', MOCK_ACP_TURN_USAGE: '1' }, 2);
  const firstTurn = billed.slice(0, billed.findIndex((m) => m.type === 'result') + 1);
  await check('acp-meter-fills-at-used-over-size', () => {
    const t = lib.totals(feed(firstTurn));
    assert.strictEqual(t.any, true);
    assert.strictEqual(t.context, 20000);
    assert.strictEqual(t.window, 200000);
    assert.strictEqual(t.percent, 10);
  });
  await check('acp-meter-moves-on-the-second-reading', () => {
    const t = lib.totals(feed(billed));
    assert.strictEqual(t.percent, 20);
    assert.strictEqual(t.turns, 2);
  });
  await check('acp-meter-shows-the-agents-own-usd-cost', () => {
    const t = lib.totals(feed(billed));
    assert.strictEqual(t.cost, 0.1);
    assert.strictEqual(t.unpriced, false);
    assert.strictEqual(t.estimated, false);
    assert.strictEqual(t.reported, true);
    assert.deepStrictEqual(t.rows.map((r) => [r.model, r.cost]), [['mock-1', 0]]);
    assert.strictEqual(t.cacheRead, 1600);
  });

  await check('acp-meter-with-no-cost-leaves-the-money-blank', async () => {
    const t = lib.totals(feed(await turnOf({ MOCK_ACP_USAGE: '1', MOCK_ACP_COST: 'EUR' }, 1)));
    assert.strictEqual(t.percent, 10);
    assert.strictEqual(t.unpriced, true, 'the pill would read $0');
    assert.strictEqual(t.cost, 0);
    assert.strictEqual(t.estimated, false);
  });
  await check('acp-meter-with-no-usage-stays-hidden', async () => {
    const t = lib.totals(feed(await turnOf({}, 1)));
    assert.strictEqual(t.any, false);
    assert.strictEqual(t.reported, false);
  });

  const reading = (used, cost_usd) => ({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [], usage: { input_tokens: used, context_window: 200000, ...(cost_usd != null && { cost_usd }) } } });
  await check('acp-meter-keeps-the-cost-when-a-later-reading-omits-it', () => {
    const t = lib.totals(feed([reading(10000, 0.3), reading(20000)]));
    assert.strictEqual(t.cost, 0.3);
    assert.strictEqual(t.unpriced, false);
  });
  await check('acp-meter-does-not-price-a-model-the-agent-already-priced', () => {
    const model = 'anthropic/claude-sonnet-4';
    const used = { type: 'result', subtype: 'success', modelUsage: { [model]: { inputTokens: 5000, outputTokens: 5000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } };
    const t = lib.totals(feed([reading(10000, 0.07), used], { ...lib.blankUsage(), model }));
    assert.strictEqual(t.cost, 0.07);
    assert.strictEqual(t.estimated, false);
    assert.deepStrictEqual(t.rows.map((r) => r.cost), [0]);
  });
  await check('acp-meter-believes-a-zero-cost', () => {
    const t = lib.totals(feed([reading(10000, 0)]));
    assert.strictEqual(t.unpriced, false);
    assert.strictEqual(t.cost, 0);
  });
  await check('acp-meter-survives-a-zero-result', () => {
    const t = lib.totals(feed([reading(10000, 0.3), { type: 'result', subtype: 'success', modelUsage: { 'mock-1': { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 } } }]));
    assert.strictEqual(t.percent, 5);
    assert.strictEqual(t.cost, 0.3);
    assert.strictEqual(t.turns, 1);
  });
  await check('acp-replayed-reading-draws-the-same-meter-as-live', () => {
    const replayed = usageOf([{ sessionUpdate: 'usage_update', used: 20000, size: 200000, cost: { amount: 0.05, currency: 'USD' } }]);
    const draws = (u) => {
      const t = lib.totals(u);
      return { percent: t.percent, window: t.window, cost: t.cost, unpriced: t.unpriced, estimated: t.estimated, reported: t.reported };
    };
    assert.deepStrictEqual(draws(feed([replayed], lib.blankUsage())), draws(feed(firstTurn)));
  });

  await check('codex-style-usage-leaves-the-meter-as-it-was', () => {
    const u = feed([{ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [], usage: { input_tokens: 5000, cache_read_input_tokens: 1000 } } }], { ...lib.blankUsage(), model: 'gpt-5.4' });
    assert.strictEqual(u.reported, null);
    const t = lib.totals(u);
    assert.strictEqual(t.reported, false);
    assert.strictEqual(t.window, 1_000_000);
    assert.strictEqual(t.context, 6000);
  });
  await check('claude-priced-by-list-price-is-unchanged', () => {
    const model = 'claude-sonnet-4-5-20250929';
    const t = lib.totals(feed([{ type: 'result', subtype: 'success', modelUsage: { [model]: { inputTokens: 1000, outputTokens: 1000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } }], { ...lib.blankUsage(), model }));
    assert.strictEqual(t.reported, false);
    assert.strictEqual(t.estimated, true);
    assert.strictEqual(t.unpriced, false);
    assert.ok(t.cost > 0);
  });
}

const todoCalls = (seen) => toolUses(seen).filter((b) => b.name === 'TodoWrite');
const statuses = (call) => call.input.todos.map((t) => t.status);

function answeredAtOnce(seen, calls) {
  calls.forEach((call) => {
    const at = seen.findIndex((m) => m.type === 'assistant' && m.message.content.some((b) => b.id === call.id));
    const next = seen[at + 1]?.message?.content?.[0];
    assert.ok(next?.type === 'tool_result' && next.tool_use_id === call.id, `no result straight after ${call.id}`);
    assert.strictEqual(next.is_error, false);
  });
}

async function acpPlan() {
  const { AcpSession } = require(path.join(ROOT, 'src/main/providers/acp-session.js'));
  const { foldUpdates } = require(path.join(ROOT, 'src/main/providers/acp-history.js'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-plan-acp-'));
  const spec = {
    id: 'cursor',
    cli: 'agent',
    argv: [path.join(ROOT, 'scripts/mock-acp-cli.js'), 'acp'],
    modes: Object.fromEntries(['ask', 'edit', 'plan', 'bypass'].map((m) => [m, { env: { MOCK_ACP_PLAN: '1' } }])),
    binary: () => process.execPath,
  };
  const session = new AcpSession({ spec, cwd, mode: 'ask', model: 'mock-1' });
  const seen = [];
  session.on('message', (m) => seen.push(m));
  try {
    await session.start();
    session.send('plan it');
    await until(() => seen.some((m) => m.type === 'result'));
    const calls = todoCalls(seen);

    await check('acp-plan-update-is-a-todowrite-per-update', () => {
      assert.strictEqual(calls.length, 2, JSON.stringify(calls));
      assert.strictEqual(new Set(calls.map((c) => c.id)).size, 2, 'the two updates share a call id');
      assert.deepStrictEqual(calls[0].input.todos[0], { content: 'Read the config', status: 'pending', priority: 'high' });
      assert.ok(!('explanation' in calls[0].input), 'an explanation appeared from nowhere');
    });
    await check('acp-plan-second-update-carries-the-ticked-state', () => {
      assert.deepStrictEqual(statuses(calls[0]), ['pending', 'pending', 'pending']);
      assert.deepStrictEqual(statuses(calls[1]), ['completed', 'in_progress', 'pending']);
    });
    await check('acp-plan-update-is-answered-at-once', () => answeredAtOnce(seen, calls));
    await check('acp-plan-keeps-the-token-stream-balanced', () => {
      const tokens = blocks(seen);
      assert.deepStrictEqual(tokens, ['tool_use', 'tool_result', 'tool_use', 'tool_result', 'start:text', 'd:text:Working on it.', 'stop', 'result']);
      balanced(tokens);
    });
    await check('acp-plan-replay-folds-the-same-calls', () => {
      const frames = (entries) => ({ sessionUpdate: 'plan', entries });
      const folded = foldUpdates([
        frames(calls[0].input.todos), frames(calls[1].input.todos),
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Working on it.' } },
      ]);
      const uses = folded.flatMap((m) => m.message.content).filter((b) => b.type === 'tool_use');
      assert.deepStrictEqual(uses.map((b) => [b.name, b.input]), calls.map((c) => ['TodoWrite', c.input]));
      assert.deepStrictEqual(folded.map((m) => m.message.content[0].type), ['tool_use', 'tool_result', 'tool_use', 'tool_result', 'text']);
    });
  } finally {
    session.stop();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function codexPlan() {
  const { CodexSession } = require(path.join(ROOT, 'src/main/codex.js'));
  const { preferBinary } = require(path.join(ROOT, 'src/main/codex-driver.js'));
  const history = require(path.join(ROOT, 'src/main/codex-history.js'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-plan-codex-'));
  const bin = path.join(cwd, 'codex');
  fs.writeFileSync(bin, `#!/bin/sh\nMOCK_CODEX_PLAN=1 exec "${process.execPath}" "${path.join(ROOT, 'scripts/mock-codex-cli.js')}" "$@"\n`);
  fs.chmodSync(bin, 0o755);
  preferBinary(bin);
  const session = new CodexSession({ cwd, mode: 'ask' });
  const seen = [];
  session.on('message', (m) => seen.push(m));
  try {
    await session.start();
    session.send('plan it');
    await until(() => seen.some((m) => m.type === 'result'));
    const calls = todoCalls(seen);
    const proposed = toolUses(seen).filter((b) => b.name === 'ExitPlanMode');

    await check('codex-plan-update-is-a-todowrite-per-update', () => {
      assert.strictEqual(calls.length, 2, JSON.stringify(calls));
      assert.strictEqual(new Set(calls.map((c) => c.id)).size, 2, 'the two updates share a call id');
      assert.deepStrictEqual(calls[0].input.todos[0], { content: 'Read the config', status: 'pending' });
      assert.strictEqual(calls[0].input.explanation, 'Start with the config');
      assert.ok(!('explanation' in calls[1].input), 'an absent explanation was invented');
    });
    await check('codex-plan-in-progress-arrives-as-in_progress', () => {
      assert.deepStrictEqual(statuses(calls[0]), ['pending', 'pending', 'pending']);
      assert.deepStrictEqual(statuses(calls[1]), ['completed', 'in_progress', 'pending']);
    });
    await check('codex-plan-update-is-answered-at-once', () => answeredAtOnce(seen, calls));
    await check('codex-plan-keeps-the-token-stream-balanced', () => {
      const tokens = blocks(seen);
      assert.deepStrictEqual(tokens, [
        'tool_use', 'tool_result', 'tool_use', 'tool_result',
        'start:text', 'd:text:Done ', 'd:text:editing.', 'stop',
        'tool_use', 'tool_result', 'result',
      ]);
      balanced(tokens);
    });
    await check('codex-plan-item-arrives-as-exitplanmode-with-the-full-text', () => {
      assert.strictEqual(proposed.length, 1, 'the plan item arrived more or less than once');
      assert.strictEqual(proposed[0].input.plan.split('\n').length, 7);
      assert.ok(proposed[0].input.plan.startsWith('# Proposed plan\n\n1. Read the config'), proposed[0].input.plan);
      assert.ok(proposed[0].input.plan.endsWith('- add a test'));
      answeredAtOnce(seen, proposed);
    });
    await check('codex-plan-replay-matches-live', async () => {
      const { messages } = await history.readSession(cwd, '00000000-0000-4000-8000-000000000000');
      const replayed = messages.flatMap((m) => m.message.content).filter((b) => b.type === 'tool_use');
      assert.deepStrictEqual(replayed.map((b) => [b.name, b.input]), proposed.map((b) => [b.name, b.input]));
      const result = messages.flatMap((m) => m.message.content).find((b) => b.type === 'tool_result');
      assert.strictEqual(result?.tool_use_id, replayed[0].id);
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
    rowAtAsk.push(filesFor(p.forId));
    session.decide(p.id, 'allow');
  });
  const filesFor = (id) => [
    ...toolUses(seen).filter((b) => b.id === id).map((b) => b.input.files),
    ...seen.filter((m) => m.type === 'tool_input' && m.tool_use_id === id).map((m) => m.input.files),
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
      const files = filesFor(editId).at(-1);
      assert.ok(files?.length, 'no files on the edit row');
      assert.ok(files.every((f) => typeof f.path === 'string' && Array.isArray(f.hunks)), JSON.stringify(files));
    });
    if (rowAtAsk.length) {
      await check(`${name}-waiting-edit-row-has-files-before-the-card`, () => {
        assert.ok(rowAtAsk[0].some((files) => files?.length), 'the row had no files when the permission arrived');
      });
    }
  } finally {
    session.stop();
  }
}

(async () => {
  for (const name of ['cursor', 'grok', 'opencode', 'copilot']) {
    await realAgent(name).catch((e) => { console.log(`FAIL ${name}: ${e.message}`); failures.push(name); });
  }
  await acp().catch((e) => { console.log(`FAIL acp: ${e.message}`); failures.push('acp'); });
  await codex().catch((e) => { console.log(`FAIL codex: ${e.message}`); failures.push('codex'); });
  await acpThink().catch((e) => { console.log(`FAIL acp-think: ${e.message}`); failures.push('acp-think'); });
  await codexReason().catch((e) => { console.log(`FAIL codex-reason: ${e.message}`); failures.push('codex-reason'); });
  await acpUsage().catch((e) => { console.log(`FAIL acp-usage: ${e.message}`); failures.push('acp-usage'); });
  await acpMeter().catch((e) => { console.log(`FAIL acp-meter: ${e.message}`); failures.push('acp-meter'); });
  await acpPlan().catch((e) => { console.log(`FAIL acp-plan: ${e.message}`); failures.push('acp-plan'); });
  await codexPlan().catch((e) => { console.log(`FAIL codex-plan: ${e.message}`); failures.push('codex-plan'); });
  if (failures.length) {
    console.log(`\n${failures.length} failure(s)`);
    process.exit(1);
  }
  console.log('\nall passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
