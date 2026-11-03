import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
await first.sendTurn('chat-1', 'hello');
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
await first.sendTurn('chat-1', 'hello from the phone');
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

console.log('ticket-check ok');
