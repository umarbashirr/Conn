'use strict';
const { makeLocator } = require('./find-binary');
const { AcpDriver, probeVersion } = require('./acp-driver');
const { AcpSession } = require('./acp-session');
const { createAcpHistory } = require('./acp-history');
const { AcpCatalog, run } = require('./acp-catalog');
const { modelName } = require('./acp-models');
const { everyMode } = require('../modes');

const locate = makeLocator(['copilot']);

const CATALOG = [{ value: 'auto', displayName: 'Auto' }];

const MODE_URL = 'https://agentclientprotocol.com/protocol/session-modes#';

const MODES = everyMode('copilot', {
  plan: { session: `${MODE_URL}plan` },
  ask: { session: `${MODE_URL}agent` },
  auto: { session: `${MODE_URL}agent` },
  bypass: { session: `${MODE_URL}agent` },
});

// session/new lists no models.
function modelsFromHelp(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^\s*`model`:/.test(l));
  const ids = [];
  for (const line of start < 0 ? [] : lines.slice(start + 1)) {
    if (!line.trim()) break;
    const id = /^\s+-\s+"([^"]+)"\s*$/.exec(line)?.[1];
    if (id) ids.push(id);
  }
  return ids.length ? [CATALOG[0], ...ids.map((value) => ({ value, displayName: modelName(value) }))] : null;
}

const spec = {
  id: 'copilot',
  cli: 'copilot',
  argv: ['--acp', '--stdio'],
  modes: MODES,
  login: 'copilot login',
  missing: 'No GitHub Copilot CLI on your PATH. Install it with npm install -g @github/copilot, run copilot login, then restart Conn.',
  catalog: CATALOG,
  discoverModels: async (bin) => modelsFromHelp((await run(bin, ['help', 'config'], process.cwd())).out),
  binary: () => locate.current(),
  updatesProbe: (bin) => probeVersion(bin),
};

function create({ cacheDir, settings }) {
  locate.prefer(settings?.get?.('copilot')?.binary);
  const driver = new AcpDriver({ spec, cacheDir });
  return {
    id: 'copilot',
    label: 'Copilot',
    cli: 'copilot',
    modelKey: 'copilotModel',
    settingsKey: 'copilot',
    catalogKind: 'acp',
    hasHistory: true,
    driver,
    catalog: new AcpCatalog({ id: 'copilot', spec, cacheDir }),
    history: createAcpHistory({ spec, label: 'Copilot' }),
    spec,
    preferBinary: (p) => locate.prefer(p),
    binary: () => locate.current(),
    createSession: (opts) => new AcpSession({ spec, ...opts }),
    has: () => !!driver.current({ refresh: false }).installed,
    install: 'npm install -g @github/copilot',
    login: 'copilot login',
    update: 'copilot update',
    missing: spec.missing,
    npmPackage: '@github/copilot',
  };
}

module.exports = { create, copilotBinary: () => locate.current(), preferBinary: (p) => locate.prefer(p), probeVersion, modelsFromHelp, CATALOG };
