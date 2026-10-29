'use strict';
/* A Claude session asks for summarized thinking only when the driver has read
   a CLI version that takes --thinking-display; an older or unknown one would
   refuse to start. Runs the real session against a stand-in SDK that records
   the options it is handed. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { registerHooks } = require('module');

const ROOT = process.env.CONN_ROOT || path.join(__dirname, '..');
const J = JSON.stringify;

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
};

const SDK = `data:text/javascript,${encodeURIComponent(`
  export const query = ({ options }) => { globalThis.__options = options; return (async function* () {})(); };
  export const tool = (name) => ({ name });
  export const createSdkMcpServer = () => ({});
`)}`;
registerHooks({
  resolve: (specifier, context, next) => (specifier === '@anthropic-ai/claude-agent-sdk'
    ? { url: SDK, shortCircuit: true }
    : next(specifier, context)),
});

const { create } = require(path.join(ROOT, 'src/main/providers/claude.js'));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinking-display-check-'));
  const row = create({ cacheDir: dir });
  const bin = process.execPath;
  row.preferBinary(bin);

  const argsFor = async (snapshot) => {
    row.driver.snapshot = { ...row.driver.snapshot, ...snapshot };
    globalThis.__options = null;
    const session = row.createSession({ cwd: dir });
    await session.start();
    session.stop();
    return globalThis.__options?.extraArgs;
  };
  const WANT = J({ 'thinking-display': 'summarized' });

  try {
    check('below-the-floor-gets-no-flag', (await argsFor({ version: '2.1.182', binaryPath: bin })) === undefined, J(globalThis.__options?.extraArgs));
    check('at-the-floor-gets-the-flag', J(await argsFor({ version: '2.1.183', binaryPath: bin })) === WANT, J(globalThis.__options?.extraArgs));
    check('above-the-floor-gets-the-flag', J(await argsFor({ version: '2.2.0', binaryPath: bin })) === WANT, J(globalThis.__options?.extraArgs));
    check('unknown-version-gets-no-flag', (await argsFor({ version: null, binaryPath: bin })) === undefined, J(globalThis.__options?.extraArgs));
    check('another-binarys-version-gets-no-flag', (await argsFor({ version: '2.2.0', binaryPath: '/elsewhere/claude' })) === undefined, J(globalThis.__options?.extraArgs));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(failures.length ? `\n${failures.length} FAIL` : '\nall PASS');
  process.exit(failures.length ? 1 : 0);
})();
