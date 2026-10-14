'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REQUIRE = `process.getBuiltinModule('module').createRequire(${JSON.stringify(path.join(ROOT, 'src/main/index.js'))})`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
};

const isZombie = (pid) => fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').pop()[0] === 'Z';
const alive = (pid) => {
  try { return !isZombie(pid); } catch { return false; }
};

async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(150);
  }
  return last;
}

async function inspectorOf(app) {
  let err = '';
  app.stderr.on('data', (d) => { err += d; });
  const url = await until(() => err.match(/Debugger listening on (ws:\/\/\S+)/)?.[1], 30000);
  if (!url) throw new Error(`no inspector: ${err.slice(-300)}`);
  return url;
}

function connect(url) {
  const ws = new WebSocket(url);
  let seq = 0;
  const waiting = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
  };
  const run = (expression) => new Promise((resolve) => {
    const id = ++seq;
    waiting.set(id, (res) => resolve(res.result?.result?.value));
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  return new Promise((resolve) => { ws.onopen = () => resolve({ ws, run }); });
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'build', 'renderer', 'index.html'))) throw new Error('no renderer build: run `npx vite build` first');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-codex-children-'));
  const home = path.join(base, 'home');
  const proj = path.join(base, 'shop');
  const bin = path.join(base, 'bin');
  const pidsFile = path.join(base, 'pids');
  for (const d of [path.join(home, '.conn'), proj, bin]) fs.mkdirSync(d, { recursive: true });
  const codex = path.join(bin, 'codex');
  fs.writeFileSync(codex, `#!/bin/sh\nexec "${process.execPath}" "${path.join(__dirname, 'mock-codex-cli.js')}" "$@"\n`);
  fs.chmodSync(codex, 0o755);
  fs.writeFileSync(path.join(home, '.conn', 'open-projects.json'), JSON.stringify([proj]));
  fs.writeFileSync(path.join(home, '.conn', 'settings.json'), JSON.stringify({
    agent: { provider: 'claude', mode: 'bypass' }, codex: { binary: codex },
  }));

  const electron = require(path.join(ROOT, 'node_modules', 'electron'));
  const app = spawn(electron, ['--inspect=0', ROOT, `--user-data-dir=${path.join(base, 'userdata')}`, '--no-sandbox'], {
    env: { ...process.env, HOME: home, CONN_CWD: proj, PATH: `${bin}:${process.env.PATH}`, MOCK_CODEX_PIDS_FILE: pidsFile },
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: true,
  });
  const exited = new Promise((r) => app.once('exit', r));
  const spawned = () => (fs.existsSync(pidsFile) ? fs.readFileSync(pidsFile, 'utf8').trim().split('\n').map((l) => l.split(' ').map(Number)) : []);

  try {
    const main = await connect(await inspectorOf(app));
    check('startup-probe-ran-codex', await until(() => spawned().length > 0, 30000), 'the mock codex app-server never started');
    const [[probe, probeFetch]] = spawned();
    check('probe-app-server-closed', await until(() => !alive(probe)), `codex ${probe} still running`);
    await sleep(500);
    check('probe-fetch-gone-once-its-codex-is-closed', !alive(probeFetch), `fetch ${probeFetch} outlived codex ${probe}`);

    await main.run(`(() => {
      const req = ${REQUIRE};
      const { AppServer } = req('./codex-rpc');
      globalThis.__held = new AppServer({ bin: ${JSON.stringify(codex)}, cwd: ${JSON.stringify(proj)} });
      return globalThis.__held.start({ clientInfo: { name: 'repro', version: '0' } }).then(() => true);
    })()`);
    const held = spawned().at(-1);
    check('held-app-server-started', held && held[0] !== probe && alive(held[0]), JSON.stringify(spawned()));
    await main.run(`(globalThis.__held.close(), true)`);
    check('held-app-server-closed', await until(() => !alive(held[0])), `codex ${held[0]} still running`);
    await sleep(500);
    check('held-fetch-gone-once-its-codex-is-closed', !alive(held[1]), `fetch ${held[1]} outlived codex ${held[0]}`);

    await main.run(`(() => {
      const req = ${REQUIRE};
      const { AppServer } = req('./codex-rpc');
      return new AppServer({ bin: ${JSON.stringify(codex)}, cwd: ${JSON.stringify(proj)} })
        .start({ clientInfo: { name: 'repro', version: '0' } }).then(() => true);
    })()`);
    const open = spawned().at(-1);
    check('open-app-server-started', open && open[0] !== held[0] && alive(open[0]), JSON.stringify(spawned()));
    await main.run(`(() => {
      const req = ${REQUIRE};
      req('electron').app.quit();
      return true;
    })()`);
    main.ws.close();
    check('app-quits', await until(() => app.exitCode !== null || app.signalCode !== null, 15000), 'Electron still running 15 s after app.quit()');
    await sleep(500);
    check('no-codex-or-fetch-outlives-the-app', !alive(open[0]) && !alive(open[1]),
      `codex ${open[0]} ${alive(open[0]) ? 'alive' : 'gone'}, fetch ${open[1]} ${alive(open[1]) ? 'alive' : 'gone'}`);
  } finally {
    const stray = spawned().flat().filter(alive);
    for (const pid of stray) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    try { process.kill(-app.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    await exited;
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
  }

  console.log(failures.length ? `\n${failures.length} failed` : '\nall passed');
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
