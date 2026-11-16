/* The verify skill's stand-in Messages API, fed a `tool <name> <json>` line
   whose JSON does not parse. It must answer with a plain text turn that names
   the bad line, and keep serving, rather than crash the process the real
   claude CLI is talking to. Needs nothing but node. */
import http from 'node:http';
import { serve } from '../.claude/skills/verify/claude-api.mjs';

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
};

const post = (port, body) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
    let raw = '';
    res.on('data', (d) => { raw += d; });
    res.on('end', () => resolve(raw));
  });
  req.on('error', reject);
  req.end(JSON.stringify(body));
});
const turn = (text) => ({ model: 'claude-test', tools: [{ name: 'Read' }], messages: [{ role: 'user', content: text }] });
// The stand-in streams one block per reply; this is that block and its text.
const said = (sse) => {
  const events = sse.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
  const delta = events.find((e) => e.type === 'content_block_delta')?.delta;
  return { block: events.find((e) => e.type === 'content_block_start')?.content_block, text: delta?.text ?? delta?.partial_json };
};

process.on('uncaughtException', (e) => { check('server-survives-a-bad-line', false, e.message); process.exit(1); });

const { server, port } = await serve({ project: '/tmp' });
try {
  const bad = 'tool mcp__preview__browser_evaluate {"code": "1 +"';
  const first = said(await post(port, turn(bad)));
  check('bad-json-gets-a-text-turn', first.block?.type === 'text', JSON.stringify(first));
  check('the-text-names-the-bad-line', /does not parse/.test(first.text) && String(first.text).includes(bad), JSON.stringify(first.text));

  const unclosed = said(await post(port, turn('tool mcp__preview__browser_evaluate {"code": "1 +"} }')));
  check('server-answers-a-json-error', unclosed.block?.type === 'text' && /does not parse/.test(unclosed.text), JSON.stringify(unclosed));

  const cut = said(await post(port, turn('tool mcp__preview__browser_evaluate {"code": "a ;; b"}')));
  check('json-cut-at-the-separator-is-named', cut.block?.type === 'text' && /does not parse/.test(cut.text), JSON.stringify(cut));

  const good = said(await post(port, turn('tool mcp__preview__browser_snapshot {}')));
  check('a-good-line-still-calls-the-tool', good.block?.type === 'tool_use' && good.block.name === 'mcp__preview__browser_snapshot', JSON.stringify(good));
} finally {
  server.close();
}

if (failures.length) {
  console.log(`\n${failures.length} FAIL(s): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\np3-stand-in-api-repro: all passed');
