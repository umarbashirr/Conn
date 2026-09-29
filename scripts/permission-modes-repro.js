#!/usr/bin/env node
'use strict';
// Every mode on every provider, against stand-ins that answer the way the real
// CLIs were measured to: what each is launched with, which session mode it is
// put in, and whether a permission request becomes a card or an answer.
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { EventEmitter } = require('events');

const FLAVORS = {
  cursor: {
    session: { modes: { currentModeId: 'agent', availableModes: [{ id: 'agent' }, { id: 'plan' }, { id: 'ask' }] } },
    options: [['allow-once', 'allow_once'], ['allow-always', 'allow_always'], ['reject-once', 'reject_once']],
  },
  opencode: {
    session: { configOptions: [{ id: 'mode', category: 'mode', type: 'select', currentValue: 'build', options: [{ value: 'build' }, { value: 'plan' }] }] },
    options: [['once', 'allow_once'], ['always', 'allow_always'], ['reject', 'reject_once']],
  },
  grok: {
    session: {},
    options: [['allow', 'allow_once'], ['always', 'allow_always'], ['deny', 'reject_once']],
  },
};

function agent() {
  const flavor = FLAVORS[process.env.FAKE_FLAVOR];
  const log = (entry) => fs.appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ pid: process.pid, cwd: process.cwd(), ...entry })}\n`);
  const send = (obj) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...obj })}\n`);
  const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });
  log({ argv: process.argv.slice(3), config: process.env.OPENCODE_CONFIG_CONTENT || null });
  process.on('SIGTERM', () => { log({ ended: true }); process.exit(0); });
  let prompt = null;
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const { id, method, params = {}, result } = JSON.parse(line);
    if (id === 'perm' && prompt) {
      log({ answer: result?.outcome?.optionId || result?.outcome?.outcome });
      send({ id: prompt, result: { stopReason: 'end_turn' } });
      prompt = null;
      return;
    }
    if (method === 'initialize') return send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    if (method === 'session/new' || method === 'session/load') {
      log({ method, meta: params._meta || null });
      if (process.env.FAKE_REFUSE && fs.existsSync(process.env.FAKE_REFUSE)) return send({ id, error: { code: -32000, message: 'not authenticated' } });
      const sessionId = params.sessionId || 'S1';
      if (method === 'session/load') update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPLAYED' } });
      return send({ id, result: { sessionId, ...flavor.session } });
    }
    if (method === 'session/set_mode' || method === 'session/set_config_option') {
      const mode = params.modeId || params.value;
      log({ set: mode });
      if (process.env.FAKE_FLAVOR === 'cursor') update(params.sessionId, { sessionUpdate: 'current_mode_update', currentModeId: mode });
      return send({ id, result: {} });
    }
    if (method === 'session/prompt') {
      prompt = id;
      const [kind, command] = params.prompt.find((b) => b.type === 'text').text.trim().split('\n').pop().split(':');
      return send({
        id: 'perm',
        method: 'session/request_permission',
        params: {
          sessionId: params.sessionId,
          toolCall: { toolCallId: 't1', title: command, kind, rawInput: kind === 'execute' ? { command } : { path: command } },
          options: flavor.options.map(([optionId, k]) => ({ optionId, name: optionId, kind: k })),
        },
      });
    }
    if (id !== undefined) send({ id, result: {} });
  });
}

if (process.argv[2] === '--agent') {
  if (process.argv.includes('--version')) process.stdout.write('fake-agent 1.0.0\n');
  else agent();
  return;
}

const ROOT = process.env.CONN_ROOT || path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-modes-'));

const shellEnv = require(path.join(ROOT, 'src/main/shell-env'));
shellEnv.ready = async () => process.env.PATH || '';
shellEnv.env = () => ({ ...process.env });
shellEnv.cached = () => process.env.PATH || '';

class FakeAppServer extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    FakeAppServer.last = this;
  }
  async start() {}
  async request(method, params) {
    this.sent.push({ method, params });
    if (method.startsWith('thread/')) return { thread: { id: params.threadId || 'T1' } };
    if (method === 'turn/start') return { turn: { id: `turn${this.sent.length}` } };
    return {};
  }
  stop() {}
  kill() {}
}
require(path.join(ROOT, 'src/main/codex-rpc')).AppServer = FakeAppServer;
require(path.join(ROOT, 'src/main/codex-driver')).codexBinary = () => '/fake/codex';

const { AcpSession } = require(path.join(ROOT, 'src/main/providers/acp-session.js'));
const { CodexSession } = require(path.join(ROOT, 'src/main/codex.js'));
const PROVIDERS = {
  cursor: require(path.join(ROOT, 'src/main/providers/cursor.js')),
  opencode: require(path.join(ROOT, 'src/main/providers/opencode.js')),
  grok: require(path.join(ROOT, 'src/main/providers/grok.js')),
};

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
};

const WRAPPER = path.join(tmp, 'fake-agent');
fs.writeFileSync(WRAPPER, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(__filename)} --agent "$@"\n`);
fs.chmodSync(WRAPPER, 0o755);

let logs = 0;
async function open(flavor, mode, resume) {
  const log = path.join(tmp, `${flavor}-${++logs}.log`);
  fs.writeFileSync(log, '');
  process.env.FAKE_FLAVOR = flavor;
  process.env.FAKE_LOG = log;
  const real = PROVIDERS[flavor].create({ cacheDir: tmp, settings: { get: () => ({}) } }).spec;
  const session = new AcpSession({ spec: { ...real, binary: () => WRAPPER }, cwd: tmp, mode, resume });
  session.cards = [];
  session.text = '';
  session.on('permission', (card) => { session.cards.push(card); session.decide(card.id, 'deny'); });
  session.on('message', (m) => { if (m.type === 'stream_event' && m.event?.delta?.text) session.text += m.event.delta.text; });
  await session.start();
  session.log = () => fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return session;
}

function turn(session, text) {
  return new Promise((resolve) => {
    const on = (m) => {
      if (m.type !== 'result') return;
      session.off('message', on);
      resolve(session.log().filter((e) => 'answer' in e).pop()?.answer);
    };
    session.on('message', on);
    session.send(text);
  });
}

const launched = (s) => s.log()[0];
const began = (s) => s.log().find((e) => e.method);
const modesSet = (s) => s.log().filter((e) => 'set' in e).map((e) => e.set);
const permission = (s, what) => JSON.parse(launched(s).config || '{}').permission?.bash === what;

// What bypass is at launch, per provider, and that nothing below bypass has it.
const NATIVE = {
  cursor: (s) => launched(s).argv.join(' ') === '--force acp',
  opencode: (s) => permission(s, 'allow'),
  grok: (s) => began(s).meta?.yoloMode === true && launched(s).argv.join(' ') === 'agent stdio',
};
const GATED = {
  cursor: (s) => launched(s).argv.join(' ') === 'acp',
  opencode: (s) => permission(s, 'ask'),
  grok: (s) => began(s).meta === null,
};
const WORKING = { cursor: 'agent', opencode: 'build', grok: undefined };
const PLAN = { cursor: 'plan', opencode: 'plan', grok: undefined };
const ALLOW_ONCE = { cursor: 'allow-once', opencode: 'once', grok: 'allow' };
const REJECT = { cursor: 'reject-once', opencode: 'reject', grok: 'deny' };

async function checkAcp(flavor) {
  const bypass = await open(flavor, 'bypass');
  check(`${flavor}-bypass-native-at-launch`, NATIVE[flavor](bypass), JSON.stringify(bypass.log().slice(0, 2)));
  check(`${flavor}-bypass-working-session-mode`, modesSet(bypass).at(-1) === WORKING[flavor], modesSet(bypass));
  const risky = await turn(bypass, 'execute:rm -rf /tmp/conn-nothing');
  check(`${flavor}-bypass-auto-approves`, risky === ALLOW_ONCE[flavor] && bypass.cards.length === 0, `${risky} cards=${bypass.cards.length}`);
  const write = await turn(bypass, 'edit:/etc/nothing');
  check(`${flavor}-bypass-auto-approves-edit`, write === ALLOW_ONCE[flavor] && bypass.cards.length === 0, write);

  const ask = await open(flavor, 'ask');
  check(`${flavor}-ask-not-launched-bypass`, GATED[flavor](ask), JSON.stringify(ask.log().slice(0, 2)));
  check(`${flavor}-ask-can-work`, modesSet(ask).at(-1) === WORKING[flavor], modesSet(ask));
  const asked = await turn(ask, 'execute:ls');
  check(`${flavor}-ask-shows-card`, ask.cards.length === 1 && asked === REJECT[flavor], `${asked} cards=${ask.cards.length}`);

  const auto = await open(flavor, 'auto');
  check(`${flavor}-auto-not-launched-bypass`, GATED[flavor](auto));
  const plain = await turn(auto, 'execute:ls');
  check(`${flavor}-auto-runs-plain-shell`, plain === ALLOW_ONCE[flavor] && auto.cards.length === 0, `${plain} cards=${auto.cards.length}`);
  const edit = await turn(auto, 'edit:src/a.js');
  check(`${flavor}-auto-runs-edits`, edit === ALLOW_ONCE[flavor] && auto.cards.length === 0, edit);
  await turn(auto, 'execute:rm -rf build');
  check(`${flavor}-auto-carded-risky-shell`, auto.cards.length === 1, auto.cards.length);

  const plan = await open(flavor, 'plan');
  check(`${flavor}-plan-not-launched-bypass`, GATED[flavor](plan));
  check(`${flavor}-plan-session-mode`, modesSet(plan).at(-1) === PLAN[flavor], modesSet(plan));
  const refused = await turn(plan, 'edit:src/a.js');
  check(`${flavor}-plan-refuses-without-card`, refused === REJECT[flavor] && plan.cards.length === 0, refused);

  // Mid-chat. Plan and back moves the session mode in place.
  await ask.setMode('plan');
  check(`${flavor}-ask-to-plan-in-place`, !ask.stale && modesSet(ask).at(-1) === PLAN[flavor], `stale=${ask.stale} ${modesSet(ask)}`);
  const inPlan = await turn(ask, 'edit:src/a.js');
  check(`${flavor}-ask-to-plan-next-action-refused`, inPlan === REJECT[flavor], inPlan);
  check(`${flavor}-agent-echo-keeps-plan`, ask.mode === 'plan', ask.mode);

  // Into bypass needs launch settings the process lacks, so main restarts it on the same session.
  await plan.setMode('bypass');
  check(`${flavor}-plan-to-bypass-leaves-plan`, modesSet(plan).at(-1) === WORKING[flavor], modesSet(plan));
  check(`${flavor}-plan-to-bypass-is-stale`, plan.stale === true, plan.stale);
  const sessionId = plan.sessionId;
  plan.stop();
  const resumed = await open(flavor, 'bypass', sessionId);
  check(`${flavor}-restart-resumes-same-session`, began(resumed).method === 'session/load' && resumed.sessionId === sessionId, JSON.stringify(began(resumed)));
  check(`${flavor}-restart-native-bypass`, NATIVE[flavor](resumed), JSON.stringify(resumed.log().slice(0, 2)));
  check(`${flavor}-restart-no-replayed-transcript`, !resumed.text.includes('REPLAYED'), resumed.text);
  const after = await turn(resumed, 'execute:rm -rf /tmp/conn-nothing');
  check(`${flavor}-restart-next-action-auto-approved`, after === ALLOW_ONCE[flavor] && resumed.cards.length === 0, after);

  // Leaving bypass drops the launch settings the same way.
  await resumed.setMode('ask');
  check(`${flavor}-bypass-to-ask-is-stale`, resumed.stale === true, resumed.stale);
  const still = await turn(resumed, 'execute:ls');
  check(`${flavor}-bypass-to-ask-cards-next-action`, resumed.cards.length === 1 && still === REJECT[flavor], `${still} cards=${resumed.cards.length}`);

  for (const s of [bypass, ask, auto, resumed]) s.stop();
}

async function codex(mode, resume) {
  const session = new CodexSession({ cwd: tmp, mode, resume });
  session.cards = [];
  session.on('permission', (card) => { session.cards.push(card); session.decide(card.id, 'deny'); });
  await session.start();
  session.rpc = FakeAppServer.last;
  return session;
}

function approve(session, command) {
  return new Promise((resolve) => {
    session.rpc.emit('request', 'item/commandExecution/requestApproval', { command, cwd: tmp }, resolve);
  });
}

async function checkCodex() {
  const bypass = await codex('bypass');
  const start = bypass.rpc.sent.find((r) => r.method === 'thread/start').params;
  check('codex-bypass-native-at-launch', start.sandbox === 'danger-full-access' && start.approvalPolicy === 'never', JSON.stringify(start));
  const risky = await approve(bypass, 'rm -rf /tmp/conn-nothing');
  check('codex-bypass-auto-approves', risky.decision === 'accept' && bypass.cards.length === 0, JSON.stringify(risky));

  const ask = await codex('ask');
  const askStart = ask.rpc.sent.find((r) => r.method === 'thread/start').params;
  check('codex-ask-launch', askStart.sandbox === 'workspace-write' && askStart.approvalPolicy === 'on-request', JSON.stringify(askStart));
  const asked = await approve(ask, 'ls');
  check('codex-ask-shows-card', ask.cards.length === 1 && asked.decision === 'decline', JSON.stringify(asked));

  const auto = await codex('auto');
  check('codex-auto-runs-plain-shell', (await approve(auto, 'ls')).decision === 'accept' && auto.cards.length === 0);
  await approve(auto, 'rm -rf build');
  check('codex-auto-carded-risky-shell', auto.cards.length === 1, auto.cards.length);

  const plan = await codex('plan');
  const planStart = plan.rpc.sent.find((r) => r.method === 'thread/start').params;
  check('codex-plan-read-only', planStart.sandbox === 'read-only', planStart.sandbox);
  check('codex-plan-refuses-without-card', (await approve(plan, 'touch a')).decision === 'decline' && plan.cards.length === 0);

  await ask.setMode('bypass');
  ask.send('go');
  await ask.starting;
  const lifted = ask.rpc.sent.filter((r) => r.method === 'turn/start').pop().params;
  check('codex-mid-chat-bypass-next-turn', lifted.sandboxPolicy?.type === 'dangerFullAccess' && lifted.approvalPolicy === 'never', JSON.stringify(lifted));
  ask.busy = false;
  await ask.setMode('ask');
  ask.send('go');
  await ask.starting;
  const tightened = ask.rpc.sent.filter((r) => r.method === 'turn/start').pop().params;
  check('codex-mid-chat-back-to-ask', tightened.sandboxPolicy?.type === 'workspaceWrite' && tightened.approvalPolicy === 'on-request', JSON.stringify(tightened));

  const resumed = await codex('bypass', 'T9');
  const resume = resumed.rpc.sent.find((r) => r.method === 'thread/resume')?.params;
  check('codex-resume-keeps-bypass', resume?.threadId === 'T9' && resume.sandbox === 'danger-full-access' && resume.approvalPolicy === 'never', JSON.stringify(resume));
}

(async () => {
  try {
    for (const flavor of Object.keys(PROVIDERS)) await checkAcp(flavor);
    await checkCodex();
  } catch (e) {
    check('repro-threw', false, e.stack || e);
  }
  console.log(failures.length ? `\n${failures.length} FAIL(s)` : '\nALL PASS');
  process.exit(failures.length ? 1 : 0);
})();
