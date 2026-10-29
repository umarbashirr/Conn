'use strict';
/* The agent's thinking is one row that folds when it is done (CUX-14). Events
   arrive in Claude's order: the thinking block opens, its deltas stream, the
   whole assistant message repeats the block, then the block stops. Needs a
   built renderer: `npx vite build` first. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { pathToFileURL } = require('url');

const ROOT = process.env.CONN_ROOT || path.join(__dirname, '..');
const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
};

const REPLAY_TITLE = 'Replay me a thought';

function seedReplay(s) {
  const dir = path.join(s.home, '.claude', 'projects', s.project.replace(/[/.]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const id = randomUUID();
  const at = Date.now() - 60000;
  let parentUuid = null;
  const line = (type, content, i) => {
    const uuid = randomUUID();
    const o = { type, uuid, parentUuid, sessionId: id, cwd: s.project, timestamp: new Date(at + i * 1000).toISOString(), message: { role: type, content } };
    parentUuid = uuid;
    return J(o);
  };
  const lines = [
    line('user', REPLAY_TITLE, 0),
    line('assistant', [{ type: 'thinking', thinking: '', signature: 'sig-only' }], 1),
    line('assistant', [{ type: 'thinking', thinking: 'Saved with its text.', signature: 'sig' }], 2),
    line('assistant', [{ type: 'text', text: 'Replayed answer.' }], 3),
  ];
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), `${lines.join('\n')}\n`);
}

async function main() {
  const drive = await import(pathToFileURL(path.join(ROOT, '.claude/skills/verify/drive.mjs')).href);
  const { boot, stop, evaluate, click, say, shot } = drive;
  const s = await boot({ root: ROOT, xvfb: true });

  try {
    const emit = (msg) => evaluate(s, `globalThis.__agent.emit('message', ${J(msg)})`, { main: true });
    const ev = (event) => emit({ type: 'stream_event', parent_tool_use_id: null, event });
    const whole = (content) => emit({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content } });
    const finish = () => emit({ type: 'result', subtype: 'success', duration_ms: 1200 });
    const begin = () => emit({ type: 'system', subtype: 'init', parent_tool_use_id: null });

    const start = () => ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
    const delta = (thinking) => ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } });
    const sign = () => ev({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } });
    const blockStop = () => ev({ type: 'content_block_stop', index: 0 });
    const think = async (...chunks) => {
      await start();
      for (const c of chunks) await delta(c);
    };

    // Each reasoning row is the button around its brain icon; its body is the button's parent.
    const rows = () => evaluate(s, `[...document.querySelectorAll('#agent-root svg.lucide-brain')].map((svg) => {
      const b = svg.closest('button');
      return { head: b.innerText.replace(/\\s+/g, ' ').trim(), text: b.parentElement.textContent };
    })`);
    const drawn = (marker) => evaluate(s, `document.querySelector('#agent-root').textContent.includes(${J(marker)})`);
    const fresh = async (before) => (await rows()).slice(before.length);
    // A folded row keeps its body out of the document, so open it to read what it holds.
    const unfoldLast = async () => {
      await evaluate(s, `[...document.querySelectorAll('#agent-root svg.lucide-brain')].at(-1).closest('button').click()`);
      await sleep(400);
      return (await rows()).at(-1);
    };
    const settled = (r) => /^Thought for/.test(r?.head ?? '');

    await say(s, 'On it.', { open: true });
    await click(s, 'Later').catch(() => {});

    {
      const before = await rows();
      await think('Reading the cart ', 'before the coupon.');
      await sign();
      await whole([{ type: 'thinking', thinking: 'Reading the cart before the coupon.', signature: 'sig' }]);
      await blockStop();
      await sleep(400);
      const got = await fresh(before);
      check('whole-message-adds-no-second-row', got.length === 1 && settled(got[0]), J(got));
      await finish();
    }

    {
      const before = await rows();
      await start();
      await sign();
      await whole([{ type: 'thinking', thinking: '', signature: 'sig' }]);
      await blockStop();
      await sleep(400);
      const got = await fresh(before);
      check('signature-only-block-makes-no-row', got.length === 0, J(got));
      await finish();
    }

    {
      const before = await rows();
      await think('\n', '  ');
      await whole([{ type: 'thinking', thinking: '\n  ', signature: 'sig' }]);
      await blockStop();
      await sleep(400);
      const got = await fresh(before);
      check('whitespace-only-thought-makes-no-row', got.length === 0, J(got));
      await finish();
    }

    {
      const before = await rows();
      await think('Superseded thought ', 'with no stop.');
      await ev({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
      await sleep(400);
      const got = await fresh(before);
      check('superseded-thought-settles', got.length === 1 && settled(got[0]), J(got));
      await ev({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Answer.' } });
      await blockStop();
      await finish();
    }

    {
      const before = await rows();
      await think('About to read ', 'a file.');
      await whole([{ type: 'tool_use', id: 'toolu_r1', name: 'Read', input: { file_path: path.join(s.project, 'index.html') } }]);
      await sleep(400);
      const got = await fresh(before);
      check('tool-call-settles-an-open-thought', got.length === 1 && settled(got[0]), J(got));
      await emit({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_r1', content: 'ok' }] } });
      await finish();
    }

    {
      const MARK = 'LATE-AFTER-STOP';
      const before = await rows();
      await begin();
      await think('Stop me ', 'mid-thought.');
      await sleep(300);
      await click(s, 'css=#agent-root button[aria-label="Stop"]');
      await sleep(300);
      await delta(` ${MARK}`);
      await blockStop();
      await sleep(400);
      const got = await fresh(before);
      const open = got.length === 1 && settled(got[0]) ? await unfoldLast() : null;
      check('stop-folds-and-drops-late-text', !!open && open.text.includes('Stop me mid-thought.') && !open.text.includes(MARK), J({ got, open }));
      await emit({ type: 'result', subtype: 'error_during_execution', duration_ms: 900 });
    }

    {
      const MARK = 'LATE-AFTER-ERROR';
      const before = await rows();
      await begin();
      await think('Erroring ', 'mid-thought.');
      await sleep(300);
      await evaluate(s, `globalThis.__agent.emit('error', 'the stream broke')`, { main: true });
      await sleep(300);
      await delta(` ${MARK}`);
      await sleep(400);
      const got = await fresh(before);
      const open = got.length === 1 && settled(got[0]) ? await unfoldLast() : null;
      check('error-settles-and-drops-late-text', !!open && open.text.includes('Erroring mid-thought.') && !open.text.includes(MARK), J({ got, open }));
      await blockStop();
    }
    await shot(s, path.join(os.tmpdir(), 'conn-reasoning-live.png'));

    seedReplay(s);
    await evaluate(s, `window.connRail.refresh()`);
    const listed = async () => evaluate(s, `document.body.innerText.includes(${J(REPLAY_TITLE)})`);
    for (let i = 0; i < 40 && !(await listed()); i++) await sleep(150);
    await click(s, REPLAY_TITLE);
    let got = [];
    for (let i = 0; i < 30; i++) {
      got = await rows();
      if (got.length && (await drawn('Replayed answer.'))) break;
      await sleep(150);
    }
    await sleep(300);
    got = await rows();
    check('replay-shows-one-row', got.length === 1 && got[0].head === 'Thought', J(got));
    await shot(s, path.join(os.tmpdir(), 'conn-reasoning-replay.png'));
  } finally {
    await stop(s);
  }

  if (failures.length) {
    console.log(`\n${failures.length} failure(s)`);
    process.exit(1);
  }
  console.log('\nall passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
