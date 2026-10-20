#!/usr/bin/env node
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const J = JSON.stringify;

export function plan(text, project) {
  const at = (p) => path.resolve(project, p.trim());
  const steps = [];
  let delay = 0;
  let said = null;
  const push = (tool, input) => { steps.push({ tool, input, delay }); delay = 0; };
  for (const line of text.split(/\n| ;; /).map((l) => l.trim())) {
    let m;
    // `edit` reads the file first, because the CLI refuses an edit to a file it has not read.
    if ((m = /^edit (.+?): (.*) => (.*)$/.exec(line))) {
      push('Read', { file_path: at(m[1]) });
      push('Edit', { file_path: at(m[1]), old_string: m[2], new_string: m[3] });
    } else if ((m = /^write (.+?): (.*)$/.exec(line))) push('Write', { file_path: at(m[1]), content: m[2].replaceAll('\\n', '\n') });
    else if ((m = /^read (.+)$/.exec(line))) push('Read', { file_path: at(m[1]) });
    else if ((m = /^bash: (.+)$/.exec(line))) push('Bash', { command: m[1], description: 'Run a shell command' });
    else if ((m = /^wait (\d+(?:\.\d+)?)$/.exec(line))) delay += Number(m[1]) * 1000;
    else if ((m = /^say: (.+)$/.exec(line))) said = m[1];
  }
  if (!steps.length && said === null && !delay) return null;
  return { steps, end: { text: said ?? 'Done.', delay } };
}

const textOf = (content) => (typeof content === 'string' ? content
  : (content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n'));

export function reply(body, project) {
  const messages = body?.messages || [];
  let done = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const blocks = typeof m.content === 'string' ? [] : m.content || [];
    if (m.role !== 'user') continue;
    const text = textOf(m.content);
    const script = body?.tools?.length ? plan(text, project) : null;
    // After Stop the CLI sends the next prompt in the same message as the
    // stopped turn's last tool result, and that prompt's script starts afresh.
    if (blocks.some((b) => b.type === 'tool_result') && !script) { done += 1; continue; }
    if (!script) return { text: `heard: ${text.trim().split('\n').at(-1) || ''}`, delay: 0 };
    return script.steps[done] ?? script.end;
  }
  return { text: 'heard nothing', delay: 0 };
}

const sse = (model, step, n) => {
  const ev = (type, data) => `event: ${type}\ndata: ${J({ type, ...data })}\n\n`;
  const block = step.tool
    ? { type: 'tool_use', id: `toolu_verify_${n}_${Date.now().toString(36)}`, name: step.tool, input: {} }
    : { type: 'text', text: '' };
  const delta = step.tool ? { type: 'input_json_delta', partial_json: J(step.input) } : { type: 'text_delta', text: step.text };
  return [
    ev('message_start', { message: { id: `msg_verify_${n}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }),
    ev('content_block_start', { index: 0, content_block: block }),
    ev('content_block_delta', { index: 0, delta }),
    ev('content_block_stop', { index: 0 }),
    ev('message_delta', { delta: { stop_reason: step.tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }),
    ev('message_stop', {}),
  ].join('');
};

export function serve({ project, port = 0 } = {}) {
  let n = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw); } catch {}
      if (!/^\/v1\/messages(\?|$)/.test(req.url)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(/count_tokens/.test(req.url) ? J({ input_tokens: 10 }) : '{}');
      }
      const step = reply(body, project);
      n += 1;
      const send = () => {
        if (res.destroyed) return;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sse(body?.model, step, n));
      };
      if (step.delay) setTimeout(send, step.delay); else send();
    });
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok({ server, port: server.address().port })));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const project = process.argv[2];
  if (!project) { console.error('usage: claude-api.mjs <project dir>'); process.exit(2); }
  const { port } = await serve({ project });
  console.log(`listening ${port}`);
}
