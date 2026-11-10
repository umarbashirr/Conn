import { build } from 'esbuild';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import assert from 'assert';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'scripts', '.markdown-check-out');
const require = createRequire(import.meta.url);
const React = require('react');
React.useMemo = (create) => create();
React.useState = (init) => [typeof init === 'function' ? init() : init, () => {}];
React.useRef = (init) => ({ current: init });
React.useCallback = (fn) => fn;
React.useEffect = () => {};

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const stubPath = join(outDir, 'react-native-stub.js');
writeFileSync(
  stubPath,
  `import React from 'react';
function flatten(style) {
  if (style == null || style === false) return {};
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
  return style;
}
export const Platform = { OS: 'ios', select: (spec) => spec.ios ?? spec.default };
export const StyleSheet = { hairlineWidth: 1, create: (styles) => styles, flatten };
export function View(props) { return React.createElement('View', props, props.children); }
export function Text(props) { return React.createElement('Text', props, props.children); }
export function TextInput(props) { return React.createElement('TextInput', props, props.children); }
export function Pressable(props) { return React.createElement('Pressable', props, props.children); }
export function ScrollView(props) { return React.createElement('ScrollView', props, props.children); }
export function KeyboardAvoidingView(props) { return React.createElement('KeyboardAvoidingView', props, props.children); }
export const StatusBar = { currentHeight: 0 };
export function ActivityIndicator(props) { return React.createElement('ActivityIndicator', props); }
export function Image(props) { return React.createElement('Image', props, props.children); }
export function ImageBackground(props) { return React.createElement('ImageBackground', props, props.children); }
export function TouchableWithoutFeedback(props) { return React.createElement('TouchableWithoutFeedback', props, props.children); }
export const Linking = { openURL() {} };
`,
);

writeFileSync(
  join(outDir, 'punycode.js'),
  `module.exports = { toASCII: (value) => value, toUnicode: (value) => value };
`,
);
writeFileSync(
  join(outDir, 'fit-image.js'),
  `export default function FitImage() { return null; }
`,
);
writeFileSync(
  join(outDir, 'photos-stub.js'),
  `export async function takePhotos() { return { kind: 'cancelled' }; }
`,
);
writeFileSync(
  join(outDir, 'async-storage.js'),
  `export default { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} };
`,
);

await build({
  entryPoints: [join(root, 'src/chat.tsx')],
  outfile: join(outDir, 'chat.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  mainFields: ['main', 'module'],
  loader: { '.js': 'jsx' },
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'],
  alias: {
    'react-native': stubPath,
    'react-native-fit-image': join(outDir, 'fit-image.js'),
    punycode: join(outDir, 'punycode.js'),
    '@react-native-async-storage/async-storage': join(outDir, 'async-storage.js'),
  },
  plugins: [
    {
      name: 'photos-stub',
      setup(build) {
        build.onResolve({ filter: /^\.\/photos$/ }, () => ({ path: join(outDir, 'photos-stub.js') }));
      },
    },
  ],
});

const { ChatItemView } = await import(pathToFileURL(join(outDir, 'chat.js')).href);

const source = [
  '**See** the `code`',
  '',
  '- one',
  '',
  '~~gone~~',
  '',
  '| a | b |',
  '| - | - |',
  '| 1 | 2 |',
].join('\n');

function flatten(style) {
  if (style == null || style === false) return {};
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
  return style;
}

const MEMO = Symbol.for('react.memo');

function texts(node, found = []) {
  if (node == null || typeof node === 'boolean') return found;
  if (typeof node === 'string' || typeof node === 'number') {
    found.push({ text: String(node), style: {} });
    return found;
  }
  if (Array.isArray(node)) {
    for (const child of node) texts(child, found);
    return found;
  }
  let type = node.type;
  if (type && type.$$typeof === MEMO) type = type.type;
  if (typeof type === 'function') return texts(type(node.props), found);
  const style = flatten(node.props?.style);
  const children = node.props?.children;
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (typeof child === 'string' || typeof child === 'number') found.push({ text: String(child), style });
    else texts(child, found);
  }
  return found;
}

const leaves = texts(React.createElement(ChatItemView, {
  row: {
    id: 'row',
    item: { id: 'a', parent: null, kind: 'assistant', text: source },
  },
}));
const joined = leaves.map((leaf) => leaf.text).join('');
assert.equal(joined.includes('**See**'), false, 'bold markers stay visible');
assert.ok(
  leaves.some((leaf) => leaf.text === 'See' && (leaf.style.fontWeight === 'bold' || leaf.style.fontWeight === '700') && leaf.style.color === '#EDEDED'),
  'See is bold',
);
assert.ok(
  leaves.some((leaf) => leaf.text === 'code' && leaf.style.backgroundColor === '#262626'),
  'inline code text',
);
assert.ok(
  leaves.some((leaf) => leaf.text === 'gone' && leaf.style.textDecorationLine === 'line-through'),
  'strikethrough',
);
assert.ok(leaves.some((leaf) => leaf.text === '2'), 'table cell');
assert.equal(joined.includes('| a |'), false, 'table pipes stay visible');

console.log('markdown-check ok');
