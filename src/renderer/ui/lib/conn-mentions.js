// The parts of Conn a message can name with a $, and what each one tells the
// agent. Every agent Conn runs has products of its own with the same names
// (Cursor has a browser and a canvas, Claude has Chrome and artifacts), so a
// bare "the browser" gets read as theirs. $browser is unambiguous, and the
// block it brings along says which tools and files mean Conn's.
//
// One row per mention. The picker, the tokenizer and the send all read this
// table, so a new one is a row here and nothing else.
import { TOOL_PREFIX } from '../../../shared/browser-tools';
import { designBrief } from '../shell/canvas-schema.js';

function browserBlock({ provider }) {
  const prefix = TOOL_PREFIX[provider] ?? '';
  const tool = (name) => `${prefix}browser_${name}`;
  const source = prefix ? `the ${prefix}browser_* tools` : "the browser_* tools from Conn's conn MCP server";
  return [
    '[conn browser] $browser',
    '  "Browser" here means the Browser pane in Conn, the app this chat runs in. It is a live Chromium view beside this chat, and the person is watching it. It is not your own product\'s browser, Claude in Chrome or any other extension, Playwright, Puppeteer, or computer use.',
    `  Drive it only with ${source}. Open pages with ${tool('navigate')}, read them with ${tool('snapshot')}, act with ${tool('click')}, ${tool('fill')}, ${tool('type')} and ${tool('press')}, check ${tool('console')} and ${tool('network')}, and call ${tool('show')} to put the pane in front of the person.`,
  ].join('\n');
}

// `pane` is the app command that brings the part on screen when a message names it.
export const MENTIONS = {
  browser: { label: 'Browser', pane: 'preview', note: "Conn's Browser pane, driven by its browser_* tools", block: browserBlock },
  canvas: { label: 'Canvas', pane: 'canvas', note: "Conn's Canvas board, this chat's .conn/canvas/<board>/*.json", block: ({ slot, canvas }) => designBrief(slot, canvas) },
};

export const mentionRows = (query) => Object.entries(MENTIONS)
  .filter(([name]) => name.startsWith(query))
  .map(([name, m]) => ({ key: `conn:${name}`, kind: 'conn', raw: `$${name}`, name: `$${name}`, note: m.note, source: 'Conn' }));

// The blocks a message needs, in table order, once each. A block already in
// the text (a stopped turn parked back in the box, then sent again) is not
// added a second time.
export function mentionBlocks(names, text, ctx) {
  return Object.keys(MENTIONS)
    .filter((name) => names.has(name))
    .map((name) => MENTIONS[name].block(ctx))
    .filter((block) => !text.includes(block.split('\n')[0]));
}
