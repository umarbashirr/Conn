import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { encodeTicket, decodeTicket } = require(join(root, 'src/shared/phone-ticket.js'));

const ticket = {
  url: 'ws://127.0.0.1:4777',
  token: 'abc123',
  project: '/tmp/conn phone/a+b?c&d#e',
};

const encoded = encodeTicket(ticket);
assert.equal(typeof encoded, 'string');
assert.equal(encoded.startsWith('conn://gate?'), true);
const decoded = decodeTicket(encoded);
assert.deepEqual(decoded, ticket);
assert.deepEqual(decodeTicket(`  ${encoded}\n`), ticket);

const ipv6 = encodeTicket({
  url: 'ws://[::1]:4777',
  token: 'abc',
  project: '/tmp/v6',
});
assert.deepEqual(decodeTicket(ipv6), {
  url: 'ws://[::1]:4777',
  token: 'abc',
  project: '/tmp/v6',
});

assert.equal(decodeTicket(encodeTicket({
  url: 'wss://phone.example:443',
  token: 't',
  project: '/work',
})).url, 'wss://phone.example:443');

const rejects = [
  null,
  1,
  '',
  '   ',
  'http://gate?url=ws://h:1&token=a&project=/p',
  'conn://other?url=ws://h:1&token=a&project=/p',
  'conn://user@gate?url=ws://h:1&token=a&project=/p',
  'conn://gate/extra?url=ws://h:1&token=a&project=/p',
  `conn://gate?url=ws://h:1&token=a&project=/p#x`,
  'conn://gate?url=ws://h:1&token=a',
  'conn://gate?url=ws://h:1&token=a&project=/p&extra=1',
  'conn://gate?url=ws://h:1&url=ws://h:1&token=a&project=/p',
  'conn://gate?url=ws://127.0.0.1&token=a&project=/p',
  'conn://gate?url=ws://127.0.0.1:1/gate&token=a&project=/p',
  'conn://gate?url=ws://127.0.0.1:1?x=1&token=a&project=/p',
  'conn://gate?url=http://127.0.0.1:1&token=a&project=/p',
  'conn://gate?url=not a url&token=a&project=/p',
  'conn://gate?url=ws://127.0.0.1:1&token=&project=/p',
  'conn://gate?url=ws://127.0.0.1:1&token=a+b&project=/p',
  'conn://gate?url=ws://127.0.0.1:1&token=a&project=',
  'conn://gate?url=ws://127.0.0.1:1&token=a&project=/p%0A',
];
for (const raw of rejects) assert.equal(decodeTicket(raw), null, `rejected ${JSON.stringify(raw)}`);

assert.throws(() => encodeTicket(null), /bad ticket/);
assert.throws(() => encodeTicket({ url: 'ws://h:1', token: 'a' }), /bad ticket/);
assert.deepEqual(decodeTicket(encodeTicket({
  url: 'ws://127.0.0.1:80',
  token: 't',
  project: '/p',
})), { url: 'ws://127.0.0.1:80', token: 't', project: '/p' });

const { startMobileGate } = require(join(root, 'src/main/mobile-gate.js'));

async function withEnv(vars, fn) {
  const prev = new Map();
  for (const [key, value] of Object.entries(vars)) {
    prev.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of prev) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const asked = { chats: [], transcripts: [] };
const gateDeps = {
  knownProject: (dir) => dir !== '/tmp/closed',
  deliverTurn: async () => ({ sessionId: null }),
  deliverDecision: () => true,
  listChats: async (dir) => {
    asked.chats.push(dir);
    return {
      folder: 'folder',
      chats: [{ id: 'abc', title: 'Zinc tokens', at: 10, provider: 'claude' }],
    };
  },
  readTranscript: async (dir, id, provider) => {
    asked.transcripts.push({ dir, id, provider });
    return {
      id,
      messages: [{
        type: 'user',
        uuid: 'u1',
        message: { content: [{ type: 'text', text: 'hello' }] },
      }],
    };
  },
};

const packaged = await startMobileGate({ packaged: true, ...gateDeps });
assert.deepEqual(packaged.card('/tmp/folder'), {
  status: 'off',
  note: 'Phone link is off in an installed Conn. Run a checkout to use it.',
});

const invalid = await withEnv({ CONN_MOBILE_PORT: 'nope' }, () => (
  startMobileGate({ packaged: false, ...gateDeps })
));
assert.deepEqual(invalid.card('/tmp/folder'), { status: 'off', note: 'Phone link is off.' });

const project = '/tmp/conn phone/folder';
const gate = await withEnv({
  CONN_MOBILE_HOST: '127.0.0.1',
  CONN_MOBILE_PORT: '0',
  CONN_MOBILE_TOKEN: 'ticket-token',
}, () => startMobileGate({ packaged: false, ...gateDeps }));
try {
  const card = gate.card(project);
  assert.equal(card.status, 'ready');
  const round = decodeTicket(card.ticket);
  assert.ok(round);
  assert.equal(round.token, 'ticket-token');
  assert.equal(round.project, project);
  assert.match(round.url, /^ws:\/\/127\.0\.0\.1:\d+$/);
  assert.notEqual(new URL(round.url).port, '');
  assert.deepEqual(card.lines, [
    { label: 'Address', value: round.url },
    { label: 'Token', value: round.token },
    { label: 'Folder', value: round.project },
  ]);
  assert.deepEqual(gate.card(''), {
    status: 'off',
    note: 'Open a folder to put it on the phone link.',
  });
  assert.deepEqual(gate.card(null), {
    status: 'off',
    note: 'Open a folder to put it on the phone link.',
  });

  const frames = [];
  const phone = new WebSocket(round.url);
  phone.on('message', (buf) => frames.push(JSON.parse(buf.toString())));
  await new Promise((resolve, reject) => {
    phone.once('open', resolve);
    phone.once('error', reject);
  });
  phone.send(JSON.stringify({ op: 'auth', token: round.token }));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('auth timed out')), 2000);
    phone.on('message', () => {
      if (frames.some((frame) => frame.op === 'ack' && frame.of === 'auth')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  gate.publish('phone:card', { ticket: card.ticket });
  gate.publish('agent:ready', { chat: 'c1', sessionId: 's1' });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no live frame ${JSON.stringify(frames)}`)), 1000);
    const check = () => {
      if (!frames.some((frame) => frame.op === 'live' && frame.channel === 'agent:ready')) return;
      clearTimeout(timer);
      resolve();
    };
    check();
    phone.on('message', check);
  });
  assert.equal(frames.some((frame) => frame.channel === 'phone:card'), false);

  function waitFor(pred, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} ${JSON.stringify(frames)}`)), 2000);
      const check = () => {
        if (!pred()) return;
        clearTimeout(timer);
        resolve();
      };
      check();
      phone.on('message', check);
    });
  }

  phone.send(JSON.stringify({ op: 'chats', project, nonce: 'c1' }));
  await waitFor(
    () => frames.some((frame) => frame.of === 'chats' && frame.nonce === 'c1' && frame.ok === true),
    'chats',
  );
  const listed = frames.find((frame) => frame.of === 'chats' && frame.nonce === 'c1');
  assert.equal(listed.folder, 'folder');
  assert.deepEqual(listed.chats, [{ id: 'abc', title: 'Zinc tokens', at: 10, provider: 'claude' }]);
  assert.deepEqual(asked.chats, [project]);

  phone.send(JSON.stringify({
    op: 'transcript',
    project,
    id: 'abc',
    provider: 'claude',
    nonce: 't1',
  }));
  await waitFor(
    () => frames.some((frame) => frame.of === 'transcript' && frame.nonce === 't1' && frame.ok === true),
    'transcript',
  );
  const replay = frames.find((frame) => frame.of === 'transcript' && frame.nonce === 't1');
  assert.equal(replay.id, 'abc');
  assert.equal(replay.messages[0].message.content[0].text, 'hello');
  assert.deepEqual(asked.transcripts, [{ dir: project, id: 'abc', provider: 'claude' }]);

  phone.send(JSON.stringify({ op: 'chats', project: '/tmp/closed', nonce: 'c2' }));
  await waitFor(
    () => frames.some((frame) => frame.of === 'chats' && frame.nonce === 'c2'),
    'closed folder',
  );
  const closed = frames.find((frame) => frame.of === 'chats' && frame.nonce === 'c2');
  assert.equal(closed.error, 'That folder is not open in Conn.');
  assert.equal(asked.chats.length, 1);

  phone.send(JSON.stringify({ op: 'chats', project, nonce: 'c3', extra: true }));
  await waitFor(
    () => frames.some((frame) => frame.of === 'chats' && frame.nonce === 'c3'),
    'bad chats',
  );
  assert.equal(frames.find((frame) => frame.of === 'chats' && frame.nonce === 'c3').error, 'bad chats');

  phone.close();
} finally {
  gate.stop();
}

const wild = await withEnv({
  CONN_MOBILE_HOST: undefined,
  CONN_MOBILE_PORT: '0',
  CONN_MOBILE_TOKEN: 'wild-token',
}, () => startMobileGate({ packaged: false, ...gateDeps }));
try {
  const card = wild.card('/tmp/proj');
  if (card.status === 'ready') {
    const round = decodeTicket(card.ticket);
    assert.ok(round);
    assert.equal(round.url.startsWith('ws://0.0.0.0:'), false);
    assert.match(round.url, /^ws:\/\/.+:\d+$/);
    assert.equal(round.token, 'wild-token');
  } else {
    assert.equal(card.note, 'This computer has no network address the phone can reach.');
  }
} finally {
  wild.stop();
}

const blocker = createServer();
await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
const blockedPort = blocker.address().port;
try {
  const failed = await withEnv({
    CONN_MOBILE_HOST: '127.0.0.1',
    CONN_MOBILE_PORT: String(blockedPort),
  }, () => startMobileGate({ packaged: false, ...gateDeps }));
  assert.deepEqual(failed.card('/tmp/folder'), { status: 'off', note: 'Phone link is off.' });
} finally {
  await new Promise((resolve) => blocker.close(resolve));
}

const gateSrc = readFileSync(join(root, 'src/main/mobile-gate.js'), 'utf8');
const fanout = gateSrc.match(/const FANOUT = new Set\(\[([\s\S]*?)\]\)/);
assert.ok(fanout);
const fanoutNames = [...fanout[1].matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]);
assert.equal(fanoutNames.some((name) => name.startsWith('phone:')), false);

const indexSrc = readFileSync(join(root, 'src/main/index.js'), 'utf8');
assert.match(indexSrc, /ipcMain\.handle\('phone:card', \(\) => mobileGate\.card\(focused\)\)/);
assert.match(indexSrc, /send\('phone:card', mobileGate\.card\(focused\)\)/);
const preloadSrc = readFileSync(join(root, 'src/preload/index.js'), 'utf8');
assert.match(preloadSrc, /card: \(\) => ipcRenderer\.invoke\('phone:card'\)/);
assert.match(preloadSrc, /onCard: on\('phone:card'\)/);

const skip = new Set([
  'node_modules', '.git', 'dist', 'out',
  '.chat-check-out', '.fold-check-out', '.ticket-check-out',
]);
const allowed = new Map([
  ['src/main/mobile-gate.js', 'encodeTicket'],
  ['mobile/src/conn-live.ts', 'decodeTicket'],
]);
const sources = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs);
    else if (/\.(js|jsx|mjs|cjs|ts|tsx)$/.test(name)) sources.push(abs);
  }
}
walk(root);
for (const file of sources) {
  const rel = relative(root, file);
  if (rel === 'scripts/check-phone-ticket.mjs' || rel === 'src/shared/phone-ticket.js') continue;
  const text = readFileSync(file, 'utf8');
  if (!text.includes('phone-ticket')) continue;
  const only = allowed.get(rel);
  assert.ok(only, `${rel} imports phone-ticket`);
  assert.match(text, new RegExp(only));
  const other = only === 'encodeTicket' ? 'decodeTicket' : 'encodeTicket';
  assert.doesNotMatch(text, new RegExp(other));
}
assert.match(readFileSync(join(root, 'src/main/mobile-gate.js'), 'utf8'), /encodeTicket/);
assert.match(readFileSync(join(root, 'mobile/src/conn-live.ts'), 'utf8'), /decodeTicket/);

console.log('check-phone-ticket ok');
