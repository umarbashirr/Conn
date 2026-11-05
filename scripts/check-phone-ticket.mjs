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

const { OTHER, questionsOf, replyOf, withAnswers } = require(join(root, 'src/shared/ask-answers.js'));
const { imageHead, plainText } = require(join(root, 'src/shared/attachments.js'));

const askedInput = {
  questions: [{
    question: 'Which files?',
    header: 'Files',
    multiSelect: true,
    options: [
      { label: 'src/a.ts', preview: 'a' },
      { label: 'src/b.ts' },
      { label: '  ' },
    ],
  }, {
    question: 'Ship it?',
    options: [{ label: 'Yes' }],
  }, {
    question: '',
  }],
};
const askedQuestions = questionsOf(askedInput);
assert.equal(askedQuestions.length, 2);
assert.equal(askedQuestions[0].options.length, 2);
assert.equal(askedQuestions[0].multiSelect, true);
assert.equal(askedQuestions[1].multiSelect, false);
const askedReply = replyOf(askedQuestions, {
  'Which files?': ['src/a.ts', OTHER],
  'Ship it?': 'Yes',
}, { 'Which files?': ' src/c.ts ' });
assert.equal(askedReply.complete, true);
assert.equal(askedReply.answers['Which files?'], 'src/a.ts, src/c.ts');
assert.deepEqual(askedReply.annotations, { 'Which files?': { preview: 'a' } });
assert.deepEqual(withAnswers(askedInput, askedReply), {
  ...askedInput,
  answers: askedReply.answers,
  annotations: askedReply.annotations,
});
const partialReply = replyOf(askedQuestions, { 'Ship it?': 'Yes' }, {});
assert.equal(partialReply.complete, false);
assert.equal(Object.hasOwn(partialReply, 'annotations'), false);
assert.equal(imageHead('IMG_0412.jpg'), '[attached image] IMG_0412.jpg');
assert.equal(plainText(`${imageHead('IMG_0412.jpg')}\n\nwhy`), '[IMG_0412.jpg]\nwhy');
assert.deepEqual(questionsOf(null), []);

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

const turns = [];
const decisions = [];
let focus = '/tmp/folder';
const asked = { chats: [], transcripts: [] };
const gateDeps = {
  focused: () => focus,
  knownProject: (dir) => dir !== '/tmp/closed',
  deliverTurn: async (turn) => {
    turns.push(turn);
    return { sessionId: 'sess-1' };
  },
  deliverDecision: (decision) => {
    decisions.push(decision);
    return true;
  },
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

const packaged = await withEnv({
  CONN_MOBILE_HOST: '127.0.0.1',
  CONN_MOBILE_PORT: '0',
  CONN_MOBILE_TOKEN: 'packaged-token',
}, () => startMobileGate({ packaged: true, ...gateDeps }));
try {
  focus = '/tmp/folder';
  const card = packaged.card();
  assert.equal(card.status, 'ready');
  const round = decodeTicket(card.ticket);
  assert.ok(round);
  assert.equal(round.token, 'packaged-token');
  assert.equal(round.project, '/tmp/folder');
  const phone = new WebSocket(round.url);
  await new Promise((resolve, reject) => {
    phone.once('open', resolve);
    phone.once('error', reject);
  });
  phone.close();
} finally {
  packaged.stop();
}

const invalid = await withEnv({ CONN_MOBILE_PORT: 'nope' }, () => (
  startMobileGate({ ...gateDeps })
));
assert.deepEqual(invalid.card(), { status: 'off', note: 'Phone link is off.' });

const project = '/tmp/conn phone/folder';
const gate = await withEnv({
  CONN_MOBILE_HOST: '127.0.0.1',
  CONN_MOBILE_PORT: '0',
  CONN_MOBILE_TOKEN: 'ticket-token',
}, () => startMobileGate({ ...gateDeps }));
try {
  focus = project;
  const card = gate.card();
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
  focus = '';
  assert.deepEqual(gate.card(), {
    status: 'off',
    note: 'Open a folder to put it on the phone link.',
  });
  focus = null;
  assert.deepEqual(gate.card(), {
    status: 'off',
    note: 'Open a folder to put it on the phone link.',
  });
  focus = project;

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
      if (pred()) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        phone.off('message', check);
        reject(new Error(`${label} ${JSON.stringify(frames)}`));
      }, 2000);
      function check() {
        if (!pred()) return;
        clearTimeout(timer);
        phone.off('message', check);
        resolve();
      }
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

  const jpeg = '/9j/4AAQSkZJRg==';
  phone.send(JSON.stringify({
    op: 'send',
    chat: 'h:codex:019a6c',
    text: '[attached image] IMG_0412.jpg\n\nwhy is this red?',
    project,
    session: '019a6c',
    provider: 'codex',
    nonce: 'n7',
    images: [{ media: 'image/jpeg', data: jpeg }],
  }));
  await waitFor(
    () => frames.some((frame) => frame.of === 'send' && frame.nonce === 'n7' && frame.ok === true),
    'photo send',
  );
  assert.deepEqual(turns.at(-1), {
    chat: 'h:codex:019a6c',
    text: '[attached image] IMG_0412.jpg\n\nwhy is this red?',
    images: [{ media: 'image/jpeg', data: jpeg }],
    project,
    session: '019a6c',
    provider: 'codex',
  });

  phone.send(JSON.stringify({
    op: 'send',
    chat: 'c-old',
    text: 'hello',
    project,
    nonce: 'n-old',
  }));
  await waitFor(
    () => frames.some((frame) => frame.of === 'send' && frame.nonce === 'n-old' && frame.ok === true),
    'old send',
  );
  assert.deepEqual(turns.at(-1), {
    chat: 'c-old',
    text: 'hello',
    images: [],
    project,
    session: null,
    provider: 'claude',
  });

  const beforeRejects = turns.length;
  phone.send(JSON.stringify({
    op: 'send',
    chat: 'c1',
    text: 'hello',
    project,
    nonce: 'n-prov',
    provider: 'gemini',
  }));
  await waitFor(
    () => frames.some((frame) => frame.of === 'send' && frame.nonce === 'n-prov'),
    'bad provider',
  );
  assert.equal(frames.find((frame) => frame.nonce === 'n-prov').error, 'bad send');

  phone.send(JSON.stringify({
    op: 'send',
    chat: 'c1',
    text: 'hello',
    project,
    session: 's1',
    nonce: 'n-extra',
    extra: true,
  }));
  await waitFor(
    () => frames.some((frame) => frame.of === 'send' && frame.nonce === 'n-extra'),
    'seventh key',
  );
  assert.equal(frames.find((frame) => frame.nonce === 'n-extra').error, 'bad send');

  phone.send(JSON.stringify({
    op: 'send',
    chat: 'c1',
    text: 'hello',
    project,
    nonce: 'n-empty',
    images: [],
  }));
  await waitFor(
    () => frames.some((frame) => frame.of === 'send' && frame.nonce === 'n-empty'),
    'empty images',
  );
  assert.equal(frames.find((frame) => frame.nonce === 'n-empty').error, 'bad send');
  assert.equal(turns.length, beforeRejects);

  phone.send(JSON.stringify({
    op: 'send',
    chat: 'c-photo',
    text: '[attached image] photo.jpg\n\n',
    project,
    nonce: 'n-photo',
    images: [{ media: 'image/jpeg', data: jpeg }],
  }));
  await waitFor(
    () => frames.some((frame) => frame.of === 'send' && frame.nonce === 'n-photo' && frame.ok === true),
    'photo only',
  );
  assert.equal(turns.at(-1).text, '[attached image] photo.jpg\n\n');
  assert.equal(turns.at(-1).provider, 'claude');
  assert.deepEqual(turns.at(-1).images, [{ media: 'image/jpeg', data: jpeg }]);

  phone.send(JSON.stringify({
    op: 'send',
    chat: 'c1',
    text: '   ',
    project,
    nonce: 'n-blank',
    images: [{ media: 'image/jpeg', data: jpeg }],
  }));
  await waitFor(
    () => frames.some((frame) => frame.of === 'send' && frame.nonce === 'n-blank'),
    'blank text',
  );
  assert.equal(frames.find((frame) => frame.nonce === 'n-blank').error, 'blank text');
  assert.equal(turns.length, beforeRejects + 1);

  const answered = {
    questions: [{ question: 'Which files?' }],
    answers: { 'Which files?': 'src/a.ts, src/b.ts' },
  };
  phone.send(JSON.stringify({
    op: 'decide',
    chat: 'h:claude:5f1e',
    id: 'p-deny',
    decision: 'deny',
    input: answered,
  }));
  await waitFor(
    () => frames.some((frame) => frame.of === 'decide' && frame.error === 'bad decide'),
    'deny input',
  );
  assert.equal(decisions.length, 0);

  phone.send(JSON.stringify({
    op: 'decide',
    chat: 'h:claude:5f1e',
    id: 'p-allow',
    decision: 'allow',
    input: answered,
  }));
  await waitFor(
    () => frames.some((frame) => frame.of === 'decide' && frame.id === 'p-allow' && frame.ok === true),
    'allow input',
  );
  assert.deepEqual(decisions.at(-1), {
    chat: 'h:claude:5f1e',
    id: 'p-allow',
    decision: 'allow',
    input: answered,
  });

  const tickets = () => frames.filter((frame) => frame.op === 'ticket');
  await waitFor(() => tickets().length >= 1, 'auth ticket');
  const authTicket = decodeTicket(tickets()[0].ticket);
  assert.equal(authTicket.project, project);
  assert.equal(authTicket.token, round.token);
  assert.equal(authTicket.url, round.url);

  const beforeMove = tickets().length;
  focus = `${project}-next`;
  gate.follow();
  await waitFor(() => tickets().length === beforeMove + 1, 'moved ticket');
  const moved = decodeTicket(tickets().at(-1).ticket);
  assert.equal(moved.project, `${project}-next`);
  assert.equal(moved.token, round.token);
  assert.equal(moved.url, round.url);
  const settled = tickets().length;
  const duplicate = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      phone.off('message', onMove);
      resolve(false);
    }, 200);
    function onMove(buf) {
      const frame = JSON.parse(buf.toString());
      if (frame.op !== 'ticket') return;
      clearTimeout(timer);
      phone.off('message', onMove);
      resolve(true);
    }
    phone.on('message', onMove);
    gate.follow();
  });
  assert.equal(duplicate, false);
  assert.equal(tickets().length, settled);

  await new Promise((resolve) => {
    phone.once('close', () => resolve());
    phone.close();
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const parked = tickets().length;
  focus = `${project}-later`;
  gate.follow();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(tickets().length, parked, 'a move with no phone is not remembered as delivered');

  const again = [];
  const phone2 = new WebSocket(round.url);
  phone2.on('message', (buf) => again.push(JSON.parse(buf.toString())));
  await new Promise((resolve, reject) => {
    phone2.once('open', resolve);
    phone2.once('error', reject);
  });
  phone2.send(JSON.stringify({ op: 'auth', token: round.token }));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`reauth ticket ${JSON.stringify(again)}`)), 2000);
    const check = () => {
      const frame = again.find((item) => item.op === 'ticket');
      if (!frame) return;
      clearTimeout(timer);
      const decoded = decodeTicket(frame.ticket);
      assert.equal(decoded.project, `${project}-later`);
      assert.equal(decoded.token, round.token);
      assert.equal(decoded.url, round.url);
      resolve();
    };
    check();
    phone2.on('message', check);
  });
  phone2.close();
} finally {
  gate.stop();
}

const wild = await withEnv({
  CONN_MOBILE_HOST: undefined,
  CONN_MOBILE_PORT: '0',
  CONN_MOBILE_TOKEN: 'wild-token',
}, () => startMobileGate({ ...gateDeps }));
try {
  focus = '/tmp/proj';
  const card = wild.card();
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
  }, () => startMobileGate({ ...gateDeps }));
  assert.deepEqual(failed.card(), { status: 'off', note: 'Phone link is off.' });
} finally {
  await new Promise((resolve) => blocker.close(resolve));
}

const gateSrc = readFileSync(join(root, 'src/main/mobile-gate.js'), 'utf8');
const fanout = gateSrc.match(/const FANOUT = new Set\(\[([\s\S]*?)\]\)/);
assert.ok(fanout);
const fanoutNames = [...fanout[1].matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]);
assert.equal(fanoutNames.some((name) => name.startsWith('phone:')), false);

const indexSrc = readFileSync(join(root, 'src/main/index.js'), 'utf8');
assert.match(indexSrc, /ipcMain\.handle\('phone:card', \(\) => mobileGate\.card\(\)\)/);
assert.match(indexSrc, /mobileGate\.follow\(\)/);
assert.match(indexSrc, /send\('phone:card', mobileGate\.card\(\)\)/);
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
