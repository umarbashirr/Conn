'use strict';
const path = require('path');
const { shownModel, followsWindowProvider, reuseLive } = require(path.join(__dirname, '..', 'src/shared/run-choice'));

const failures = [];
const pass = (name) => console.log(`PASS ${name}`);
const fail = (name, detail) => { console.log(`FAIL ${name}: ${detail}`); failures.push(name); };

function checkLabelFollowsSession() {
  const label = shownModel('grok-4.7', 'claude-opus-5-5', true);
  if (label === 'claude-opus-5-5') pass('active-chat-shows-the-model-that-started');
  else fail('active-chat-shows-the-model-that-started', label);

  const background = shownModel('grok-4.7', 'claude-opus-5-5', false);
  if (background === 'grok-4.7') pass('background-ready-leaves-the-label');
  else fail('background-ready-leaves-the-label', background);
}

function checkDriverPush() {
  const picked = followsWindowProvider({ items: [], session: null, usage: { model: 'grok-4.7' } });
  if (picked === false) pass('picked-model-survives-driver-push');
  else fail('picked-model-survives-driver-push', String(picked));

  const blank = followsWindowProvider({ items: [], session: null, usage: { model: null } });
  if (blank === true) pass('blank-chat-follows-window-provider');
  else fail('blank-chat-follows-window-provider', String(blank));

  const stored = followsWindowProvider({ items: [], session: 'claude-session', usage: { model: null } });
  if (stored === false) pass('stored-chat-keeps-its-provider');
  else fail('stored-chat-keeps-its-provider', String(stored));
}

function checkLiveSession() {
  if (reuseLive('claude', 'grok') === false) pass('grok-pick-does-not-reuse-claude');
  else fail('grok-pick-does-not-reuse-claude', 'reused');

  if (reuseLive('claude', 'claude') === true) pass('same-cli-reuses-the-session');
  else fail('same-cli-reuses-the-session', 'restarted');

  if (reuseLive(null, 'grok') === false) pass('no-session-starts-fresh');
  else fail('no-session-starts-fresh', 'reused');
}

function until(fn, ms = 8000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        const v = fn();
        if (v) return resolve(v);
      } catch (e) { return reject(e); }
      if (Date.now() - start > ms) return reject(new Error('timed out'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

async function checkRejectedModelReportsTheOneThatStayed() {
  const os = require('os');
  const fs = require('fs');
  const shellEnv = require(path.join(__dirname, '..', 'src/main/shell-env'));
  shellEnv.ready = async () => {};
  const { AcpSession } = require(path.join(__dirname, '..', 'src/main/providers/acp-session'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-model-mismatch-'));
  const session = new AcpSession({
    spec: {
      id: 'cursor',
      cli: 'agent',
      argv: [path.join(__dirname, 'mock-acp-cli.js'), 'acp'],
      binary: () => process.execPath,
      env: () => ({ MOCK_ACP_REJECT_MODEL: '1' }),
    },
    cwd: tmp,
    model: 'grok-4.7',
  });
  let ready = null;
  const errors = [];
  session.on('ready', (r) => { ready = r; });
  session.on('error', (e) => errors.push(String(e)));
  try {
    await session.start();
    await until(() => ready);
    if (ready.model === 'mock-1') pass('rejected-switch-reports-the-model-still-running');
    else fail('rejected-switch-reports-the-model-still-running', JSON.stringify(ready));
    if (errors.some((e) => /could not switch to grok-4.7/.test(e))) pass('rejected-switch-is-visible');
    else fail('rejected-switch-is-visible', errors.join(' | '));
  } catch (e) {
    fail('rejected-switch-reports-the-model-still-running', e.stack || e.message);
  } finally {
    session.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

checkLabelFollowsSession();
checkDriverPush();
checkLiveSession();

checkRejectedModelReportsTheOneThatStayed().then(() => {
  if (failures.length) {
    console.log(`\n${failures.length} failure(s)`);
    process.exit(1);
  }
  console.log('\nall passed');
  process.exit(0);
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
