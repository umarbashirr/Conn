'use strict';
// P2.4: Claude interrupt() must deny pending permission prompts the same way
// stop() does, and the renderer must not leave those cards clickable.
const path = require('path');
const fs = require('fs');
const os = require('os');
const ROOT = process.env.CONN_ROOT || path.join(__dirname, '..');

const failures = [];
const pass = (name) => console.log(`PASS ${name}`);
const fail = (name, detail) => { console.log(`FAIL ${name}: ${detail}`); failures.push(name); };

function plantPending(session, id) {
  const seen = [];
  session.pending.set(id, {
    resolve: (verdict) => { seen.push(verdict); },
    input: { command: 'rm -rf /' },
    tool: 'Bash',
  });
  return seen;
}

async function checkInterruptClearsPending() {
  let AgentSession;
  try {
    ({ AgentSession } = require(path.join(ROOT, 'src/main/agent.js')));
  } catch (e) {
    fail('load-agent', e.message);
    return;
  }
  pass('load-agent');

  const stopped = new AgentSession({ cwd: ROOT });
  const stopSeen = plantPending(stopped, 'ps');
  stopped.stop();
  if (stopped.pending.size === 0 && stopSeen[0]?.behavior === 'deny') {
    pass('stop-denies-pending');
  } else {
    fail('stop-denies-pending', `size=${stopped.pending.size} verdict=${JSON.stringify(stopSeen[0])}`);
  }

  const interrupted = new AgentSession({ cwd: ROOT });
  const interruptSeen = plantPending(interrupted, 'pi');
  await interrupted.interrupt();
  if (interrupted.pending.size === 0) pass('interrupt-empties-pending');
  else fail('interrupt-empties-pending', `pending size ${interrupted.pending.size} after interrupt`);

  if (interruptSeen[0]?.behavior === 'deny') pass('interrupt-denies-pending');
  else fail('interrupt-denies-pending', `verdict=${JSON.stringify(interruptSeen[0])}`);

  if (!interrupted.closed) pass('interrupt-does-not-close');
  else fail('interrupt-does-not-close', 'interrupt set closed, which is stop() territory');
}

async function checkDeniesBeforeSdkInterrupt() {
  const { AgentSession } = require(path.join(ROOT, 'src/main/agent.js'));
  const session = new AgentSession({ cwd: ROOT });
  const seen = plantPending(session, 'phang');
  let interruptCalled = false;
  session.query = {
    interrupt: () => {
      interruptCalled = true;
      if (session.pending.size !== 0) {
        return Promise.reject(new Error('pending still occupied when SDK interrupt ran'));
      }
      return Promise.resolve();
    },
  };
  await session.interrupt();
  if (interruptCalled) pass('sdk-interrupt-still-called');
  else fail('sdk-interrupt-still-called', 'query.interrupt was not invoked');
  if (session.pending.size === 0 && seen[0]?.behavior === 'deny') {
    pass('denies-before-sdk-interrupt');
  } else {
    fail('denies-before-sdk-interrupt', `size=${session.pending.size} verdict=${JSON.stringify(seen[0])}`);
  }
}

function checkRendererClearsCards() {
  const src = fs.readFileSync(path.join(ROOT, 'src/renderer/ui/useAgent.js'), 'utf8');
  const block = src.match(/const interrupt = useCallback\(async \(\) => \{[\s\S]*?\}, \[edit\]\);/);
  if (!block) {
    fail('renderer-interrupt-block', 'could not find useAgent interrupt callback');
    return;
  }
  pass('renderer-interrupt-block');
  const helper = src.match(/function interrupted\(items\) \{[\s\S]*?\n\}/)?.[0] || '';
  const body = /interrupted\(c\.items\)/.test(block[0]) ? helper : block[0];
  if (/kind === ['"]perm['"]/.test(body) && /decided:\s*['"]deny['"]/.test(body)) {
    pass('renderer-interrupt-denies-cards');
  } else {
    fail('renderer-interrupt-denies-cards', 'interrupt() does not mark pending perm items decided');
  }
}

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

// ACP: a call still open when the turn is cancelled gets a result that says so,
// because the agent is not obliged to send one.
async function checkAcpInterruptCancelsOpenCalls() {
  const { AcpSession } = require(path.join(ROOT, 'src/main/providers/acp-session.js'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-acp-interrupt-'));
  const spec = {
    id: 'cursor',
    cli: 'agent',
    argv: [path.join(ROOT, 'scripts/mock-acp-cli.js'), 'acp'],
    modes: Object.fromEntries(['ask', 'edit', 'plan', 'bypass'].map((m) => [m, {}])),
    binary: () => process.execPath,
  };
  const session = new AcpSession({ spec, cwd, model: 'mock-1' });
  const seen = [];
  session.on('message', (m) => seen.push(m));
  const resultFor = (id) => seen.find((m) => m.type === 'user' && m.message.content[0]?.tool_use_id === id)?.message.content[0];
  try {
    await session.start();
    session.send('hang on a call');
    await until(() => seen.some((m) => m.type === 'assistant' && m.message.content[0]?.id === 't-hang'));
    if (!resultFor('t-hang')) pass('acp-call-open-before-interrupt');
    else fail('acp-call-open-before-interrupt', 'the call had a result before the interrupt');
    await session.interrupt();
    await until(() => seen.some((m) => m.type === 'result'));
    const cancelled = resultFor('t-hang');
    if (cancelled?.is_error && cancelled.content === 'interrupted') pass('acp-interrupt-cancels-open-call');
    else fail('acp-interrupt-cancels-open-call', `result=${JSON.stringify(cancelled)}`);
    const ended = seen.find((m) => m.type === 'result');
    if (ended.subtype === 'cancelled') pass('acp-turn-ends-cancelled');
    else fail('acp-turn-ends-cancelled', `subtype=${ended.subtype}`);
  } catch (e) {
    fail('acp-interrupt-cancels-open-call', e.stack || e.message);
  } finally {
    session.stop();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

(async () => {
  await checkInterruptClearsPending();
  await checkDeniesBeforeSdkInterrupt();
  checkRendererClearsCards();
  await checkAcpInterruptCancelsOpenCalls();
  if (failures.length) {
    console.log(`\n${failures.length} failure(s)`);
    process.exit(1);
  }
  console.log('\nall passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
