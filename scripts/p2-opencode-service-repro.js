#!/usr/bin/env node
'use strict';
// Conn's catalog probe leaves no OpenCode background server behind. Since
// opencode 2.0.15, `opencode mcp list` starts `opencode serve --service`, a
// detached server of about 280 MB that keeps running after the command, and
// Conn ran it for each open project every 30 minutes. Runs the real opencode
// CLI and passes when the server is stopped after the probe, as it was before.
// Skips when a server is already running, so it never stops someone's own.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = process.env.CONN_ROOT || path.join(__dirname, '..');
const shellEnv = require(path.join(ROOT, 'src/main/shell-env'));
shellEnv.ready = async () => process.env.PATH || '';
shellEnv.env = () => ({ ...process.env });

const opencode = require(path.join(ROOT, 'src/main/providers/opencode.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-opencode-service-'));
const status = (bin) => execFileSync(bin, ['service', 'status'], { encoding: 'utf8', timeout: 20000 }).trim();

async function main() {
  const row = opencode.create({ cacheDir: tmp, settings: { get: () => ({}) } });
  const bin = row.binary();
  if (!bin) return console.log('SKIP no opencode CLI on PATH');
  if (status(bin) !== 'stopped') return console.log('SKIP an OpenCode background server is already running');
  const snap = await row.catalog.refresh(tmp);
  const after = status(bin);
  const ok = after === 'stopped' && !snap.error;
  console.log(`${ok ? 'PASS' : 'FAIL'} probe-leaves-no-background-server${ok ? '' : `: status ${JSON.stringify(after)} error ${snap.error}`}`);
  if (after !== 'stopped') execFileSync(bin, ['service', 'stop'], { timeout: 20000 });
  if (!ok) process.exitCode = 1;
}

main().catch((e) => { console.log(`FAIL ${e.stack || e}`); process.exitCode = 1; })
  .finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
