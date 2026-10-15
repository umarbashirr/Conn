'use strict';
/* Editing or retrying a Claude message forks its transcript to just before
   that message and carries on from the fork. This holds that on a throwaway
   HOME: first against a fixture shaped like what the claude binary writes,
   then, when a claude binary is on hand, against the real CLI talking to a
   local stand-in for the Messages API, so a send, a fork, a resume and a
   replay all run through the code Conn ships. Set CLAUDE_BIN to pick the
   binary. */
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const J = JSON.stringify;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-rewind-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rejects = async (p) => { try { await p; return null; } catch (e) { return e.message; } };

const history = require(path.join(ROOT, 'src/main/history.js'));

const cwd = path.join(home, 'work', 'shop');
fs.mkdirSync(cwd, { recursive: true });
const dir = path.join(home, '.claude', 'projects', cwd.replace(/[/.]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const lines = (id) => fs.readFileSync(path.join(dir, `${id}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

const SESSION = '5e551011-0000-4000-8000-000000000001';
const u = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function fixture() {
  let parent = null;
  const entry = (type, n, extra) => {
    const o = { type, uuid: u(n), parentUuid: parent, sessionId: SESSION, cwd, isSidechain: false, timestamp: new Date(Date.UTC(2026, 9, 15, 10, 0, n)).toISOString(), ...extra };
    parent = o.uuid;
    return o;
  };
  const said = (n, text) => entry('user', n, { message: { role: 'user', content: [{ type: 'text', text }] } });
  const reply = (n, text) => entry('assistant', n, { message: { role: 'assistant', content: [{ type: 'text', text }] } });
  const attach = (n) => entry('attachment', n, { attachment: { type: 'skill_listing', content: 'x' } });
  return [
    { type: 'queue-operation', operation: 'enqueue', sessionId: SESSION },
    said(1, 'make the coupon field wider'), attach(2), reply(3, 'Widened it.'),
    said(4, 'now make it blue'), attach(5), reply(6, 'It is blue.'),
    said(7, 'and add a border'), reply(8, 'Bordered.'),
  ];
}

async function onFixture() {
  const file = path.join(dir, `${SESSION}.jsonl`);
  fs.writeFileSync(file, fixture().map((o) => J(o)).join('\n') + '\n');
  const before = fs.readFileSync(file, 'utf8');

  const replayed = await history.readSession(cwd, SESSION);
  const prompts = replayed.messages.filter((m) => m.type === 'user').map((m) => m.uuid);
  check('replay-keeps-each-prompt-uuid', J(prompts) === J([u(1), u(4), u(7)]), J(prompts));

  const res = await history.forkBefore(cwd, SESSION, u(4));
  const fork = res.sessionId ? lines(res.sessionId) : [];
  const from = fork.filter((o) => o.forkedFrom).map((o) => o.forkedFrom.messageUuid);
  check('fork-is-a-new-session', !!res.sessionId && res.sessionId !== SESSION, J(res));
  check('fork-ends-at-the-entry-before-the-message', J(from) === J([u(1), u(2), u(3)]), J(from));
  check('fork-gives-each-entry-a-new-uuid', fork.filter((o) => o.forkedFrom).every((o) => !o.uuid.startsWith('00000000-')), J(fork.map((o) => o.uuid)));
  const first = fork.find((o) => o.forkedFrom?.messageUuid === u(1));
  check('fork-maps-kept-prompts-to-their-new-uuid', J(res.uuids) === J({ [u(1)]: first?.uuid }), J(res.uuids));
  check('original-transcript-is-untouched', fs.readFileSync(file, 'utf8') === before, 'the source file changed');

  const fresh = await history.forkBefore(cwd, SESSION, u(1));
  check('first-message-starts-over', fresh.sessionId === null && J(fresh.uuids) === '{}', J(fresh));
  check('first-message-writes-no-fork', fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).length === 2, J(fs.readdirSync(dir)));

  const late = await history.forkBefore(cwd, SESSION, u(7));
  const again = await history.forkBefore(cwd, late.sessionId, late.uuids[u(4)]);
  check('fork-of-a-fork-uses-the-new-uuids', !!again.sessionId && J(Object.keys(again.uuids)) === J([late.uuids[u(1)]]), J({ late, again }));

  check('refuses-a-session-that-is-not-a-uuid', /not a session id/.test(await rejects(history.forkBefore(cwd, '../x', u(4))) || ''), 'accepted');
  check('refuses-a-message-that-is-not-a-uuid', /not a message id/.test(await rejects(history.forkBefore(cwd, SESSION, 'u4')) || ''), 'accepted');
  check('refuses-an-assistant-message', /is not in session/.test(await rejects(history.forkBefore(cwd, SESSION, u(3))) || ''), 'forked before a reply');
}

// Just enough of the Messages API for the CLI to finish a turn. Each reply
// echoes the prompt, so the requests say what history the CLI sent.
function standInApi() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch {}
      requests.push(parsed);
      if (!/^\/v1\/messages(\?|$)/.test(req.url)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{}');
      }
      const last = parsed?.messages?.at(-1)?.content;
      const said = typeof last === 'string' ? last : (last || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ');
      const ev = (type, data) => `event: ${type}\ndata: ${J({ type, ...data })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end([
        ev('message_start', { message: { id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: parsed?.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }),
        ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
        ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: `heard: ${said.trim().split('\n').at(-1)}` } }),
        ev('content_block_stop', { index: 0 }),
        ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }),
        ev('message_stop', {}),
      ].join(''));
    });
  });
  return { requests, server };
}

async function onRealCli(bin) {
  const { requests, server } = standInApi();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  Object.assign(process.env, {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    ANTHROPIC_API_KEY: 'sk-ant-conn-rewind-check',
    ANTHROPIC_AUTH_TOKEN: '',
    CLAUDE_CODE_OAUTH_TOKEN: '',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  });
  require(path.join(ROOT, 'src/main/driver.js')).preferBinary(bin);
  const { AgentSession } = require(path.join(ROOT, 'src/main/agent.js'));

  const sessions = [];
  const open = async (resume) => {
    const s = new AgentSession({ cwd, resume, model: 'claude-sonnet-4-5' });
    s.results = 0;
    s.on('message', (m) => { if (m.type === 'result') s.results += 1; });
    s.on('error', (e) => console.log(`agent error: ${e}`));
    sessions.push(s);
    await s.start();
    return s;
  };
  const turn = async (s, text) => {
    const want = s.results + 1;
    const uuid = s.send(text);
    for (const end = Date.now() + 60000; s.results < want && Date.now() < end;) await sleep(50);
    if (s.results < want) throw new Error(`no result for ${J(text)}`);
    return uuid;
  };

  try {
    const s1 = await open(null);
    const first = await turn(s1, 'alpha one');
    const second = await turn(s1, 'bravo two');
    check('send-mints-a-v4-uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(second), second);

    const forked = await history.forkBefore(cwd, s1.sessionId, second);
    s1.stop();
    const kept = lines(s1.sessionId).filter((o) => o.type === 'user' && !o.message.content.some?.((b) => b.type === 'tool_result')).map((o) => o.uuid);
    check('cli-writes-the-uuid-conn-sent', kept.includes(first) && kept.includes(second), `sent ${first} ${second}, transcript has ${J(kept)}`);
    check('cli-fork-maps-the-first-prompt', !!forked.uuids[first], J(forked));

    const s2 = await open(forked.sessionId);
    const third = await turn(s2, 'charlie edited');
    check('resume-continues-the-fork', s2.sessionId === forked.sessionId, `${s2.sessionId} vs ${forked.sessionId}`);
    const sent = requests.filter((r) => J(r?.messages || []).includes('charlie edited')).sort((a, b) => b.messages.length - a.messages.length)[0];
    const asText = J(sent?.messages || []);
    check('resumed-fork-sends-the-kept-turn', asText.includes('alpha one'), asText.slice(0, 400));
    check('resumed-fork-drops-the-edited-turn', !asText.includes('bravo two'), asText.slice(0, 400));
    const refork = await history.forkBefore(cwd, forked.sessionId, third).catch((e) => ({ error: e.message }));
    check('message-sent-on-a-fork-forks-again', !!refork.sessionId && !!refork.uuids?.[forked.uuids[first]], J(refork));
    s2.stop();
    await sleep(1500);

    const replayed = await history.readSession(cwd, forked.sessionId);
    const ids = replayed.messages.filter((m) => m.type === 'user').map((m) => m.uuid);
    check('replay-of-the-fork-carries-the-mapped-uuid', ids[0] === forked.uuids[first], `${J(ids)} vs ${forked.uuids[first]}`);
  } catch (e) {
    check('real-cli-run', false, e.stack || e.message);
  } finally {
    for (const s of sessions) s.stop();
    server.close();
  }
}

(async () => {
  await onFixture();
  const bin = process.env.CLAUDE_BIN || require(path.join(ROOT, 'src/main/driver.js')).claudeBinary();
  if (bin) await onRealCli(bin);
  else console.log('SKIP real-cli: no claude binary found; set CLAUDE_BIN to run it');
  fs.rmSync(home, { recursive: true, force: true });
  console.log(failures.length ? `\n${failures.length} failed` : '\nall passed');
  process.exit(failures.length ? 1 : 0);
})();
