'use strict';
const { makeLocator } = require('./find-binary');
const { AcpDriver, probeVersion } = require('./acp-driver');
const { AcpSession } = require('./acp-session');
const history = require('./stub-history');
const { AcpCatalog } = require('./acp-catalog');
const { everyMode } = require('../modes');

const locate = makeLocator(['grok']);

const CATALOG = [
  { value: 'grok-4.7', displayName: 'Grok 4.7' },
  { value: 'grok-4.7-build-fast', displayName: 'Grok 4.7 Fast' },
  { value: 'grok-4.6', displayName: 'Grok 4.6' },
  { value: 'grok-4.5', displayName: 'Grok 4.5' },
];

/* Grok offers no session modes over ACP, so Conn's cards are the only gate below
   bypass. Its always-approve is asked for on session/new and holds for that
   session, so leaving or entering bypass needs a new one. A permission_mode of
   always-approve in ~/.grok/config.toml wins over anything a client sends. */
const MODES = everyMode('grok', {
  plan: {},
  ask: {},
  auto: {},
  bypass: { meta: { yoloMode: true } },
});

const spec = {
  id: 'grok',
  cli: 'grok',
  argv: ['agent', 'stdio'],
  modes: MODES,
  login: 'grok login',
  missing: 'No Grok CLI on your PATH. Install it from x.ai/cli, run grok login, then restart Conn.',
  catalog: CATALOG,
  binary: () => locate.current(),
  updatesProbe: (bin) => probeVersion(bin),
};

function create({ cacheDir, settings }) {
  locate.prefer(settings?.get?.('grok')?.binary);
  const driver = new AcpDriver({ spec, cacheDir });
  return {
    id: 'grok',
    label: 'Grok',
    cli: 'grok',
    modelKey: 'grokModel',
    settingsKey: 'grok',
    catalogKind: 'acp',
    hasHistory: false,
    driver,
    catalog: new AcpCatalog({ id: 'grok', spec, cacheDir }),
    history,
    spec,
    preferBinary: (p) => locate.prefer(p),
    binary: () => locate.current(),
    createSession: (opts) => new AcpSession({ spec, ...opts }),
    has: () => !!driver.current({ refresh: false }).installed,
    install: 'See https://x.ai/cli',
    login: 'grok login',
    update: 'See https://x.ai/cli',
    missing: spec.missing,
    npmPackage: null,
  };
}

module.exports = { create, grokBinary: () => locate.current(), preferBinary: (p) => locate.prefer(p), probeVersion, CATALOG };
