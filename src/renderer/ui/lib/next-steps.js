/* Follow-ups offered once a turn has ended, read off what the turn did. No
   model is asked: every rule looks at the items the chat already holds, so the
   chips appear the moment the turn stops and cost nothing.

   Every provider's calls arrive under the same few names (Codex and ACP map
   theirs onto Edit and Bash in main), so one set of rules covers all of them.

   A step is { text, mode? }. `mode` is a mode to switch to before the text is
   used, for "implement this plan" out of Plan mode. */
'use strict';

const MAX = 3;
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const LOCAL_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?[^\s)>"'`]*/i;
const TEST_CMD = /\b(test|jest|vitest|pytest|mocha|go test|cargo test|check)\b/i;
const COMMIT_CMD = /\bgit\s+commit\b/;

// The items since the last thing the person sent, without subagents' rows.
function lastTurn(items) {
  let start = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === 'user') { start = i + 1; break; }
  }
  return items.slice(start).filter((it) => !it.parent);
}

const asText = (v) => (typeof v === 'string' ? v
  : Array.isArray(v) ? v.map((b) => (typeof b === 'string' ? b : b?.text || '')).join('\n')
    : '');

/* Choices the reply ends on: a numbered or lettered list after a question, as
   in "Which way?\n1. **Keep it** ...\n2. **Drop it** ...". Only a list in the
   reply's last stretch counts, so a numbered walkthrough earlier on is not
   mistaken for a menu. */
function choicesIn(text) {
  const tail = text.trim().split('\n').slice(-14).join('\n');
  if (!/\?/.test(tail)) return [];
  const rows = [...tail.matchAll(/^\s*(?:(\d)[.)]|\(?([A-Ca-c])[.)]|Option\s+([A-C1-9])[:.)]?)\s+(.+)$/gm)];
  if (rows.length < 2 || rows.length > 5) return [];
  return rows.map((m) => {
    const tag = m[1] || m[2] || m[3];
    const name = m[4].replace(/\*\*(.+?)\*\*.*/, '$1').replace(/[:—–-].*$/, '').replace(/[*_`]/g, '').trim();
    const short = name.length > 0 && name.length <= 40 ? `: ${name}` : '';
    return { text: `Go with option ${tag}${short}` };
  });
}

// A yes or no question at the very end, such as "Want me to commit this?".
const asksYesNo = (text) => /\b(want me to|should i|shall i|would you like me to|do you want me to|ok to|okay to)\b[^?]*\?\s*$/i
  .test(text.trim().split('\n').slice(-2).join(' '));

export function nextSteps(items, { mode } = {}) {
  if (!items?.length) return [];
  const turn = lastTurn(items);
  if (!turn.length) return [];
  const tools = turn.filter((it) => it.kind === 'tool');
  const reply = asText([...turn].reverse().find((it) => it.kind === 'assistant')?.text);
  const out = [];
  const add = (step) => { if (!out.some((s) => s.text === step.text)) out.push(step); };

  // Something went wrong: the way forward is about that, before anything else.
  if (turn.some((it) => it.kind === 'note' && it.error)) add({ text: 'Try that again' });
  const failed = tools.filter((t) => t.name === 'Bash' && t.state === 'output-error');
  if (failed.length) add({ text: 'Fix the failing command' });

  // The reply ended on a question: answering it is the likeliest next message.
  const choices = choicesIn(reply);
  for (const c of choices) add(c);
  if (!choices.length && asksYesNo(reply)) add({ text: 'Yes, go ahead' });

  // A plan written in Plan mode is only words until something can edit.
  const planned = tools.some((t) => t.name === 'ExitPlanMode');
  const wrotePlan = /\bplan\b/i.test(reply) && /^\s*\d+[.)]\s/m.test(reply);
  if (planned || (mode === 'plan' && wrotePlan)) {
    add(mode === 'plan' ? { text: 'Implement this plan', mode: 'auto' } : { text: 'Implement this plan' });
  }

  const commands = tools.filter((t) => t.name === 'Bash').map((t) => String(t.input?.command || ''));
  if (tools.some((t) => EDITS.has(t.name) && t.state !== 'output-error')) {
    add({ text: 'Review the changes for bugs' });
    if (!commands.some((c) => TEST_CMD.test(c))) add({ text: 'Run the tests and fix what fails' });
    if (!commands.some((c) => COMMIT_CMD.test(c))) add({ text: 'Commit these changes' });
  }

  const url = LOCAL_URL.exec(reply)?.[0]
    || tools.map((t) => LOCAL_URL.exec(asText(t.output))?.[0]).find(Boolean);
  if (url) add({ text: `Open ${url.replace(/[.,;:]+$/, '')} in the preview and check it works` });

  return out.slice(0, MAX);
}
