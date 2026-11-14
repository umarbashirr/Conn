import { build } from 'esbuild';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import assert from 'assert';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'scripts', '.chat-check-out');
const stubPath = join(outDir, 'react-native-stub.js');
const photosStub = join(outDir, 'photos-stub.js');
const entry = join(outDir, 'entry.mjs');
const require = createRequire(import.meta.url);
const esbuildBin = require.resolve('esbuild');
void esbuildBin;

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

writeFileSync(
  join(outDir, 'async-storage.js'),
  `const mem = new Map();
export default {
  getItem: async (key) => (mem.has(key) ? mem.get(key) : null),
  setItem: async (key, value) => { mem.set(key, String(value)); },
  removeItem: async (key) => { mem.delete(key); },
};
`,
);

writeFileSync(
  stubPath,
  `
export const Platform = { OS: 'ios', select: (m) => m.ios ?? m.default };
export const StatusBar = { currentHeight: 0 };
export const StyleSheet = { hairlineWidth: 1, create: (s) => s };
export const Appearance = { getColorScheme: () => 'dark', addChangeListener: () => ({ remove() {} }) };
export function View(props) { return props; }
export function Text(props) { return props; }
export function Pressable(props) { return props; }
export function TextInput(props) { return props; }
export function ScrollView(props) { return props; }
export function KeyboardAvoidingView(props) { return props; }
export function Image(props) { return props; }
`,
);

writeFileSync(
  photosStub,
  `export async function takePhotos(source, room) {
  const pick = globalThis.__photoPick;
  if (typeof pick === 'function') return pick(source, room);
  return { kind: 'cancelled' };
}
`,
);

const markdownStub = join(outDir, 'markdown-text.js');
writeFileSync(
  markdownStub,
  `export function MarkdownText({ text }) { return text; }
`,
);

writeFileSync(join(outDir, 'vector-icons.js'), 'export function Ionicons(props) { return props; }\n');

await build({
  entryPoints: [join(root, 'src/chat.tsx')],
  outfile: join(outDir, 'chat.js'),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'],
  alias: {
    'react-native': stubPath,
    '@react-native-async-storage/async-storage': join(outDir, 'async-storage.js'),
    '@expo/vector-icons': join(outDir, 'vector-icons.js'),
  },
  plugins: [
    {
      name: 'photos-stub',
      setup(build) {
        build.onResolve({ filter: /^\.\/photos$/ }, () => ({ path: photosStub }));
        build.onResolve({ filter: /^\.\/markdown-text$/ }, () => ({ path: markdownStub }));
      },
    },
  ],
});

writeFileSync(
  entry,
  `
import assert from 'assert';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
globalThis.React = require('react');
const { acceptLive, chat, peekScreen } = await import('./chat.js');

function snap() {
  return peekScreen();
}

const sessions = snap();
assert.equal(sessions.name, 'sessions');
assert.equal(sessions.sections.length, 0);

const now = Date.now();
acceptLive({
  type: 'catalog',
  folders: [
    {
      dir: '/work/conn',
      name: 'conn',
      chats: [
        { id: 'h:claude:abc', title: 'Zinc tokens', at: now - 3_600_000, provider: 'claude', resume: 'abc' },
        { id: 'h:codex:def', title: 'Empty draft', at: now - 86_400_000, provider: 'codex', resume: 'def', pinAt: 9 },
        { id: 'h:claude:ghi', title: 'Field notes', at: now - 600_000, provider: 'claude', resume: 'ghi', state: 'working' },
      ],
      done: [
        { id: 'h:claude:old', title: 'Put away', at: now - 9_000_000, provider: 'claude', resume: 'old' },
      ],
    },
    {
      dir: '/work/shop',
      name: 'shop',
      chats: [
        { id: 'h:claude:ship', title: 'Shipping', at: now - 8_000_000, provider: 'claude', resume: 'ship' },
      ],
      done: [],
    },
  ],
});
const listed = snap();
assert.deepEqual(listed.sections.map((section) => section.project), ['conn', 'shop']);
assert.ok(listed.sections[0].rows.map((row) => row.title).includes('Zinc tokens'));
assert.deepEqual(listed.sections[0].rows.map((row) => row.title), ['Empty draft', 'Field notes', 'Zinc tokens']);
assert.equal(listed.sections[0].rows[0].mark, 'pinned');
assert.equal(listed.sections[0].rows[1].mark, 'working');
assert.equal(listed.sections[0].rows[1].line, 'Working');
chat.open(listed.sections[0].rows[1].id);
const workingChat = snap();
assert.equal(workingChat.name, 'chat');
assert.equal(workingChat.mark, 'working');
assert.equal(workingChat.line, 'Working');
assert.equal(workingChat.folder, 'conn');
chat.back();
assert.equal(listed.sections[0].done[0].mark, 'done');
assert.deepEqual(listed.openDone, []);
chat.toggleDone('/work/conn');
assert.deepEqual(snap().openDone, ['/work/conn']);
chat.toggleDone('/work/conn');
assert.deepEqual(snap().openDone, []);
assert.deepEqual(listed.sections[0].done.map((row) => row.title), ['Put away']);
assert.ok(!listed.sections[0].rows.some((row) => row.title === 'Put away'));
assert.deepEqual(listed.sections[1].rows.map((row) => row.title), ['Shipping']);

chat.setQuery('zinc');
const filtered = snap();
assert.equal(filtered.name, 'sessions');
assert.ok(filtered.sections.every((s) =>
  s.rows.every((r) => (r.title + ' ' + s.project).toLowerCase().includes('zinc')),
));
chat.setQuery('');

function labelsByTitle() {
  const screen = snap();
  assert.equal(screen.name, 'sessions');
  return Object.fromEntries(
    screen.sections.flatMap((section) => section.rows.map((row) => [row.title, row.atLabel])),
  );
}

const beforeLabels = labelsByTitle();
assert.ok(beforeLabels['Zinc tokens']);
assert.ok(beforeLabels['Empty draft']);

const emptyDraft = snap().sections
  .flatMap((section) => section.rows)
  .find((row) => row.title === 'Empty draft');
assert.ok(emptyDraft);
chat.open(emptyDraft.id);
assert.equal(snap().name, 'chat');
chat.setDraft('hello from check');
chat.send();
assert.equal(snap().rows.at(-1).item.text, 'hello from check');
chat.send();
assert.equal(snap().rows.length, 1);

chat.back();
const afterLabels = labelsByTitle();
assert.equal(afterLabels['Zinc tokens'], beforeLabels['Zinc tokens']);
assert.equal(afterLabels['Field notes'], beforeLabels['Field notes']);
assert.equal(afterLabels['Empty draft'], 'now');

const firstId = snap().sections.flatMap((s) => s.rows).find((r) => r.title === 'Zinc tokens').id;
chat.open(firstId);
assert.equal(snap().name, 'chat');
assert.equal(snap().rows.length, 0);
acceptLive({
  type: 'transcript',
  session: firstId,
  messages: [
    { type: 'user', uuid: 'u1', message: { content: [{ type: 'text', text: 'Where do the zinc colors live?' }] } },
    { type: 'assistant', uuid: 'a1', message: { content: [
      { type: 'text', text: 'In the desktop dark theme, ground is #141414.' },
      { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'src/renderer/styles.css' } },
    ] } },
    { type: 'user', uuid: 'u2', message: { content: [
      { type: 'tool_result', tool_use_id: 'tool-1', content: '--background: 0 0% 8%' },
    ] } },
  ],
});
const openChat = snap();
assert.equal(openChat.name, 'chat');
assert.ok(openChat.rows.some((r) => r.item.kind === 'user' && r.item.text.includes('zinc colors')));
assert.ok(openChat.rows.some((r) => r.item.kind === 'assistant'));
assert.ok(openChat.rows.some((r) => r.item.kind === 'tool' && r.item.output.includes('--background')));
const rowCount = openChat.rows.length;

chat.setDraft('second check');
chat.send();
assert.equal(snap().rows.length, rowCount + 1);

chat.back();
chat.newChat();
const empty = snap();
assert.equal(empty.name, 'chat');
assert.equal(empty.rows.length, 0);
assert.ok(empty.starters.length >= 1);
const chip = empty.starters[0];
chat.setDraft(chip);
assert.equal(snap().draft, chip);
assert.equal(snap().rows.length, 0);
chat.back();
acceptLive({
  type: 'catalog',
  folders: [
    {
      dir: '/work/conn',
      name: 'conn',
      chats: [
        { id: 'h:claude:abc', title: 'Zinc tokens', at: now - 3_600_000, provider: 'claude', resume: 'abc' },
      ],
      done: [],
    },
  ],
});
const titles = snap().sections.flatMap((section) => section.rows.map((row) => row.title));
assert.ok(titles.includes('New chat'));
assert.ok(titles.includes('Zinc tokens'));
assert.ok(!titles.includes('Empty draft'));

const { replyOf, withAnswers } = require(${JSON.stringify(join(root, '..', 'src/shared/ask-answers.js'))});
const questions = [{
  question: 'Which files?',
  header: 'Scope',
  options: [
    { label: 'src/a.ts', preview: 'keep' },
    { label: 'src/b.ts' },
  ],
  multiSelect: false,
}];
const picked = { 'Which files?': ['src/a.ts'] };
const typed = {};
const reply = replyOf(questions, picked, typed);
const input = { questions };
const zinc = snap().sections.flatMap((section) => section.rows).find((row) => row.title === 'Zinc tokens');
chat.open(zinc.id);
acceptLive({
  type: 'upsert',
  session: zinc.id,
  item: {
    id: 'p-ask',
    kind: 'perm',
    parent: null,
    tool: 'AskUserQuestion',
    title: 'Which files?',
    input,
    ask: { kind: 'questions', questions },
    forId: null,
  },
});
const asked = snap().rows.find((row) => row.item.kind === 'perm');
assert.equal(asked.item.ask.kind, 'questions');
assert.deepEqual(
  withAnswers(asked.item.input, replyOf(asked.item.ask.questions, picked, typed)),
  withAnswers(input, reply),
);
assert.deepEqual(withAnswers(input, reply), {
  questions,
  answers: { 'Which files?': 'src/a.ts' },
  annotations: { 'Which files?': { preview: 'keep' } },
});

chat.back();
chat.newChat();
const fresh = snap();
assert.equal(fresh.name, 'chat');
assert.equal(fresh.canSend, false);
assert.equal(fresh.canAttach, true);
assert.equal(fresh.photos.length, 0);

function photo(index) {
  return {
    name: 'p' + index + '.jpg',
    media: 'image/jpeg',
    data: 'aaaa',
    uri: 'file:///p' + index + '.jpg',
    width: 40,
    height: 20,
  };
}

async function until(label, fn) {
  for (let i = 0; i < 30; i += 1) {
    if (fn()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('timed out waiting for ' + label);
}

const askedRoom = [];
globalThis.__photoPick = async (source, room) => {
  askedRoom.push({ source, room });
  return { kind: 'cancelled' };
};
chat.attach('library');
await until('cancel', () => askedRoom.length === 1);
assert.deepEqual(askedRoom, [{ source: 'library', room: 4 }]);
assert.equal(snap().photos.length, 0);
assert.equal(snap().canSend, false);

globalThis.__photoPick = async () => ({ kind: 'denied' });
chat.attach('camera');
await until('denied', () => snap().rows.some((row) => row.item.kind === 'note'));
assert.equal(
  snap().rows.some((row) => row.item.text === 'Conn needs photo or camera access in Settings.'),
  true,
);

let fitted = 0;
globalThis.__photoPick = async () => {
  fitted += 1;
  return {
    kind: 'picked',
    dropped: 2,
    photos: [0, 1, 2, 3, 4, 5].map(photo),
  };
};
chat.attach('library');
await until('clamped', () => snap().photos.length === 4);
assert.equal(fitted, 1);
assert.equal(snap().canAttach, false);
assert.equal(snap().canSend, true);
assert.equal(snap().draft, '');
for (const shot of snap().photos) assert.equal(Object.hasOwn(shot, 'data'), false);
assert.equal(snap().rows.some((row) => row.item.text === '2 photos did not fit.'), true);
chat.attach('library');
await new Promise((resolve) => setImmediate(resolve));
assert.equal(fitted, 1);
assert.equal(snap().photos.length, 4);
chat.setDraft('   ');
assert.equal(snap().canSend, true);
chat.dropPhoto(0);
assert.equal(snap().photos.length, 3);
assert.equal(snap().canAttach, true);
chat.send();
const sent = snap().rows.at(-1);
assert.equal(sent.item.kind, 'user');
assert.equal(sent.item.text, '');
assert.equal(sent.item.photos.length, 3);
assert.equal(JSON.stringify(sent.item).includes('aaaa'), false);
assert.equal(snap().draft, '');
assert.equal(snap().photos.length, 0);
assert.equal(snap().canSend, false);
chat.send();
assert.equal(snap().rows.filter((row) => row.item.kind === 'user').length, 1);

console.log('chat-check ok');
`,
);

await import(pathToFileURL(entry).href);
