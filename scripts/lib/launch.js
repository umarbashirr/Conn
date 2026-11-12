'use strict';
// Starts Conn for a repro script. Both debug ports are left to the OS, so runs
// that overlap never drive each other's app, and it returns only once main has
// finished booting (globalThis.__connReady): a script that swaps an IPC handler
// any sooner races the app registering it, and an inspector reached mid-boot
// can lack process.getBuiltinModule.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One evaluate over a fresh inspector session. Anything that goes wrong,
// including a target that is not set up yet, reads as "not yet".
function ready(url) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const done = (v) => { clearTimeout(timer); try { ws.close(); } catch {} resolve(v); };
    const timer = setTimeout(() => done(false), 2000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'globalThis.__connReady === true', returnByValue: true } }));
    ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id === 1) done(msg.result?.result?.value === true); };
    ws.onerror = () => done(false);
  });
}

async function launch(root, { userData, env, args = [], timeout = 180000, ...options }) {
  const electron = require(path.join(root, 'node_modules', 'electron'));
  const app = spawn(electron, ['--inspect=0', root, '--remote-debugging-port=0', `--user-data-dir=${userData}`, '--no-sandbox', ...args],
    { env, ...options, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  let inspector = null;
  app.stderr.on('data', (d) => {
    err = (err + d).slice(-4000);
    inspector ||= err.match(/Debugger listening on (ws:\/\/\S+)/)?.[1] || null;
  });

  const file = path.join(userData, 'DevToolsActivePort');
  const end = Date.now() + timeout;
  try {
    let cdp = 0;
    for (;;) {
      if (app.exitCode !== null || app.signalCode !== null) throw new Error(`app exited (${app.exitCode ?? app.signalCode}) while booting:\n${err.slice(-500)}`);
      cdp ||= (fs.existsSync(file) && Number(fs.readFileSync(file, 'utf8').split('\n')[0])) || 0;
      if (inspector && cdp && await ready(inspector)) return { app, inspector, cdp };
      if (Date.now() > end) throw new Error(`app not ready after ${timeout} ms (inspector ${inspector}, cdp ${cdp}):\n${err.slice(-500)}`);
      await sleep(250);
    }
  } catch (e) {
    app.kill('SIGKILL');
    throw e;
  }
}

module.exports = { launch };
