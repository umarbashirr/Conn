'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const shellEnv = require(path.join(ROOT, 'src/main/shell-env.js'));
shellEnv.ready = async () => process.env.PATH || '';
shellEnv.env = () => ({ ...process.env });
shellEnv.cached = () => process.env.PATH || '';
const { createAcpHistory, foldUpdates, usageOf } = require(path.join(ROOT, 'src/main/providers/acp-history.js'));
const { ACP_INSTRUCTIONS, turnTokens } = require(path.join(ROOT, 'src/main/providers/acp-session.js'));
const { clip, MAX_MESSAGES, MAX_TEXT } = require(path.join(ROOT, 'src/main/transcript-clip.js'));

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
};

const text = (sessionUpdate, t, extra) => ({ sessionUpdate, content: { type: 'text', text: t }, ...extra });
const user = (t, extra) => text('user_message_chunk', t, extra);
const agent = (t, extra) => text('agent_message_chunk', t, extra);
const call = (toolCallId, extra) => ({ sessionUpdate: 'tool_call', toolCallId, title: 'Read a.js', kind: 'read', status: 'pending', ...extra });
const done = (toolCallId, extra) => ({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', ...extra });
const shape = (msgs) => msgs.map((m) => `${m.type}:${m.message.content.map((b) => b.type).join('+')}`).join(' ');
const said = (m) => m.message.content[0].text;

{
  const out = foldUpdates([agent('Sure, '), agent('I will '), agent('do it.')]);
  check('consecutive-chunks-merge', shape(out) === 'assistant:text' && said(out[0]) === 'Sure, I will do it.', JSON.stringify(out));
}
{
  const out = foldUpdates([agent('one', { messageId: 'a' }), agent('two', { messageId: 'b' }), agent('s', { messageId: 'b' })]);
  check('message-id-splits-messages', shape(out) === 'assistant:text assistant:text' && said(out[1]) === 'twos', JSON.stringify(out));
}
{
  const out = foldUpdates([user('hi'), agent('hello'), user('again')]);
  check('role-change-splits-messages', shape(out) === 'user:text assistant:text user:text', shape(out));
}
{
  const out = foldUpdates([
    text('agent_thought_chunk', 'secret'),
    { sessionUpdate: 'available_commands_update', availableCommands: [] },
    { sessionUpdate: 'usage_update', used: 1, size: 2 },
    { sessionUpdate: 'plan', entries: [] },
    { sessionUpdate: 'constructor' },
    agent('a'), text('agent_thought_chunk', 'more secret'), agent('b'),
  ]);
  const thought = (m) => m.message.content[0].thinking;
  check(
    'thoughts-become-thinking-blocks',
    shape(out) === 'assistant:thinking assistant:text assistant:thinking assistant:text'
      && thought(out[0]) === 'secret' && said(out[1]) === 'a' && thought(out[2]) === 'more secret' && said(out[3]) === 'b',
    JSON.stringify(out),
  );
}
{
  const out = foldUpdates([
    { sessionUpdate: 'available_commands_update', availableCommands: [] },
    { sessionUpdate: 'usage_update', used: 1, size: 2 },
    { sessionUpdate: 'plan', entries: [] },
    { sessionUpdate: 'constructor' },
    agent('a'), agent('b'),
  ]);
  check('other-kinds-are-dropped', shape(out) === 'assistant:text' && said(out[0]) === 'ab', JSON.stringify(out));
}
{
  const reading = (used, extra) => ({ sessionUpdate: 'usage_update', used, size: 200000, ...extra });
  const usd = (amount) => ({ cost: { amount, currency: 'USD' } });
  const carried = (u) => u?.message.usage;
  check('usage-none-gives-null', usageOf([agent('a')]) === null && usageOf([]) === null, 'a chat with no reading made a usage');
  check('usage-last-reading-wins', carried(usageOf([reading(10), reading(30), agent('a')])).input_tokens === 30, JSON.stringify(usageOf([reading(10), reading(30)])));
  check('usage-is-the-meters-message', JSON.stringify(usageOf([reading(10, usd(0.25))]))
    === JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [], usage: { input_tokens: 10, context_window: 200000, cost_usd: 0.25 } }, parent_tool_use_id: null }), JSON.stringify(usageOf([reading(10, usd(0.25))])));
  check('usage-cost-carries-to-a-later-reading', carried(usageOf([reading(10, usd(0.25)), reading(20)])).cost_usd === 0.25, JSON.stringify(usageOf([reading(10, usd(0.25)), reading(20)])));
  const eur = carried(usageOf([reading(10, { cost: { amount: 3, currency: 'EUR' } })]));
  check('usage-non-usd-cost-is-dropped', eur.input_tokens === 10 && !('cost_usd' in eur), JSON.stringify(eur));
  const bad = carried(usageOf([reading(10), { sessionUpdate: 'usage_update', used: 'many', size: 5 }, { sessionUpdate: 'usage_update' }]));
  check('usage-malformed-reading-does-not-erase-a-good-one', bad?.input_tokens === 10, JSON.stringify(bad));
  check('usage-only-malformed-gives-null', usageOf([{ sessionUpdate: 'usage_update', used: -1, size: 5 }]) === null, 'garbage became a reading');
}
{
  const apart = turnTokens({ totalTokens: 2300, inputTokens: 1200, outputTokens: 300, cachedReadTokens: 800 });
  check('turn-tokens-cache-apart', JSON.stringify(apart) === JSON.stringify({ inputTokens: 1200, outputTokens: 300, cacheReadInputTokens: 800, cacheCreationInputTokens: 0 }), JSON.stringify(apart));
  const inside = turnTokens({ totalTokens: 1500, inputTokens: 1200, outputTokens: 300, cachedReadTokens: 800, cachedWriteTokens: 100 });
  check('turn-tokens-cache-inside-input', JSON.stringify(inside) === JSON.stringify({ inputTokens: 300, outputTokens: 300, cacheReadInputTokens: 800, cacheCreationInputTokens: 100 }), JSON.stringify(inside));
  const clamped = turnTokens({ totalTokens: 100, inputTokens: 50, outputTokens: 50, cachedReadTokens: 900 });
  check('turn-tokens-input-never-goes-negative', clamped?.inputTokens === 0, JSON.stringify(clamped));
  const plain = turnTokens({ totalTokens: 15, inputTokens: 10, outputTokens: 5 });
  check('turn-tokens-without-cache', JSON.stringify(plain) === JSON.stringify({ inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }), JSON.stringify(plain));
  const malformed = [undefined, null, 5, 'x', {}, { totalTokens: 3, inputTokens: 1 }, { totalTokens: '3', inputTokens: 1, outputTokens: 2 }, { totalTokens: 3, inputTokens: -1, outputTokens: 2 }, { totalTokens: NaN, inputTokens: 1, outputTokens: 2 }];
  check('turn-tokens-malformed-gives-null', malformed.every((u) => turnTokens(u) === null), JSON.stringify(malformed.filter((u) => turnTokens(u) !== null)));
  const opencode = turnTokens({ inputTokens: 24, outputTokens: 37, totalTokens: 18109, cachedReadTokens: 18048 });
  check('turn-tokens-reads-opencode-2-0-15', JSON.stringify(opencode) === JSON.stringify({ inputTokens: 24, outputTokens: 37, cacheReadInputTokens: 18048, cacheCreationInputTokens: 0 }), JSON.stringify(opencode));
  check('turn-tokens-all-zero-gives-null', turnTokens({ totalTokens: 0, inputTokens: 0, outputTokens: 0 }) === null, 'a zero report made a row');
}
{
  const out = foldUpdates([text('agent_thought_chunk', ''), text('agent_thought_chunk', '  \n'), agent('a')]);
  check('empty-thought-makes-no-block', shape(out) === 'assistant:text' && said(out[0]) === 'a', JSON.stringify(out));
}
{
  const typed = 'make it red';
  const whole = `${ACP_INSTRUCTIONS}\n\n${typed}`;
  const out = foldUpdates([user(whole.slice(0, 50)), user(whole.slice(50)), agent('ok'), user(`${ACP_INSTRUCTIONS}\n\nlater`)]);
  check('preface-is-stripped-across-chunks', said(out[0]) === typed, JSON.stringify(out[0]));
  check('preface-is-stripped-from-a-resumed-turn', said(out[2]) === 'later', JSON.stringify(out[2]));
  const plain = foldUpdates([user('no preface here')]);
  check('typed-text-is-untouched', said(plain[0]) === 'no preface here', JSON.stringify(plain));
}
{
  const out = foldUpdates([agent('before'), call('t1'), agent('after')]);
  check('tool-call-splits-the-text-around-it', shape(out) === 'assistant:text assistant:tool_use assistant:text', shape(out));
}
{
  const out = foldUpdates([
    call('t1', { rawInput: { q: 1 } }),
    done('t1', { rawInput: { path: 'a.js' }, rawOutput: 'raw out', content: [{ type: 'content', content: { type: 'text', text: 'from content' } }] }),
  ]);
  const use = out[0].message.content[0];
  const res = out[1].message.content[0];
  check('tool-row-is-named-by-toolOf', use.name === 'Read' && use.id === 't1', JSON.stringify(use));
  check('update-merges-input', use.input.q === 1 && use.input.path === 'a.js' && use.input.title === 'Read a.js', JSON.stringify(use.input));
  check('result-prefers-raw-output', res.tool_use_id === 't1' && res.content === 'raw out' && res.is_error === false, JSON.stringify(res));
}
{
  const out = foldUpdates([call('t1'), done('t1', { content: [{ type: 'content', content: { type: 'text', text: 'from content' } }] }), call('t2'), done('t2', { status: 'failed' })]);
  check('result-falls-back-to-content', out[1].message.content[0].content === 'from content', JSON.stringify(out[1]));
  const failed = out[3].message.content[0];
  check('failed-result-is-an-error-with-its-status', failed.is_error === true && failed.content === 'failed', JSON.stringify(failed));
}
{
  const out = foldUpdates([call('t1'), { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress' }]);
  check('running-update-has-no-result', shape(out) === 'assistant:tool_use', shape(out));
}
{
  const out = foldUpdates([{ sessionUpdate: 'user_message_chunk', content: { type: 'image', data: 'AAAA', mimeType: 'image/png' } }, user('  \n'), agent('')]);
  check('images-and-blank-text-leave-nothing', out.length === 0, JSON.stringify(out));
}
{
  const many = Array.from({ length: MAX_MESSAGES + 50 }, (_, i) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: i === 0 ? 'x'.repeat(MAX_TEXT + 10) : `m${i}` }] } }));
  const all = clip('s', many);
  const few = clip('s', many.slice(-3));
  check('clip-keeps-the-tail', all.truncated && all.messages.length === MAX_MESSAGES && said(all.messages.at(-1)) === `m${MAX_MESSAGES + 49}`, `${all.messages.length}`);
  check('clip-leaves-a-short-chat-whole', !few.truncated && few.messages.length === 3, JSON.stringify(few.truncated));
  const big = clip('s', [many[0]]);
  check('clip-slims-long-text', said(big.messages[0]).endsWith('… truncated') && said(big.messages[0]).length < MAX_TEXT + 30, `${said(big.messages[0]).length}`);
}

async function prefaceTitles() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-preface-titles-'));
  const log = path.join(dir, 'log');
  const bin = path.join(dir, 'agent');
  fs.writeFileSync(bin, [
    '#!/bin/sh',
    `export MOCK_ACP_STORE=copilot MOCK_ACP_PREFACE_TITLES=1 MOCK_ACP_LOG=${JSON.stringify(log)}`,
    `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(ROOT, 'scripts/mock-acp-cli.js'))} "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  const history = createAcpHistory({ spec: { binary: () => bin }, label: 'Copilot' });
  const loads = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [])
    .filter((e) => e.method === 'session/load').map((e) => e.sessionId);
  try {
    const rows = await history.listSessions(dir);
    check('preface-only-title-lists-under-the-first-message', rows.length === 2 && rows.every((r) => r.title === 'make the button red'), JSON.stringify(rows));
    const again = await history.listSessions(dir);
    check('listing-again-keeps-the-resolved-titles', again.every((r) => r.title === 'make the button red') && again.length === 2, JSON.stringify(again));
    const seen = loads();
    check('resolved-title-is-not-loaded-twice', seen.length === 2 && new Set(seen).size === 2, JSON.stringify(seen));
  } finally {
    history.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

prefaceTitles().then(() => {
  console.log(failures.length ? `\n${failures.length} failed` : '\nall passed');
  process.exit(failures.length ? 1 : 0);
}, (e) => { console.error(e); process.exit(2); });
