/* With no model picked, a chat runs the account's default, as the claude CLI
   does on its own. Two things kept that from reaching people:

   - Every launch saved the first model listed as if it had been picked, so
     nearly everyone has `opus` saved and it loads as their choice. Picks the
     app makes are no longer saved; only one made in the picker is, and it is
     marked as such. Once, a saved Claude model that is exactly what the old
     code would have picked, with no such mark, is cleared.
   - The default is matched by the id the CLI says it resolves to, so a
     default that is the 1M-context variant lands on that variant.

   The ordering runs under plain node. The launches are the real app on a
   throwaway HOME, under Xvfb, with a driver cache as an older release left
   it. Needs a built renderer: `npx vite build`. */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
};

// --- which model comes first -----------------------------------------------------

const { Driver } = require(path.join(ROOT, 'src/main/driver.js'));
const row = (value, displayName, description, resolvedModel) => ({ value, displayName, description, ...(resolvedModel ? { resolvedModel } : {}) });
const cases = [
  ['sonnet-default', 'sonnet', [row('default', 'Default (recommended)', 'Sonnet 5.5 · Best for everyday tasks', 'claude-sonnet-5-5'), row('opus', 'Opus 5.5', 'For complex work'), row('sonnet', 'Sonnet 5.5', 'Efficient'), row('haiku', 'Haiku 5.5', 'Fast')]],
  ['opus-1m-default', 'opus[1m]', [row('default', 'Default (recommended)', 'Opus 5.5 with 1M context · Best for complex work', 'claude-opus-5-5[1m]'), row('opus', 'Opus 5.5', 'For complex work'), row('opus[1m]', 'Opus 5.5 (1M context)', 'Opus 5.5 with 1M context · For long sessions'), row('sonnet', 'Sonnet 5.5', 'Efficient')]],
  ['sonnet-1m-default-unlisted', 'sonnet[1m]', [row('default', 'Default (recommended)', 'Sonnet 5.5 with 1M context · Best', 'claude-sonnet-5-5[1m]'), row('opus', 'Opus 5.5', 'x'), row('sonnet', 'Sonnet 5.5', 'y')]],
  ['default-by-its-id', 'claude-sonnet-5', [row('default', 'Default (recommended)', 'Sonnet 5 · Efficient', 'claude-sonnet-5'), row('opus', 'Opus 5.5', 'x'), row('sonnet', 'Sonnet 5.5', 'y'), row('claude-sonnet-5', 'Sonnet 5', 'Efficient for routine tasks')]],
  ['rows-carry-their-ids', 'sonnet', [row('default', 'Default (recommended)', 'Recommended', 'claude-sonnet-5-5'), row('opus', 'Opus', 'x', 'claude-opus-5-5'), row('sonnet', 'Sonnet', 'y', 'claude-sonnet-5-5')]],
  ['unknown-default-keeps-the-order', 'opus', [row('default', 'Default', 'Mythos 9 · ?'), row('opus', 'Opus 5.5', 'x'), row('sonnet', 'Sonnet 5.5', 'y')]],
];
for (const [name, want, models] of cases) {
  const d = new Driver({ cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pick-')) });
  d.learn(models);
  const got = d.current({ refresh: false }).models.map((m) => m.value);
  check(`first-model-${name}`, got[0] === want, got.join(' '));
}

// --- the saved model, across a launch ---------------------------------------------

const claude = (() => { try { return execFileSync('which', ['claude'], { encoding: 'utf8' }).trim(); } catch { return null; } })();
// What a release before this one wrote: the CLI's list with `default` dropped
// and nothing moved, so the first row is what it saved for everyone.
const OLD_CACHE = {
  installed: true, status: 'ready', endpoint: 'anthropic', learned: true, served: false, message: null,
  checkedAt: Date.now(), binaryPath: claude, version: null,
  models: [{ value: 'opus', displayName: 'Opus 5.5' }, { value: 'sonnet', displayName: 'Sonnet 5.5' }, { value: 'haiku', displayName: 'Haiku 4.5' }],
};

async function launch(agentSettings, act) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-model-default-'));
  const home = path.join(base, 'home');
  const userData = path.join(base, 'userdata');
  const project = path.join(base, 'shop');
  for (const d of [path.join(home, '.conn'), path.join(userData, 'drivers'), project]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(home, '.conn', 'open-projects.json'), J([project]));
  fs.writeFileSync(path.join(home, '.conn', 'settings.json'), J({ agent: agentSettings }));
  fs.writeFileSync(path.join(userData, 'drivers', 'claude.json'), J(OLD_CACHE));
  fs.writeFileSync(path.join(home, '.zshrc'), '');
  const electron = require('electron');
  const env = { ...process.env, HOME: home, CONN_CWD: project };
  for (const k of Object.keys(env)) if (/^(CLAUDE|ANTHROPIC)/.test(k) || k === 'ELECTRON_RUN_AS_NODE') delete env[k];
  const app = spawn('xvfb-run', ['-a', electron, ROOT, '--remote-debugging-port=0', `--user-data-dir=${userData}`, '--no-sandbox'],
    { env, stdio: 'ignore', detached: true });
  const settings = () => JSON.parse(fs.readFileSync(path.join(home, '.conn', 'settings.json'), 'utf8')).agent;
  try {
    let port = null;
    for (let i = 0; i < 120 && !port; i++) {
      try { port = fs.readFileSync(path.join(userData, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch { await sleep(250); }
    }
    let ws = null;
    for (let i = 0; i < 120 && !ws; i++) {
      try {
        const page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page' && /index\.html/.test(t.url));
        if (page) ws = page.webSocketDebuggerUrl;
      } catch {}
      if (!ws) await sleep(250);
    }
    const socket = new WebSocket(ws);
    await new Promise((r) => { socket.onopen = r; });
    let seq = 0;
    const waiting = new Map();
    socket.onmessage = (m) => { const msg = JSON.parse(m.data); waiting.get(msg.id)?.(msg); waiting.delete(msg.id); };
    const run = (expression) => new Promise((resolve) => {
      const id = ++seq;
      waiting.set(id, (msg) => resolve(msg.result?.result?.value));
      socket.send(J({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
    for (let i = 0; i < 120 && !(await run('!!window.connChat')); i++) await sleep(250);
    // The driver re-reads the CLI once the login shell's PATH is in; give it the time.
    await sleep(4000);
    return await act({ run, settings });
  } finally {
    try { process.kill(-app.pid, 'SIGTERM'); } catch {}
    await sleep(1500);
    try { process.kill(-app.pid, 'SIGKILL'); } catch {}
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
  }
}

await launch({ model: 'opus' }, async ({ run, settings }) => {
  const saved = settings();
  const { current, models } = await run("window.conn.agent.models().then((r) => ({ current: r.current, models: r.models.filter((m) => m.provider === 'claude').map((m) => m.value) }))");
  console.log(`saved opus with no pick: settings ${J(saved)}, picker current ${current}, first listed ${models[0]}`);
  check('auto-saved-opus-is-cleared', saved.model === '', J(saved));
  check('the-clean-up-runs-once', saved.autoModelCleared === true, J(saved));
  check('the-chat-runs-what-is-listed-first', current === models[0], `${current} vs ${models[0]}`);
});

await launch({ model: 'opus', modelPicked: true }, async ({ run, settings }) => {
  check('a-picked-model-is-kept', settings().model === 'opus', J(settings()));
  await run("window.conn.agent.setModel(null, 'sonnet')");
  const after = settings();
  check('a-pick-in-the-picker-is-saved-and-marked', after.model === 'sonnet' && after.modelPicked === true, J(after));
});

await launch({}, async ({ run, settings }) => {
  await run('window.conn.agent.models()');
  check('nothing-picked-saves-nothing', !settings().model, J(settings()));
});

if (failures.length) {
  console.log(`\n${failures.length} FAIL(s): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\np2-model-default-repro: all passed');
process.exit(0);
