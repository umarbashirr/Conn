'use strict';
/* A Cursor, Grok, OpenCode or Copilot chat saved by an earlier Conn opens on
   what the person typed, not on the browser preface that Conn sent ahead of
   it, and lists under that message rather than under the preface. The two
   prefaces below are the exact texts every release up to 4ec715b sent; the
   current one changes with INSTRUCTIONS. Plain node, with the stand-in ACP
   agent for the listing. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const shellEnv = require(path.join(ROOT, 'src/main/shell-env.js'));
shellEnv.ready = async () => process.env.PATH || '';
shellEnv.env = () => ({ ...process.env });
shellEnv.cached = () => process.env.PATH || '';
const { createAcpHistory, foldUpdates } = require(path.join(ROOT, 'src/main/providers/acp-history.js'));
const { ACP_INSTRUCTIONS } = require(path.join(ROOT, 'src/main/providers/acp-session.js'));

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
};

const TABS = 'You are working next to a live preview browser. It is a real Chromium view the human can see. Use browser_navigate to load a URL (bare ports work: "3000" becomes http://localhost:3000). Call browser_show when you want the human to see the pane; it starts hidden and the page keeps working while closed. Call browser_snapshot to perceive the page: it returns [ref=eN] handles that browser_click, browser_fill and browser_hover accept. Refs are dropped on navigation, so snapshot again after loading a page. After any action that should have changed something, check browser_console and browser_network before concluding it worked. The pane has tabs. browser_tabs lists this chat\'s tabs, which one you are driving and which one the human is looking at. The tab you start on may hold the person\'s own app, so open another with browser_tab_new for anything unrelated, such as documentation or research, rather than navigating away from it. browser_tab_select changes which tab your other browser tools act on. A subagent\'s first browser_navigate opens a tab of its own. These browser_* tools from the conn MCP server drive the preview pane inside this app, which is the browser the human is looking at. Use them for anything to do with a page. Any other browser tool or skill you have drives a different window that nobody can see.';
const FIRST = 'You are working next to a live preview browser. It is a real Chromium view the human can see. Use browser_navigate to load a URL (bare ports work: "3000" becomes http://localhost:3000). Call browser_show when you want the human to see the pane; it starts hidden and the page keeps working while closed. Call browser_snapshot to perceive the page: it returns [ref=eN] handles that browser_click, browser_fill and browser_hover accept. Refs are dropped on navigation, so snapshot again after loading a page. After any action that should have changed something, check browser_console and browser_network before concluding it worked. These browser_* tools from the conn MCP server drive the preview pane inside this app, which is the browser the human is looking at. Use them for anything to do with a page. Any other browser tool or skill you have drives a different window that nobody can see.';

const typed = 'make the button red';
const user = (t) => ({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: t } });
const agent = (t) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } });

for (const [name, preface] of [['current', ACP_INSTRUCTIONS], ['tabs-era', TABS], ['first', FIRST]]) {
  const whole = `${preface}\n\n${typed}`;
  const out = foldUpdates([user(whole.slice(0, 64)), user(whole.slice(64)), agent('ok')]);
  const shown = out[0]?.message.content[0].text;
  check(`${name}-preface-is-stripped-from-the-first-message`, shown === typed, JSON.stringify(String(shown).slice(0, 80)));
}

async function titles(name, title) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-old-preface-'));
  const titleFile = path.join(dir, 'title');
  const bin = path.join(dir, 'agent');
  fs.writeFileSync(titleFile, title);
  fs.writeFileSync(bin, [
    '#!/bin/sh',
    `export MOCK_ACP_STORE=copilot MOCK_ACP_PREFACE_TITLES=1 MOCK_ACP_TITLE_FILE=${JSON.stringify(titleFile)}`,
    `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(ROOT, 'scripts/mock-acp-cli.js'))} "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  const history = createAcpHistory({ spec: { binary: () => bin }, label: 'Copilot' });
  try {
    const rows = await history.listSessions(dir);
    check(`${name}-lists-under-the-first-message`, rows.length === 2 && rows.every((r) => r.title === typed), JSON.stringify(rows.map((r) => r.title.slice(0, 60))));
  } finally {
    history.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  for (const [name, preface] of [['tabs-era', TABS], ['first', FIRST]]) {
    await titles(`${name}-sliced-title`, `${preface}\n\n${typed}`.slice(0, 500) + '...');
    await titles(`${name}-whole-title`, `${preface}\n\n${typed}`);
  }
  console.log(failures.length ? `\n${failures.length} FAIL(s): ${failures.join(', ')}` : '\np2-acp-old-preface-repro: all passed');
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
