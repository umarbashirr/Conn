#!/usr/bin/env node
'use strict';
// Run with the PATH a desktop launcher gives, e.g.
//   env PATH=/usr/bin:/bin node scripts/p2-cursor-catalog-launch-path-repro.js
// cursor-agent must live somewhere only the login shell adds, like ~/.local/bin.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = process.env.CONN_ROOT || path.join(__dirname, '..');
const { AcpCatalog } = require(path.join(ROOT, 'src/main/providers/acp-catalog'));
const cursor = require(path.join(ROOT, 'src/main/providers/cursor'));

const failures = [];
const pass = (name) => console.log(`PASS ${name}`);
const fail = (name, detail) => {
  console.log(`FAIL ${name}: ${detail}`);
  failures.push(name);
};

function catalogIn(cacheDir) {
  return cursor.create({ cacheDir, settings: { get: () => null } }).catalog;
}

async function checkFirstLaunch(dir) {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-p2-catalog-'));
  const catalog = catalogIn(cacheDir);
  catalog.current(dir);
  const listing = await catalog.inflightByDir.get(dir);
  if (listing?.error === catalog.spec.missing) {
    fail('first launch lists Cursor skills', listing.error);
  } else {
    pass(`first launch lists Cursor skills (${listing?.skills?.length ?? 0} skills, error=${listing?.error || 'none'})`);
  }
}

function checkRestartAfterMiss(dir) {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-p2-catalog-'));
  const file = path.join(cacheDir, 'drivers', 'cursor-catalog.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const missing = catalogIn(cacheDir).spec.missing;
  fs.writeFileSync(file, JSON.stringify({ [dir]: { at: Date.now() - 60000, skills: [], mcp: [], error: missing } }));
  const catalog = new AcpCatalog({ id: 'cursor', spec: catalogIn(cacheDir).spec, cacheDir });
  catalog.current(dir);
  if (catalog.inflightByDir.has(dir)) pass('restart retries a miss cached by the last launch');
  else fail('restart retries a miss cached by the last launch', 'served the cached error without probing');
  return catalog.inflightByDir.get(dir);
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-p2-project-'));
  await checkFirstLaunch(dir);
  await checkRestartAfterMiss(dir);
  if (failures.length) {
    console.log(`${failures.length} failed`);
    process.exit(1);
  }
  console.log('all passed');
  process.exit(0);
})();
