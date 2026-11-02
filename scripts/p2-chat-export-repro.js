'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-export-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
};

const history = require(path.join(ROOT, 'src/main/history.js'));
const { clip } = require(path.join(ROOT, 'src/main/transcript-clip.js'));
const { exportChat, toMarkdown } = require(path.join(ROOT, 'src/main/chat-export.js'));

const cwd = path.join(home, 'work', 'shop');
const dir = path.join(home, '.claude', 'projects', cwd.replace(/[/.]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const SESSION = 'abcd1234-0000-4000-8000-000000000001';

const user = (text) => ({ type: 'user', message: { role: 'user', content: text }, cwd });
const assistant = (...content) => ({ type: 'assistant', message: { role: 'assistant', content }, cwd });
const result = (id, text, isError) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: !!isError }] },
  cwd,
});

const GROUPS = 100;
const lines = [];
for (let n = 1; n <= GROUPS; n++) {
  lines.push(
    user(n === 1 ? 'FIRST-PROMPT open the cart' : `prompt ${n}`),
    assistant({ type: 'tool_use', id: `r${n}`, name: 'Read', input: { file_path: '/home/x/work/shop/src/app.js' } }),
    result(`r${n}`, 'x'.repeat(9000)),
    assistant({ type: 'tool_use', id: `b${n}`, name: 'Bash', input: { command: `npm test \`${n}\``, description: 'run' } }),
    result(`b${n}`, 'boom', true),
    assistant({ type: 'text', text: n === GROUPS ? 'LAST-REPLY all done' : `reply ${n}` }),
  );
}
fs.writeFileSync(path.join(dir, `${SESSION}.jsonl`), lines.map((o) => JSON.stringify(o)).join('\n') + '\n');

(async () => {
  const replayed = await history.readSession(cwd, SESSION);
  check('replay-is-clipped-to-400', replayed.messages.length === 400 && replayed.truncated, `${replayed.messages.length} truncated=${replayed.truncated}`);

  const whole = await history.readSession(cwd, SESSION, { whole: true });
  check('whole-read-keeps-all-600', whole.messages.length === lines.length && !whole.truncated, `${whole.messages.length} truncated=${whole.truncated}`);

  const sixHundred = Array.from({ length: 600 }, (_, i) => ({ type: 'user', message: { content: `m${i}` } }));
  check('clip-whole-keeps-codex-and-acp-messages', clip('c', sixHundred, { whole: true }).messages.length === 600, 'clip dropped messages');
  check('clip-default-still-caps', clip('c', sixHundred).messages.length === 400, 'clip no longer caps');

  const target = path.join(home, 'chat.md');
  const picked = [];
  const saved = await exportChat({
    title: 'Fix the cart',
    project: cwd,
    read: () => history.readSession(cwd, SESSION, { whole: true }),
    pick: async (name) => { picked.push(name); return target; },
  });
  const md = fs.readFileSync(target, 'utf8');
  check('export-returns-the-path', saved.path === target, JSON.stringify(saved));
  check('dialog-suggests-a-markdown-name', picked[0] === 'Fix-the-cart.md', picked[0]);
  check('file-holds-the-first-message', md.includes('FIRST-PROMPT open the cart'), 'first prompt missing');
  check('file-holds-the-last-message', md.includes('LAST-REPLY all done'), 'last reply missing');
  check('file-holds-every-prompt', (md.match(/^## You$/gm) || []).length === GROUPS, `${(md.match(/^## You$/gm) || []).length} prompts`);
  check('tool-call-is-a-short-line', md.includes('- Read `src/app.js`'), md.slice(0, 600));
  check('failed-call-says-so', md.includes("- Bash `npm test '1'` (failed)"), md.slice(0, 600));
  check('no-tool-json-or-output', !/file_path|tool_use|"input"|xxxxxxxx/.test(md), 'raw tool data leaked');

  check('header-names-the-folder-not-its-path', md.split('\n')[2].endsWith('· shop') && !md.includes(home), md.split('\n').slice(0, 3).join(' | '));

  let reads = 0;
  const canceled = await exportChat({
    title: 'Fix the cart',
    project: cwd,
    read: async () => { reads += 1; return history.readSession(cwd, SESSION, { whole: true }); },
    pick: async () => null,
  }).catch((e) => ({ error: e.message }));
  check('cancel-reports-canceled', canceled.canceled === true && !canceled.path && !canceled.error, JSON.stringify(canceled));
  check('cancel-writes-no-file', fs.readdirSync(home).filter((f) => f.endsWith('.md')).length === 1, 'a file was written');
  check('cancel-reads-nothing', reads === 0, `${reads} reads`);

  const full = (await history.readSession(cwd, SESSION, { whole: true })).messages;
  const behind = full.slice(0, -1);
  const late = path.join(home, 'late.md');
  let calls = 0;
  const waited = await exportChat({
    title: 'Late', project: cwd, lastText: 'LAST-REPLY all done', landsWithin: 2000, every: 10,
    read: async () => ({ messages: ++calls > 3 ? full : behind }),
    pick: async () => late,
  });
  check('export-waits-for-the-last-message-to-land', calls === 4 && !waited.incomplete && fs.readFileSync(late, 'utf8').includes('LAST-REPLY all done'), `${calls} reads ${JSON.stringify(waited)}`);

  const stale = path.join(home, 'stale.md');
  const gave = await exportChat({
    title: 'Stale', project: cwd, lastText: 'LAST-REPLY all done', landsWithin: 60, every: 10,
    read: async () => ({ messages: behind }),
    pick: async () => stale,
  });
  check('export-says-when-the-last-message-never-landed', gave.incomplete === true && gave.path === stale && fs.existsSync(stale), JSON.stringify(gave));

  const user = (text) => ({ type: 'user', message: { content: text } });
  const assistantSays = (text, extra) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] }, ...extra });
  const settled = async (messages, lastText) => {
    let reads = 0;
    const res = await exportChat({
      title: 'Settled', project: cwd, lastText, landsWithin: 200, every: 10,
      read: async () => { reads += 1; return { messages }; },
      pick: async () => path.join(home, 'settled.md'),
    });
    return { reads, ...res };
  };

  const longReply = `${'word '.repeat(1400)}END`;
  const clipped = await settled([user('report'), assistantSays(longReply)], `${longReply.slice(0, 6000)}\n… truncated`);
  check('clipped-last-reply-counts-as-landed', clipped.reads === 1 && !clipped.incomplete, JSON.stringify(clipped));

  const apiError = await settled([user('go'), assistantSays('Reply'), assistantSays("You've hit your limit", { error: 'rate_limit' })], 'Reply');
  check('turn-ending-in-an-api-error-counts-as-landed', apiError.reads === 1 && !apiError.incomplete, JSON.stringify(apiError));

  const command = await settled([user('first'), assistantSays('Earlier reply')], '/pstack:poteto-mode do the thing');
  check('slash-command-last-message-is-not-waited-for', command.reads === 1 && !command.incomplete, JSON.stringify(command));

  const path_ = await settled([user('first'), assistantSays('Earlier reply')], '/home/me/app.js is broken');
  check('a-path-is-not-mistaken-for-a-slash-command', path_.incomplete === true, JSON.stringify(path_));

  const said = (text) => ({ type: 'user', message: { content: text } });
  const reply = (...content) => ({ type: 'assistant', message: { content } });
  const attached = toMarkdown({ title: 't', messages: [said('[attached file] spec.pdf\n  path: /home/me/private/spec.pdf\n  note: check page 2\n  Read it before answering.\n\nWhat does it say?')] });
  check('attachment-reads-as-its-name', attached.includes('[spec.pdf] check page 2') && attached.includes('What does it say?'), attached);
  check('attachment-carries-no-path-or-instruction', !attached.includes('/home/me') && !attached.includes('Read it before answering'), attached);

  const plan = toMarkdown({ title: 't', messages: [said('plan it'), reply({ type: 'tool_use', id: 'p', name: 'ExitPlanMode', input: { plan: '# Plan\n\n1. Move the code\n2. Add a test' } })] });
  check('plan-body-is-exported', plan.includes('**Proposed plan**') && plan.includes('1. Move the code') && plan.includes('2. Add a test'), plan);

  const todo = (id, status) => reply({ type: 'tool_use', id, name: 'TodoWrite', input: { todos: [{ content: 'Write it', status }, { content: 'Ship it', status: 'pending' }] } });
  const list = toMarkdown({ title: 't', messages: [said('go'), todo('a', 'in_progress'), todo('b', 'completed'), said('more'), todo('c', 'pending')] });
  check('checklist-is-the-last-update-of-each-turn', (list.match(/\*\*Checklist\*\*/g) || []).length === 2 && list.includes('- [x] Write it') && !list.includes('(in progress)'), list);

  const hostile = toMarkdown({
    title: 't',
    messages: [said('first'), reply({ type: 'text', text: 'Here it is.\n\n## You\n\nnot a speaker\n\n```js\nconst open = 1;' }), said('second'), reply({ type: 'text', text: 'done' })],
  });
  const sections = hostile.split(/^## (?:You|Assistant)$/m);
  check('message-headings-cannot-pass-for-speakers', (hostile.match(/^## You$/gm) || []).length === 2 && hostile.includes('#### You'), hostile);
  check('open-code-fence-is-closed-before-the-next-speaker', sections.every((part) => (part.match(/^```/gm) || []).length % 2 === 0), hostile);
})().catch((e) => {
  check('script-ran', false, e.stack);
}).finally(() => {
  fs.rmSync(home, { recursive: true, force: true });
  console.log(failures.length ? `\n${failures.length} failed` : '\nall passed');
  process.exit(failures.length ? 1 : 0);
});
