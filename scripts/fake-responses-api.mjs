#!/usr/bin/env node
/* A stand-in for the OpenAI Responses API, so the real codex CLI can run a turn
   without an account. Point codex at it with a custom model provider in
   $CODEX_HOME/config.toml (see handoff-switch-e2e-repro.mjs). Every request body
   is appended to the log file named by the first argument, one JSON object per
   line, so a test can read exactly what codex was handed. Each turn answers
   `codex heard: <last line of the last user message>`. Prints `port <n>`.
   FAKE_FAIL_ONCE names a file: the first turn naming fail-once-token fails. */
import fs from 'node:fs';
import http from 'node:http';

const LOG = process.argv[2] || '/tmp/fake-responses.jsonl';
const J = JSON.stringify;

const userText = (input) => {
  const users = (Array.isArray(input) ? input : []).filter((m) => m?.role === 'user');
  const last = users.at(-1);
  const parts = Array.isArray(last?.content) ? last.content : [];
  return parts.filter((p) => p?.type === 'input_text').map((p) => p.text || '').join('\n');
};

let n = 0;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let o = {};
    try { o = JSON.parse(body || '{}'); } catch {}
    fs.appendFileSync(LOG, `${J({ at: Date.now(), method: req.method, url: req.url, body: o })}\n`);
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(J({ data: [], models: [] }));
      return;
    }
    // A turn naming fail-once-token fails the first time it is seen, while the
    // file FAKE_FAIL_ONCE names does not exist yet, to make a turn to retry.
    const once = process.env.FAKE_FAIL_ONCE;
    if (once && userText(o.input).includes('fail-once-token') && !fs.existsSync(once)) {
      fs.writeFileSync(once, 'failed');
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(J({ error: { message: 'the stand-in failed this turn on purpose', type: 'server_error' } }));
      return;
    }
    const said = userText(o.input).trim().split('\n').at(-1) || '';
    const text = `codex heard: ${said}`;
    const id = `resp_${++n}`;
    const msgId = `msg_${n}`;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const ev = (type, data) => res.write(`event: ${type}\ndata: ${J({ type, ...data })}\n\n`);
    ev('response.created', { response: { id } });
    const item = { type: 'message', role: 'assistant', id: msgId, content: [{ type: 'output_text', text, annotations: [] }] };
    ev('response.output_item.added', { output_index: 0, item: { ...item, content: [] } });
    ev('response.output_text.delta', { output_index: 0, content_index: 0, item_id: msgId, delta: text });
    ev('response.output_item.done', { output_index: 0, item });
    ev('response.completed', {
      response: {
        id,
        usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 10, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 1010 },
      },
    });
    res.end();
  });
});
server.listen(Number(process.argv[3] || 0), '127.0.0.1', () => {
  console.log(`port ${server.address().port}`);
});
