#!/usr/bin/env node
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = process.env.CONN_ROOT || path.join(__dirname, '..');
const {
  followAgent, toolOf, ACP_INSTRUCTIONS, AcpSession,
} = require(path.join(ROOT, 'src/main/providers/acp-session.js'));
const { decide, decideCodex, everyMode } = require(path.join(ROOT, 'src/main/modes.js'));
const { INSTRUCTIONS } = require(path.join(ROOT, 'src/shared/browser-tools.js'));
const cursorProvider = require(path.join(ROOT, 'src/main/providers/cursor.js'));
const opencodeProvider = require(path.join(ROOT, 'src/main/providers/opencode.js'));

const failures = [];
const pass = (name) => console.log(`PASS ${name}`);
const fail = (name, detail) => {
  console.log(`FAIL ${name}: ${detail}`);
  failures.push(name);
};
const check = (name, ok, detail) => (ok ? pass(name) : fail(name, detail || 'failed'));

function checkModeTables() {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-modes-'));
  const table = (provider) => provider.create({ cacheDir, settings: { get: () => ({}) } }).spec.modes;
  const cursor = table(cursorProvider);
  const opencode = table(opencodeProvider);
  check('cursor-ask-can-work', cursor.ask.session === 'agent', cursor.ask.session);
  check('cursor-plan-is-plan', cursor.plan.session === 'plan', cursor.plan.session);
  check('cursor-bypass-forces', cursor.bypass.argv?.includes('--force'), JSON.stringify(cursor.bypass));
  check('cursor-only-bypass-forces', ['plan', 'ask', 'auto'].every((m) => !cursor[m].argv), 'a gated mode forces');
  check('opencode-plan-is-plan', opencode.plan.session === 'plan', opencode.plan.session);
  check('opencode-bypass-leaves-plan', opencode.bypass.session === 'build', opencode.bypass.session);
  check('follow-agent-into-plan', followAgent('bypass', 'plan', cursor) === 'plan');
  check('follow-agent-out-of-plan', followAgent('plan', 'agent', cursor) === 'ask');
  check('follow-agent-keeps-working-mode', followAgent('auto', 'agent', cursor) === 'auto');
  let threw = false;
  try { everyMode('x', { plan: {}, ask: {}, auto: {} }); } catch { threw = true; }
  check('table-missing-a-mode-refuses', threw);
}

function checkToolOf() {
  check(
    'other-browser-title',
    toolOf({ kind: 'other', title: 'browser_snapshot' }) === 'browser_snapshot',
    toolOf({ kind: 'other', title: 'browser_snapshot' }),
  );
  check(
    'other-mcp-title',
    toolOf({ kind: 'other', title: 'mcp__conn__browser_show' }) === 'mcp__conn__browser_show',
  );
  check(
    'other-no-longer-Tool',
    toolOf({ kind: 'other', title: 'browser_navigate' }) !== 'Tool',
  );
  check('edit-kind', toolOf({ kind: 'edit', title: 'Write file' }) === 'Edit');
  check('execute-kind', toolOf({ kind: 'execute', title: 'bash' }) === 'Bash');

  const snap = decide('plan', toolOf({ kind: 'other', title: 'browser_snapshot' }), {});
  check('decide-snapshot-allow', snap.action === 'allow', snap.action);
  const show = decide('ask', toolOf({ kind: 'other', title: 'browser_show' }), {});
  check('decide-show-allow', show.action === 'allow', show.action);
  const nav = decideCodex('plan', toolOf({ kind: 'other', title: 'browser_navigate' }), {});
  check('decide-navigate-deny', nav.action === 'deny', nav.action);
  const autoNav = decide('auto', toolOf({ kind: 'other', title: 'browser_navigate' }), {});
  check('decide-auto-navigate-allow', autoNav.action === 'allow', autoNav.action);
}

function checkInstructions() {
  check('shared-mentions-navigate', /\bbrowser_navigate\b/.test(INSTRUCTIONS));
  check('shared-mentions-show', /\bbrowser_show\b/.test(INSTRUCTIONS));
  check('acp-mentions-preview-pane', /preview pane inside this app/.test(ACP_INSTRUCTIONS));
  check('acp-mentions-other-browser', /Any other browser tool/.test(ACP_INSTRUCTIONS));
  check('acp-includes-shared', ACP_INSTRUCTIONS.includes('browser_snapshot'));

  const codex = fs.readFileSync(path.join(ROOT, 'src/main/codex.js'), 'utf8');
  check('codex-mentions-show', /browser_show/.test(codex) || /Prefer mcp__conn__browser_show/.test(codex));
}

function checkPrefaceWiring() {
  const withMcp = new AcpSession({
    spec: { binary: () => null, cli: 'agent', missing: 'nope' },
    cwd: ROOT,
    mcp: { command: 'node', args: ['mcp/server.js'] },
  });
  check('preface-with-mcp', withMcp.preface === ACP_INSTRUCTIONS, 'preface missing ACP_INSTRUCTIONS');

  const bare = new AcpSession({
    spec: { binary: () => null, cli: 'agent', missing: 'nope' },
    cwd: ROOT,
  });
  check('preface-without-mcp', bare.preface === null, bare.preface);

  const retired = new AcpSession({
    spec: { binary: () => null, cli: 'agent', missing: 'nope' },
    cwd: ROOT,
    mode: 'debug',
  });
  check('retired-debug-is-ask', retired.mode === 'ask', retired.mode);
}

checkModeTables();
checkToolOf();
checkInstructions();
checkPrefaceWiring();
console.log(failures.length ? `\n${failures.length} FAIL(s)` : '\nALL PASS');
process.exit(failures.length ? 1 : 0);
