#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = process.env.CONN_ROOT || path.join(__dirname, '..');

const DEFAULT_PATHEXT = ['.COM', '.EXE', '.BAT', '.CMD', '.VBS', '.VBE', '.JS', '.JSE', '.WSF', '.WSH', '.MSC'];

const failures = [];
const pass = (name) => console.log(`PASS ${name}`);
const fail = (name, detail) => { console.log(`FAIL ${name}: ${detail}`); failures.push(name); };

function resolveCommand(name, pathDirs, pathext = DEFAULT_PATHEXT) {
  for (const dir of pathDirs) {
    let entries;
    try { entries = fs.readdirSync(dir); } catch { continue; }
    const lower = Object.create(null);
    for (const e of entries) lower[e.toLowerCase()] = e;
    const bare = lower[name.toLowerCase()];
    if (bare) {
      const full = path.join(dir, bare);
      if (fs.statSync(full).isFile()) return full;
    }
    for (const ext of pathext) {
      const hit = lower[(name + ext).toLowerCase()];
      if (!hit) continue;
      const full = path.join(dir, hit);
      if (fs.statSync(full).isFile()) return full;
    }
  }
  return null;
}

function stageLayout(kind) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `conn-win-cli-${kind}-`));
  const inst = path.join(base, 'Programs', 'conn');
  fs.mkdirSync(inst, { recursive: true });
  fs.writeFileSync(path.join(inst, 'conn.exe'), 'GUI');
  if (kind === 'broken') {
    fs.writeFileSync(path.join(inst, 'conn.cmd'), '@echo CLI');
    return { base, pathDirs: [inst], cliHint: path.join(inst, 'conn.cmd') };
  }
  const bin = path.join(inst, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'conn.cmd'), '@echo CLI');
  return { base, pathDirs: [bin], cliHint: path.join(bin, 'conn.cmd') };
}

function checkBrokenLayoutLosesToExe() {
  const { base, pathDirs } = stageLayout('broken');
  try {
    const hit = resolveCommand('conn', pathDirs);
    if (hit && path.basename(hit).toLowerCase() === 'conn.exe') {
      pass('pathext-exe-beats-sibling-cmd');
    } else {
      fail('pathext-exe-beats-sibling-cmd', `expected conn.exe, got ${hit}`);
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function checkFixedLayoutPicksCmd() {
  const { base, pathDirs, cliHint } = stageLayout('fixed');
  try {
    const hit = resolveCommand('conn', pathDirs);
    if (hit === cliHint) {
      pass('pathext-bin-dir-picks-cmd');
    } else {
      fail('pathext-bin-dir-picks-cmd', `expected ${cliHint}, got ${hit}`);
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function checkUpgradeKeepsExeOutOfPath() {
  const { base, pathDirs } = stageLayout('fixed');
  const inst = path.dirname(pathDirs[0]);
  try {
    const hit = resolveCommand('conn', [inst, ...pathDirs]);
    if (hit && path.basename(hit).toLowerCase() === 'conn.exe') {
      pass('legacy-instdir-ahead-still-exe');
    } else {
      fail('legacy-instdir-ahead-still-exe', `expected exe when INSTDIR leads, got ${hit}`);
    }
    const hitFixed = resolveCommand('conn', pathDirs);
    if (hitFixed && path.basename(hitFixed).toLowerCase() === 'conn.cmd') {
      pass('path-without-instdir-picks-cmd');
    } else {
      fail('path-without-instdir-picks-cmd', `expected cmd when only bin is on PATH, got ${hitFixed}`);
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function checkPackagingSources() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const extras = (((pkg.build || {}).win || {}).extraFiles) || [];
  const cliExtra = extras.find((e) => String(e.from || '').endsWith('conn.cmd'));
  if (cliExtra && String(cliExtra.to).replace(/\\/g, '/') === 'bin/conn.cmd') {
    pass('package-extraFiles-cli-in-bin');
  } else {
    fail('package-extraFiles-cli-in-bin', `extraFiles conn.cmd to=${cliExtra && cliExtra.to}`);
  }

  const nsh = fs.readFileSync(path.join(ROOT, 'build/installer.nsh'), 'utf8');
  const installMacro = nsh.match(/!macro customInstall[\s\S]*?!macroend/);
  const installBody = installMacro ? installMacro[0] : '';
  if (/\$\$bin\s*=/.test(installBody) && /\$INSTDIR\\bin/.test(installBody)) {
    pass('installer-path-points-at-bin');
  } else {
    fail('installer-path-points-at-bin', 'installer.nsh still adds bare $INSTDIR to PATH');
  }
  if (/\$\$_ -ne \$\$dir/.test(installBody) && /\$\$bin/.test(installBody)) {
    pass('installer-strips-legacy-instdir');
  } else {
    fail('installer-strips-legacy-instdir', 'upgrade PATH edit must drop bare $INSTDIR');
  }

  const uninstallMacro = nsh.match(/!macro customUnInstall[\s\S]*?!macroend/);
  const uninstallBody = uninstallMacro ? uninstallMacro[0] : '';
  if (/\$\$bin/.test(uninstallBody) && /\$\$_ -ne \$\$dir/.test(uninstallBody)) {
    pass('uninstaller-removes-bin-and-legacy');
  } else {
    fail('uninstaller-removes-bin-and-legacy', 'uninstall must drop both bin and legacy INSTDIR');
  }

  const cmd = fs.readFileSync(path.join(ROOT, 'build/conn.cmd'), 'utf8');
  if (/%~dp0\.\.\\conn\.exe/.test(cmd) || /%~dp0\.\.[\\/]conn\.exe/.test(cmd)) {
    pass('conn-cmd-parents-to-exe');
  } else {
    fail('conn-cmd-parents-to-exe', 'bin/conn.cmd must call ..\\conn.exe');
  }
}

checkBrokenLayoutLosesToExe();
checkFixedLayoutPicksCmd();
checkUpgradeKeepsExeOutOfPath();
checkPackagingSources();

if (failures.length) {
  console.log(`\n${failures.length} failure(s)`);
  process.exit(1);
}
console.log('\nall checks passed');
