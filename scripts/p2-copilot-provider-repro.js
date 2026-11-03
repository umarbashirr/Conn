#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = process.env.CONN_ROOT || path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-copilot-'));

const shellEnv = require(path.join(ROOT, 'src/main/shell-env'));
shellEnv.ready = async () => process.env.PATH || '';
shellEnv.env = () => ({ ...process.env });
shellEnv.cached = () => process.env.PATH || '';

const { AcpSession } = require(path.join(ROOT, 'src/main/providers/acp-session.js'));
const { copilotSkills, copilotServers } = require(path.join(ROOT, 'src/main/providers/acp-catalog.js'));
const copilot = require(path.join(ROOT, 'src/main/providers/copilot.js'));
const { parseVersion } = require(path.join(ROOT, 'src/main/providers/acp-driver.js'));

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
};

const URL = 'https://agentclientprotocol.com/protocol/session-modes#';
const row = copilot.create({ cacheDir: tmp, settings: { get: () => ({}) } });

function checkModels() {
  const help = fs.readFileSync(path.join(ROOT, 'scripts/fixtures/copilot-help-config.txt'), 'utf8');
  const models = copilot.modelsFromHelp(help);
  check('models-start-with-auto', models?.[0].value === 'auto' && models[0].displayName === 'Auto', JSON.stringify(models?.[0]));
  check('models-stop-at-blank-line', models?.at(-1).value === 'kimi-k3', models?.at(-1).value);
  check('models-count', models?.length === 32, models?.length);
  const named = Object.fromEntries((models || []).map((m) => [m.value, m.displayName]));
  check('models-are-named', named['claude-sonnet-5.5'] === 'Claude Sonnet 5.5' && named['gpt-6.1-sol'] === 'GPT-6.1 Sol', JSON.stringify(named));
  check('models-absent-section-is-null', copilot.modelsFromHelp('no model entry here\n') === null);
}

function checkVersion() {
  check('version-from-two-line-output', parseVersion("GitHub Copilot CLI 1.0.105.\nRun 'copilot update' to check for updates.\n") === '1.0.105');
}

function checkModes() {
  const { modes } = row.spec;
  check('plan-is-plan-url', modes.plan.session === `${URL}plan`, modes.plan.session);
  for (const mode of ['ask', 'auto', 'bypass']) {
    check(`${mode}-is-agent-url`, modes[mode].session === `${URL}agent`, modes[mode].session);
  }
  check('bypass-needs-no-launch-setting', !modes.bypass.argv && !modes.bypass.env && !modes.bypass.meta, JSON.stringify(modes.bypass));
  check('launched-with-acp-stdio', row.spec.argv.join(' ') === '--acp --stdio');
  check('row-shape', row.settingsKey === 'copilot' && row.modelKey === 'copilotModel' && row.npmPackage === '@github/copilot' && row.hasHistory, row.id);
}

function checkCatalogParsers() {
  const skills = copilotSkills([
    'Personal skills:', '  caveman - Ultra compressed', '  deslop - Clean up', '',
    'Project skills:', '  verify - Boot the app', '',
  ].join('\n'));
  check('skill-sources', skills.get('caveman') === 'user' && skills.get('verify') === 'project' && !skills.has('compact'), JSON.stringify([...skills]));
  const servers = copilotServers([
    'Builtin servers:', '  github-mcp-server (http)', '', 'User servers:', '  demo (local, disabled)', '  web (http)', '',
  ].join('\n'));
  check('mcp-list-parsed', JSON.stringify(servers) === JSON.stringify([
    { name: 'github-mcp-server', scope: 'builtin', type: 'http', disabled: false },
    { name: 'demo', scope: 'user', type: 'local', disabled: true },
    { name: 'web', scope: 'user', type: 'http', disabled: false },
  ]), JSON.stringify(servers));
}

async function checkSession() {
  const log = path.join(tmp, 'mock.log');
  const MOCK = path.join(ROOT, 'scripts/mock-acp-cli.js');
  const env = { MOCK_ACP_MODE_IDS: `${URL}agent,${URL}plan,${URL}autopilot`, MOCK_ACP_LOG: log };
  const spec = {
    ...row.spec,
    argv: [MOCK, 'acp'],
    modes: Object.fromEntries(Object.entries(row.spec.modes).map(([m, entry]) => [m, { ...entry, env }])),
    binary: () => process.execPath,
  };
  const modesSet = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '').split('\n').filter(Boolean)
    .map((l) => JSON.parse(l)).filter((e) => e.method === 'session/set_mode').map((e) => e.modeId);
  const session = new AcpSession({ spec, cwd: tmp, mode: 'plan' });
  try {
    await session.start();
    check('start-in-plan-selects-plan-url', modesSet().at(-1) === `${URL}plan`, modesSet());
    await session.setMode('bypass');
    check('bypass-selects-agent-url', modesSet().at(-1) === `${URL}agent` && !session.stale, modesSet());
  } finally {
    session.stop();
  }
}

(async () => {
  try {
    checkModels();
    checkVersion();
    checkModes();
    checkCatalogParsers();
    await checkSession();
  } catch (e) {
    check('probe-threw', false, e.stack || e.message);
  }
  console.log(failures.length ? `\n${failures.length} failure(s)` : '\nall passed');
  process.exit(failures.length ? 1 : 0);
})();
