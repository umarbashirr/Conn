import { build } from 'esbuild';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import assert from 'assert';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'scripts', '.chat-check-out');
const stubPath = join(outDir, 'react-native-stub.js');
const entry = join(outDir, 'entry.mjs');
const require = createRequire(import.meta.url);
const esbuildBin = require.resolve('esbuild');
void esbuildBin;

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

writeFileSync(
  stubPath,
  `
export const Platform = { OS: 'ios', select: (m) => m.ios ?? m.default };
export const StatusBar = { currentHeight: 0 };
export const StyleSheet = { hairlineWidth: 1, create: (s) => s };
export function View(props) { return props; }
export function Text(props) { return props; }
export function Pressable(props) { return props; }
export function TextInput(props) { return props; }
export function ScrollView(props) { return props; }
export function KeyboardAvoidingView(props) { return props; }
`,
);

await build({
  entryPoints: [join(root, 'src/chat.tsx')],
  outfile: join(outDir, 'chat.js'),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'],
  alias: { 'react-native': stubPath },
});

writeFileSync(
  entry,
  `
import assert from 'assert';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
globalThis.React = require('react');
const { chat, peekScreen } = await import('./chat.js');

function snap() {
  return peekScreen();
}

const sessions = snap();
assert.equal(sessions.name, 'sessions');
assert.ok(sessions.sections.length >= 1);
assert.ok(sessions.sections.flatMap((s) => s.rows.map((r) => r.title)).includes('Zinc tokens'));

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
const openChat = snap();
assert.equal(openChat.name, 'chat');
assert.ok(openChat.rows.some((r) => r.item.kind === 'user'));
assert.ok(openChat.rows.some((r) => r.item.kind === 'assistant'));
assert.ok(openChat.rows.some((r) => r.item.kind === 'tool'));
assert.ok(openChat.rows.some((r) => r.item.kind === 'note'));
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

console.log('chat-check ok');
`,
);

await import(pathToFileURL(entry).href);
