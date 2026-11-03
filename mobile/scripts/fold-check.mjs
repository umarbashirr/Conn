import { build } from 'esbuild';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'scripts', '.fold-check-out');
const entry = join(outDir, 'entry.mjs');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const storageStub = join(outDir, 'async-storage.mjs');
writeFileSync(storageStub, `const mem = new Map();
export default {
  getItem: async (key) => (mem.has(key) ? mem.get(key) : null),
  setItem: async (key, value) => { mem.set(key, String(value)); },
  removeItem: async (key) => { mem.delete(key); },
};
`);

await build({
  entryPoints: [join(root, 'src/conn-live.ts')],
  outfile: join(outDir, 'conn-live.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  alias: {
    '@react-native-async-storage/async-storage': storageStub,
  },
});

const greeting = 'Hello from Conn';
const thought = 'Checking the greeting.';

writeFileSync(
  entry,
  `
import assert from 'assert';
const { attachLive, foldLiveMessage } = await import('./conn-live.mjs');

const greeting = ${JSON.stringify(greeting)};
const thought = ${JSON.stringify(thought)};
const session = 'fold-check';
const events = [];
attachLive((event) => events.push(event));

function agent(msg) {
  foldLiveMessage({ chat: session, msg });
}

function stream(event) {
  agent({ type: 'stream_event', parent_tool_use_id: null, event });
}

stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: thought } });
stream({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello from ' } });
stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Conn' } });
agent({
  type: 'assistant',
  message: { content: [{ type: 'text', text: greeting }] },
});
agent({ type: 'result', subtype: 'success', duration_ms: 1200, is_error: false });

const items = new Map();
for (const event of events) {
  if (event.type !== 'upsert') continue;
  items.set(event.item.id, event.item);
}
const folded = [...items.values()];
const assistants = folded.filter((item) => item.kind === 'assistant' && item.text === greeting);
const reasoning = folded.filter((item) => item.kind === 'reasoning');
const notes = folded.filter((item) => item.kind === 'note' && item.ended === true);
if (assistants.length !== 1) {
  console.error(JSON.stringify(folded.filter((item) => item.kind === 'assistant'), null, 2));
}
assert.equal(assistants.length, 1, 'one assistant item with the streamed greeting');
assert.equal(reasoning.length, 1);
assert.equal(reasoning[0].text, thought);
assert.equal(notes.length, 1);
assert.equal(notes[0].text, 'done in 1.2s');
console.log('fold-check ok');
`,
);

await import(pathToFileURL(entry).href);
