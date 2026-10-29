'use strict';
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { foldUpdates } = require(path.join(ROOT, 'src/main/providers/acp-history.js'));
const { ACP_INSTRUCTIONS } = require(path.join(ROOT, 'src/main/providers/acp-session.js'));
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

console.log(failures.length ? `\n${failures.length} failed` : '\nall passed');
process.exit(failures.length ? 1 : 0);
