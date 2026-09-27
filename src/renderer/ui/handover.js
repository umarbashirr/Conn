/* The conversation so far, as something the other CLI can read. A fork cannot
   hand over a thread, so it hands over the transcript: neither CLI can open the
   other's, and the new model starting from nothing is the thing a fork exists
   to avoid.

   Everything said goes across. Both sides of it, and every tool call by name
   and argument, because "I ran this and then that" is most of what a coding
   conversation is and a handover missing it reads as a summary of itself.

   The two caps below are the only things dropped, and both are announced in the
   text where they bite rather than silently.

   OUTPUT is per tool result. One `cat` of a large file or one verbose build log
   can be bigger than everything else combined, and it is also the most stale
   thing in the transcript: the new model is about to run its own commands
   against a tree that may have moved on. So the head of each result goes and
   the rest is marked.

   TOTAL is the backstop against a chat that will not fit in any window. It is
   set against real context windows rather than caution: 400k characters is
   roughly 100k tokens, which leaves room in a 200k window for the reply and the
   work after it. Trimming takes from the front, because a follow-up is nearly
   always about the recent end. */
const OUTPUT = 4000;
const TOTAL = 400000;

const clip = (text, n) => {
  const str = typeof text === 'string' ? text : JSON.stringify(text ?? null);
  if (!str || str.length <= n) return str || '';
  return `${str.slice(0, n)}\n… ${str.length - n} more characters of output, not carried over`;
};

function carriedHistory(items) {
  const lines = [];
  for (const it of items) {
    if (it.kind === 'user') lines.push(`Me:\n${it.text}`);
    else if (it.kind === 'assistant' && it.text?.trim()) lines.push(`Other assistant:\n${it.text}`);
    else if (it.kind === 'tool') {
      const args = clip(it.input, OUTPUT);
      const out = it.output === undefined ? '' : `\nResult:\n${clip(it.output, OUTPUT)}`;
      lines.push(`Other assistant ran ${it.name}:\n${args}${out}`);
    }
  }

  let body = lines.join('\n\n');
  const cut = body.length > TOTAL;
  if (cut) body = body.slice(-TOTAL);

  return [
    '<handover>',
    cut
      ? 'A conversation I was having with a different coding assistant. It was too long to carry whole, so this is the end of it:'
      : 'A conversation I was having with a different coding assistant, in full:',
    body,
    '</handover>',
    'Pick it up from here. Anything above is what the other assistant said, not something you did,',
    'and its tool output may be out of date. Read the files yourself before relying on any of it.',
  ].join('\n');
}

const ASK = 2000;
const ASKS = 16000;
const LAST_WORDS = 6000;
const EDITS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

// The first ask sets the goal and the latest ones are what is live, so a long
// run of asks gives up its middle.
function fitAsks(asks) {
  if (asks.join('\n\n').length <= ASKS) return asks;
  const tail = [];
  let room = ASKS - asks[0].length;
  for (let i = asks.length - 1; i > 0; i--) {
    room -= asks[i].length + 2;
    if (room < 0) break;
    tail.unshift(asks[i]);
  }
  return [asks[0], `(${asks.length - 1 - tail.length} asks in between left out)`, ...tail];
}

function touched(input) {
  const paths = [input?.file_path, input?.notebook_path];
  if (Array.isArray(input?.changes)) paths.push(...input.changes.map((c) => c?.path || c?.file));
  return paths.filter((p) => typeof p === 'string' && p);
}

function summarised(items) {
  const asks = items
    .filter((it) => it.kind === 'user' && !it.parent && it.text?.trim())
    .map((it, i) => `${i + 1}. ${clip(it.text, ASK)}`);

  const files = new Set();
  for (const it of items) {
    if (it.kind === 'tool' && EDITS.has(it.name)) touched(it.input).forEach((p) => files.add(p));
  }

  const todos = items.findLast((it) => it.kind === 'tool' && it.name === 'TodoWrite')?.input?.todos;
  const last = items.findLast((it) => it.kind === 'assistant' && !it.parent && it.text?.trim());

  const sections = [
    asks.length && `What I asked, in order:\n${fitAsks(asks).join('\n\n')}`,
    files.size && `Files it changed:\n${[...files].map((p) => `- ${p}`).join('\n')}`,
    Array.isArray(todos) && todos.length
      && `Its plan when we stopped:\n${todos.map((t) => `[${t.status}] ${t.content}`).join('\n')}`,
    last && `Where it left off:\n${clip(last.text, LAST_WORDS)}`,
  ].filter(Boolean);

  return [
    '<handover>',
    'A conversation I was having with a different coding assistant, summarised:',
    sections.join('\n\n'),
    '</handover>',
    'Pick it up from here. Anything above is what the other assistant said, not something you did,',
    'and its tool output may be out of date. Read the files yourself before relying on any of it.',
  ].join('\n');
}

export function handover(kind, items) {
  switch (kind) {
    case 'complete': return carriedHistory(items);
    case 'summary': return summarised(items);
    default: throw new Error(`Unknown handover kind: ${kind}`);
  }
}
