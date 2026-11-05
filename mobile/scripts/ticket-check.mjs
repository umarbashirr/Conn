import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'scripts', '.ticket-check-out');
const bundle = join(outDir, 'conn-live.mjs');
const storageStub = join(outDir, 'async-storage.mjs');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
writeFileSync(storageStub, `function slot() {
  if (!globalThis.__phoneStore) globalThis.__phoneStore = { mem: new Map(), hold: {}, removes: 0 };
  return globalThis.__phoneStore;
}
async function wait(name) {
  const held = slot().hold[name];
  if (held) await held;
}
const AsyncStorage = {
  async getItem(key) {
    await wait('get');
    const mem = slot().mem;
    return mem.has(key) ? mem.get(key) : null;
  },
  async setItem(key, value) {
    await wait('set');
    slot().mem.set(key, String(value));
  },
  async removeItem(key) {
    slot().removes += 1;
    await wait('remove');
    slot().mem.delete(key);
  },
};
export default AsyncStorage;
`);

await build({
  entryPoints: [join(root, 'src/conn-live.ts')],
  outfile: bundle,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  alias: {
    '@react-native-async-storage/async-storage': storageStub,
  },
});

const KEY = 'conn.phone.ticket';
const project = '/tmp/conn phone';
const ticketA = `conn://gate?${new URLSearchParams({
  url: 'ws://127.0.0.1:4777',
  token: 'alpha-token',
  project,
}).toString()}`;
const ticketB = `conn://gate?${new URLSearchParams({
  url: 'ws://10.0.0.8:4788',
  token: 'beta-token',
  project: '/work/beta',
}).toString()}`;

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static made = [];

  constructor(url) {
    this.url = url;
    this.readyState = FakeSocket.CONNECTING;
    this.sent = [];
    FakeSocket.made.push(this);
    queueMicrotask(() => {
      if (this.readyState !== FakeSocket.CONNECTING) return;
      this.readyState = FakeSocket.OPEN;
      this.onopen?.();
    });
  }

  send(data) {
    this.sent.push(String(data));
  }

  close() {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: '' });
  }
}

globalThis.WebSocket = FakeSocket;

let loads = 0;

function freshStore(hold = {}) {
  globalThis.__phoneStore = { mem: new Map(), hold, removes: 0 };
  FakeSocket.made = [];
  return globalThis.__phoneStore;
}

async function load() {
  loads += 1;
  return import(`${pathToFileURL(bundle).href}?n=${loads}`);
}

async function until(label, fn) {
  for (let i = 0; i < 30; i += 1) {
    if (fn()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function openSockets() {
  return FakeSocket.made.filter((socket) => socket.readyState !== FakeSocket.CLOSED);
}

const empty = freshStore();
const first = await load();
const seen = [];
first.onPhone((next) => seen.push(next));
assert.equal(seen.at(-1), 'pending');
first.connectLive();
await until('empty', () => seen.at(-1) === 'empty');
assert.equal(empty.mem.size, 0);
assert.equal(FakeSocket.made.length, 0);
const events = [];
first.attachLive((event) => events.push(event));
await first.sendTurn('chat-1', { text: 'hello', photos: [] });
assert.equal(events.some((event) => event.item?.id === 'gate-project'), true);
assert.equal(await first.adoptTicket('not a ticket'), false);
assert.equal(empty.mem.size, 0);
assert.equal(FakeSocket.made.length, 0);
assert.equal(openSockets().length, 0);

assert.equal(await first.adoptTicket(`  ${ticketA}\n`), true);
await until('auth', () => FakeSocket.made.some((socket) => socket.sent.length > 0));
assert.equal(empty.mem.get(KEY), ticketA.trim());
assert.equal(openSockets().length, 1);
const firstSocket = openSockets()[0];
assert.equal(firstSocket.url, 'ws://127.0.0.1:4777');
assert.deepEqual(JSON.parse(firstSocket.sent[0]), { op: 'auth', token: 'alpha-token' });
firstSocket.onmessage({ data: JSON.stringify({ op: 'ack', of: 'auth' }) });
await first.sendTurn('chat-1', { text: 'hello from the phone', photos: [] });
const sent = firstSocket.sent.map((raw) => JSON.parse(raw));
const turn = sent.find((frame) => frame.op === 'send');
assert.equal(turn.project, project);
assert.equal(turn.text, 'hello from the phone');

assert.equal(await first.adoptTicket('still not a ticket'), false);
assert.equal(firstSocket.readyState, FakeSocket.OPEN);
assert.equal(empty.mem.get(KEY), ticketA.trim());
assert.equal(openSockets().length, 1);

assert.equal(await first.adoptTicket(ticketB), true);
await until('replaced', () => openSockets().length === 1 && openSockets()[0] !== firstSocket);
assert.equal(firstSocket.readyState, FakeSocket.CLOSED);
assert.equal(openSockets()[0].url, 'ws://10.0.0.8:4788');
assert.equal(events.some((event) => event.item?.text === 'the link to Conn dropped'), false);
assert.equal(empty.mem.get(KEY), ticketB);

const stored = freshStore();
stored.mem.set(KEY, ticketA);
const second = await load();
const storedStatus = [];
second.onPhone((next) => storedStatus.push(next));
second.connectLive();
await until('hydrated socket', () => openSockets().some((socket) => socket.url === 'ws://127.0.0.1:4777'));
assert.equal(storedStatus.at(-1), 'bound');

const corrupt = freshStore();
corrupt.mem.set(KEY, 'not-a-ticket');
const third = await load();
const corruptStatus = [];
third.onPhone((next) => corruptStatus.push(next));
third.connectLive();
await until('corrupt cleared', () => corruptStatus.at(-1) === 'empty');
assert.equal(corrupt.mem.has(KEY), false);
assert.equal(FakeSocket.made.length, 0);

let releaseGet;
const raced = freshStore({
  get: new Promise((resolve) => { releaseGet = resolve; }),
});
const fourth = await load();
fourth.connectLive();
const racedAdopt = fourth.adoptTicket(ticketA);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(raced.removes, 0);
releaseGet();
assert.equal(await racedAdopt, true);
await until('race settled', () => raced.mem.get(KEY) === ticketA);
assert.equal(raced.removes, 0);
assert.equal(raced.mem.get(KEY), ticketA);

let releaseRemove;
const overlap = freshStore({
  remove: new Promise((resolve) => { releaseRemove = resolve; }),
});
overlap.mem.set(KEY, 'garbage');
const fifth = await load();
fifth.connectLive();
await until('remove started', () => overlap.removes === 1);
const adopted = fifth.adoptTicket(ticketB);
await new Promise((resolve) => setImmediate(resolve));
releaseRemove();
assert.equal(await adopted, true);
await until('remove then write', () => overlap.mem.get(KEY) === ticketB);
assert.equal(overlap.mem.get(KEY), ticketB);

let releaseSet;
const late = freshStore({
  set: new Promise((resolve) => { releaseSet = resolve; }),
});
const sixth = await load();
let current = 'pending';
const stopLate = sixth.onPhone((next) => { current = next; });
sixth.connectLive();
await until('late empty', () => current === 'empty');
stopLate();
const older = sixth.adoptTicket(ticketA);
const newer = sixth.adoptTicket(ticketB);
await new Promise((resolve) => setImmediate(resolve));
releaseSet();
assert.equal(await older, false);
assert.equal(await newer, true);
assert.equal(late.mem.get(KEY), ticketB);
await until('newer socket', () => openSockets().length === 1 && openSockets()[0].url === 'ws://10.0.0.8:4788');
assert.equal(openSockets().length, 1);

const liveSrc = readFileSync(join(root, 'src/conn-live.ts'), 'utf8');
assert.equal((liveSrc.match(/\.send\(/g) ?? []).length, 1);

function parsed(sock) {
  return sock.sent.map((raw) => JSON.parse(raw));
}

const linked = freshStore();
const phone = await load();
const phoneStatus = [];
phone.onPhone((next) => phoneStatus.push(next));
phone.connectLive();
await until('linked empty', () => phoneStatus.at(-1) === 'empty');
assert.equal(await phone.adoptTicket(ticketA), true);
await until('linked auth', () => openSockets().some((sock) => sock.sent.length > 0));
const linkedSock = openSockets()[0];
const socketsAfterLink = FakeSocket.made.length;
linkedSock.onmessage({ data: JSON.stringify({ op: 'ack', of: 'auth' }) });
assert.equal(await phone.adoptTicket(ticketA), true);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(openSockets().length, 1);
assert.equal(openSockets()[0], linkedSock);
assert.equal(FakeSocket.made.length, socketsAfterLink);

const movedProject = '/tmp/conn phone/next';
const movedTicket = `conn://gate?${new URLSearchParams({
  url: 'ws://127.0.0.1:4777',
  token: 'alpha-token',
  project: movedProject,
}).toString()}`;
linkedSock.onmessage({ data: JSON.stringify({ op: 'ticket', ticket: movedTicket }) });
await until('folder pushed', () => linked.mem.get(KEY) === movedTicket);
assert.equal(openSockets().length, 1);
assert.equal(openSockets()[0], linkedSock);

await phone.sendTurn('s9', { text: 'fresh', photos: [] });
const freshTurn = parsed(linkedSock).filter((frame) => frame.op === 'send').at(-1);
assert.equal(freshTurn.chat, 's9');
assert.equal(freshTurn.text, 'fresh');
assert.equal(freshTurn.provider, 'claude');
assert.equal(freshTurn.session, null);
assert.equal(freshTurn.project, movedProject);
assert.equal(Object.hasOwn(freshTurn, 'images'), false);

const listedNonce = parsed(linkedSock).filter((frame) => frame.op === 'chats').at(-1).nonce;
linkedSock.onmessage({
  data: JSON.stringify({
    op: 'ack',
    of: 'chats',
    nonce: listedNonce,
    ok: true,
    folder: 'next',
    chats: [{ id: '019a6c', title: 'Zinc', at: 10, provider: 'codex' }],
  }),
});
await phone.sendTurn('h:codex:019a6c', { text: 'continue', photos: [] });
const codexTurn = parsed(linkedSock).filter((frame) => frame.op === 'send').at(-1);
assert.equal(codexTurn.chat, 'h:codex:019a6c');
assert.equal(codexTurn.provider, 'codex');
assert.equal(codexTurn.session, '019a6c');
assert.equal(codexTurn.project, movedProject);

const answered = { questions: [{ question: 'Which files?' }], answers: { 'Which files?': 'src/a.ts' } };
await phone.decidePerm('h:codex:019a6c', 'p-ask', {
  kind: 'answers',
  input: answered,
});
const decision = parsed(linkedSock).filter((frame) => frame.op === 'decide').at(-1);
assert.equal(decision.decision, 'allow');
assert.deepEqual(decision.input, answered);
assert.equal(Object.hasOwn(decision, 'provider'), false);

const noted = [];
phone.attachLive((event) => noted.push(event));
const laterProject = '/tmp/conn phone/later';
const laterTicket = `conn://gate?${new URLSearchParams({
  url: 'ws://127.0.0.1:4777',
  token: 'alpha-token',
  project: laterProject,
}).toString()}`;
const sendsBeforeDrop = parsed(linkedSock).filter((frame) => frame.chat === 'h:codex:019a6c' && frame.op === 'send').length;
linkedSock.onmessage({ data: JSON.stringify({ op: 'ticket', ticket: laterTicket }) });
await until('dropped folder', () => linked.mem.get(KEY) === laterTicket);
await phone.sendTurn('h:codex:019a6c', { text: 'gone', photos: [] });
assert.equal(
  parsed(linkedSock).filter((frame) => frame.chat === 'h:codex:019a6c' && frame.op === 'send').length,
  sendsBeforeDrop,
);
assert.equal(noted.some((event) => event.item?.text === 'That chat is not in this folder.'), true);

let releaseScan;
const pending = freshStore();
const racing = await load();
const racingStatus = [];
racing.onPhone((next) => racingStatus.push(next));
racing.connectLive();
await until('racing empty', () => racingStatus.at(-1) === 'empty');
assert.equal(await racing.adoptTicket(ticketA), true);
await until('racing socket', () => openSockets().some((sock) => sock.url === 'ws://127.0.0.1:4777'));
const racingSock = openSockets()[0];
racingSock.onmessage({ data: JSON.stringify({ op: 'ack', of: 'auth' }) });
pending.hold.set = new Promise((resolve) => { releaseScan = resolve; });
const scanning = racing.adoptTicket(ticketB);
await new Promise((resolve) => setImmediate(resolve));
const pushed = `conn://gate?${new URLSearchParams({
  url: 'ws://127.0.0.1:4777',
  token: 'alpha-token',
  project: '/tmp/conn phone/pushed',
}).toString()}`;
racingSock.onmessage({ data: JSON.stringify({ op: 'ticket', ticket: pushed }) });
releaseScan();
assert.equal(await scanning, true);
await until('scan won', () => pending.mem.get(KEY) === ticketB && openSockets().some((sock) => sock.url === 'ws://10.0.0.8:4788'));
assert.equal(pending.mem.get(KEY), ticketB);
assert.equal(openSockets().some((sock) => sock.url === 'ws://10.0.0.8:4788'), true);

const gateRequire = createRequire(join(root, '..', 'src', 'main', 'mobile-gate.js'));
const { imageHead } = gateRequire('../shared/attachments.js');
const { replyOf, withAnswers } = gateRequire('../shared/ask-answers.js');
const { startMobileGate } = gateRequire('./mobile-gate.js');
const { WebSocket: GateSocket } = gateRequire('ws');

const replayProject = '/tmp/conn phone/replay';
const replayTicket = `conn://gate?${new URLSearchParams({
  url: 'ws://127.0.0.1:4777',
  token: 'alpha-token',
  project: replayProject,
}).toString()}`;
const jpeg = 'aaaa';
freshStore();
const replayPhone = await load();
replayPhone.connectLive();
assert.equal(await replayPhone.adoptTicket(replayTicket), true);
await until('replay socket', () => openSockets().some((sock) => sock.sent.length > 0));
const replaySock = openSockets()[0];
replaySock.onmessage({ data: JSON.stringify({ op: 'ack', of: 'auth' }) });
const replayChats = parsed(replaySock).filter((frame) => frame.op === 'chats').at(-1);
replaySock.onmessage({
  data: JSON.stringify({
    op: 'ack',
    of: 'chats',
    nonce: replayChats.nonce,
    ok: true,
    folder: 'replay',
    chats: [{ id: '019a6c', title: 'Zinc', at: 10, provider: 'codex' }],
  }),
});
await replayPhone.sendTurn('h:codex:019a6c', {
  text: 'see this',
  photos: [{
    name: 'desk.jpg',
    media: 'image/jpeg',
    data: jpeg,
    uri: 'file:///desk.jpg',
    width: 32,
    height: 24,
  }],
});
const questions = [{
  question: 'Which files?',
  options: [{ label: 'src/a.ts', preview: 'keep' }],
}];
const reply = replyOf(questions, { 'Which files?': ['src/a.ts'] }, {});
const replacement = withAnswers({ questions }, reply);
await replayPhone.decidePerm('h:codex:019a6c', 'p-ask', {
  kind: 'answers',
  input: replacement,
});
const rawSend = replaySock.sent.find((raw) => {
  const frame = JSON.parse(raw);
  return frame.op === 'send' && Array.isArray(frame.images);
});
const rawDecide = replaySock.sent.find((raw) => {
  const frame = JSON.parse(raw);
  return frame.op === 'decide' && frame.id === 'p-ask';
});
assert.equal(typeof rawSend, 'string');
assert.equal(typeof rawDecide, 'string');
const phoneSend = JSON.parse(rawSend);
assert.equal(phoneSend.provider, 'codex');
assert.equal(phoneSend.chat, 'h:codex:019a6c');
assert.equal(phoneSend.session, '019a6c');
assert.notEqual(phoneSend.chat, phoneSend.session);
assert.equal(phoneSend.text, `${imageHead('desk.jpg')}\n\nsee this`);
assert.deepEqual(phoneSend.images, [{ media: 'image/jpeg', data: jpeg }]);

const savedEnv = {
  host: process.env.CONN_MOBILE_HOST,
  port: process.env.CONN_MOBILE_PORT,
  token: process.env.CONN_MOBILE_TOKEN,
};
process.env.CONN_MOBILE_HOST = '127.0.0.1';
process.env.CONN_MOBILE_PORT = '0';
process.env.CONN_MOBILE_TOKEN = 'replay-token';
const turns = [];
const decisions = [];
let gate;
let client;
try {
  gate = await startMobileGate({
    focused: () => replayProject,
    knownProject: (dir) => dir === resolve(replayProject),
    deliverTurn: async (turn) => {
      turns.push(turn);
      return { sessionId: 'kept' };
    },
    deliverDecision: (decision) => {
      decisions.push(decision);
      return true;
    },
    listChats: async () => ({ folder: 'replay', chats: [] }),
    readTranscript: async () => ({ messages: [] }),
  });
  const card = gate.card();
  assert.equal(card.status, 'ready', card.note);
  const dial = card.lines.find((line) => line.label === 'Address').value;
  client = new GateSocket(dial);
  await new Promise((resolveOpen, rejectOpen) => {
    client.once('open', resolveOpen);
    client.once('error', rejectOpen);
  });
  const heard = [];
  const authed = new Promise((resolveAuth, rejectAuth) => {
    const timer = setTimeout(() => rejectAuth(new Error(`auth ack missing: ${heard.join(' | ')}`)), 2000);
    client.on('message', (data) => {
      const text = String(data);
      heard.push(text);
      const frame = JSON.parse(text);
      if (frame.op === 'ack' && frame.of === 'auth') {
        clearTimeout(timer);
        resolveAuth();
      }
    });
  });
  client.send(JSON.stringify({ op: 'auth', token: 'replay-token' }));
  await authed;
  client.send(rawSend);
  client.send(rawDecide);
  const started = Date.now();
  while (turns.length < 1 || decisions.length < 1) {
    if (Date.now() - started > 2000) {
      throw new Error(`gate did not deliver: ${heard.join(' | ')}`);
    }
    await new Promise((settle) => setTimeout(settle, 10));
  }
  assert.equal(turns[0].provider, 'codex');
  assert.equal(turns[0].chat, 'h:codex:019a6c');
  assert.equal(turns[0].session, '019a6c');
  assert.notEqual(turns[0].chat, turns[0].session);
  assert.equal(turns[0].text, `${imageHead('desk.jpg')}\n\nsee this`);
  assert.deepEqual(turns[0].images, [{ media: 'image/jpeg', data: jpeg }]);
  assert.equal(turns[0].project, resolve(replayProject));
  assert.equal(decisions[0].decision, 'allow');
  assert.equal(decisions[0].id, 'p-ask');
  assert.deepEqual(decisions[0].input, replacement);
} finally {
  if (client) client.close();
  if (gate) gate.stop();
  if (savedEnv.host === undefined) delete process.env.CONN_MOBILE_HOST;
  else process.env.CONN_MOBILE_HOST = savedEnv.host;
  if (savedEnv.port === undefined) delete process.env.CONN_MOBILE_PORT;
  else process.env.CONN_MOBILE_PORT = savedEnv.port;
  if (savedEnv.token === undefined) delete process.env.CONN_MOBILE_TOKEN;
  else process.env.CONN_MOBILE_TOKEN = savedEnv.token;
}

console.log('ticket-check ok');
