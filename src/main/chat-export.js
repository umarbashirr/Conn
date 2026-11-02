'use strict';

const fs = require('fs');
const path = require('path');
const { plainText } = require('../shared/attachments');
const { toolLabel, toolName, toolSummary } = require('../shared/tool-summary');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const squash = (t) => String(t).replace(/\s+/g, ' ').trim();
const strip = (t) => t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();

function textOf(content) {
  if (typeof content === 'string') return strip(content);
  if (!Array.isArray(content)) return '';
  return strip(content.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n'));
}

const OPEN = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})(?=\s|$)/;

function nestMessage(text) {
  let open = null;
  const lines = text.split('\n').map((line) => {
    if (open) {
      const close = OPEN.exec(line);
      if (close && close[1][0] === open[0] && close[1].length >= open.length && !line.slice(close[0].length).trim()) open = null;
      return line;
    }
    const fence = OPEN.exec(line);
    if (fence) {
      open = fence[1];
      return line;
    }
    const heading = HEADING.exec(line);
    return heading ? `${'#'.repeat(Math.min(6, heading[1].length + 2))}${line.slice(heading[0].length)}` : line;
  });
  if (open) lines.push(open);
  return lines.join('\n');
}

const TICK = { completed: 'x', in_progress: ' ', pending: ' ' };
const todoLine = (t) => `- [${TICK[t.status] || ' '}] ${t.content}${t.status === 'in_progress' ? ' (in progress)' : ''}`;

const toolLine = (b, failed) => {
  const summary = toolSummary(toolLabel(b.name), b.input).replace(/`/g, "'");
  return `- ${toolName(toolLabel(b.name))}${summary ? ` \`${summary}\`` : ''}${failed ? ' (failed)' : ''}`;
};

function lastTodoPerTurn(messages) {
  const last = new Map();
  let turn = 0;
  for (const m of messages) {
    if (m.type === 'user' && textOf(m.message?.content)) turn += 1;
    if (m.type !== 'assistant' || !Array.isArray(m.message?.content)) continue;
    for (const b of m.message.content) if (b.type === 'tool_use' && b.name === 'TodoWrite') last.set(turn, b.id);
  }
  return new Set(last.values());
}

function toMarkdown({ title, project, messages, now = new Date() }) {
  const failed = new Set();
  for (const m of messages) {
    if (!Array.isArray(m.message?.content)) continue;
    for (const b of m.message.content) if (b.type === 'tool_result' && b.is_error) failed.add(b.tool_use_id);
  }
  const todos = lastTodoPerTurn(messages);

  const out = [`# ${title || 'Conversation'}`, `Exported from Conn on ${now.toISOString().slice(0, 10)}${project ? ` · ${path.basename(project)}` : ''}`];
  let speaker = null;
  let calls = false;
  const say = (who, ...parts) => {
    if (who !== speaker || who === 'You') out.push(`## ${who}`);
    speaker = who;
    calls = false;
    out.push(...parts);
  };

  for (const m of messages) {
    const content = m.message?.content;
    if (m.type === 'user') {
      const said = plainText(textOf(content));
      if (said) say('You', nestMessage(said));
      continue;
    }
    if (m.type !== 'assistant') continue;
    for (const b of Array.isArray(content) ? content : [{ type: 'text', text: content }]) {
      if (b.type === 'text' && b.text?.trim()) say('Assistant', nestMessage(b.text.trim()));
      if (b.type !== 'tool_use') continue;
      if (b.name === 'ExitPlanMode' && typeof b.input?.plan === 'string' && b.input.plan.trim()) {
        say('Assistant', '**Proposed plan**', nestMessage(b.input.plan.trim()));
      } else if (b.name === 'TodoWrite' && Array.isArray(b.input?.todos)) {
        if (todos.has(b.id)) say('Assistant', '**Checklist**', b.input.todos.filter((t) => typeof t?.content === 'string').map(todoLine).join('\n'));
      } else if (calls) {
        out[out.length - 1] += `\n${toolLine(b, failed.has(b.id))}`;
      } else {
        say('Assistant', toolLine(b, failed.has(b.id)));
        calls = true;
      }
    }
  }
  return `${out.join('\n\n')}\n`;
}

const fileNameFor = (title) => {
  const slug = String(title || '').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').replace(/^\.+|\.+$/g, '').slice(0, 60);
  return `${slug || 'conversation'}.md`;
};

const TAIL = 120;
const CLIPPED = '\n… truncated';
const COMMAND = /^\/[A-Za-z0-9][\w:.-]*(\s|$)/;

// Only claude's reader drops a slash-command prompt, so only there is it never
// coming. Codex and ACP keep "/tmp is full" as text like any other prompt.
function wanted(lastText, dropsCommands) {
  if (!lastText || (dropsCommands && COMMAND.test(lastText))) return '';
  const cut = lastText.indexOf(CLIPPED);
  return cut < 0 ? squash(lastText).slice(-TAIL) : squash(lastText.slice(0, cut)).slice(0, TAIL);
}

function landed(messages, want) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].error) continue;
    const said = squash(textOf(messages[i].message?.content));
    if (said) return said.includes(want);
  }
  return false;
}

async function readLanded({ read, want, landsWithin, every }) {
  const until = Date.now() + landsWithin;
  let { messages } = await read();
  while (want && !landed(messages, want) && Date.now() < until) {
    await sleep(every);
    ({ messages } = await read());
  }
  return messages;
}

async function exportChat({ title, project, lastText, dropsCommands = false, read, pick, landsWithin = 3000, every = 250 }) {
  const file = await pick(fileNameFor(title));
  if (!file) return { canceled: true };

  const want = wanted(lastText, dropsCommands);
  const messages = await readLanded({ read, want, landsWithin, every });
  await fs.promises.writeFile(file, toMarkdown({ title, project, messages }));
  return want && !landed(messages, want) ? { path: file, incomplete: true } : { path: file };
}

module.exports = { exportChat, toMarkdown, fileNameFor };
