'use strict';
const { TOOLS } = require('./tools');
const { READS } = require('./pane-lease');
const { BRIDGE_TOOL } = require('../shared/browser-tools');

// Matches bare browser_* names and mcp__(preview|conn)__browser_* only.
const CONN_BROWSER_MCP = /^(?:mcp__(?:preview|conn)__)?(browser_\w+)$/;

function browserTool(tool) {
  if (Object.hasOwn(TOOLS, tool)) return tool;
  const m = CONN_BROWSER_MCP.exec(tool);
  return (m && BRIDGE_TOOL.get(m[1])) || null;
}

// The four modes the composer offers. Plan, Ask, Auto, and Full bypass mean the
// same thing for Claude, ChatGPT, Cursor, Grok, and OpenCode: decide() below is
// the gate, and each CLI is only told the closest mode it already has. The ACP
// agents keep that in a `modes` table on their spec in providers/. The
// renderer keeps these ids and the labels in ui/components/composer.jsx.
//
// Debug, Accept edits, and Ask confirmation always used to be separate. They
// could not be honored the same way by every CLI, so a saved copy of one of
// them is read as the mode below that still matches it.

// What each mode asks the SDK for. Anything not listed here is not a mode.
const SDK_MODE = {
  plan: 'plan',                    // the SDK stops every write itself
  ask: 'default',
  auto: 'acceptEdits',             // edits pass, shell is filtered below
  bypass: 'bypassPermissions',
};

/* The same four modes, said in codex's vocabulary. It splits the question in
   two where the SDK asks it once: `sandbox` is what a command may touch, and
   `approvalPolicy` is whether anyone gets asked first.

   Every mode but bypass asks on-request, because the answering happens here.
   decide() below is what waves a call through, exactly as it does for claude,
   and it cannot judge a command codex never mentioned. */
const CODEX_MODE = {
  plan: { sandbox: 'read-only', approvalPolicy: 'on-request' },
  ask: { sandbox: 'workspace-write', approvalPolicy: 'on-request' },
  auto: { sandbox: 'workspace-write', approvalPolicy: 'on-request' },
  bypass: { sandbox: 'danger-full-access', approvalPolicy: 'never' },
};

const isMode = (m) => Object.hasOwn(SDK_MODE, m);
const MODES = Object.keys(SDK_MODE);
const DEFAULT_MODE = 'ask';

// An agent's table says what every mode means for that agent and names nothing
// that is not a mode, or the agent refuses to load.
function everyMode(agent, table) {
  const missing = MODES.filter((m) => !Object.hasOwn(table, m));
  const extra = Object.keys(table).filter((m) => !isMode(m));
  if (missing.length || extra.length) {
    throw new Error(`${agent} modes: missing [${missing}], unknown [${extra}]`);
  }
  return Object.freeze(table);
}

// Old picker values, folded into the four that every agent can keep.
const RETIRED = {
  debug: 'ask',
  acceptEdits: 'auto',
  always: 'ask',
};

function normalizeMode(m) {
  if (isMode(m)) return m;
  if (Object.hasOwn(RETIRED, m)) return RETIRED[m];
  return DEFAULT_MODE;
}

// Tools that only read. Every mode lets these through.
const READ_ONLY = new Set(['Read', 'Glob', 'Grep', 'NotebookRead', 'TodoWrite', 'WebFetch', 'WebSearch']);

// File writes. Auto runs these. Plan refuses them. Ask waits for a card.
const WRITES = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

// Shell that can lose work, reach outside the project, or be seen by someone
// else. Auto mode runs everything else without asking and stops on these.
// A regex list can never name every dangerous command, so this does not try:
// it is a convenience that catches the common ones, not a sandbox. Whoever
// needs a real boundary around what a command can touch should run under an
// OS-level sandbox instead.
const RISKY = [
  [/(^|[\s;&|(])sudo\s/, 'runs as root'],
  [/(^|[\s;&|(])rm\s[^|;&]*-[a-z]*[rf]/, 'deletes recursively or by force'],
  [/(^|[\s;&|(])(shutdown|reboot|halt|mkfs\S*|fdisk)\b/, 'acts on the machine itself'],
  [/(^|[\s;&|(])dd\s[^|;&]*of=/, 'writes a raw device'],
  [/(^|[\s;&|(])(chown|chmod)\s[^|;&]*\s\//, 'changes permissions outside the project'],
  [/\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f|filter-branch)/, 'publishes or rewrites git history'],
  [/\b(npm|pnpm|yarn|bun)\s+(publish|unpublish)/, 'publishes a package'],
  [/\b(npm|pnpm|yarn|bun)\s[^|;&]*\s(-g|--global)\b/, 'installs globally'],
  [/\b(curl|wget)\b[^|;&]*\|\s*(ba|z|fi)?sh/, 'pipes a download straight into a shell'],
  [/\bdocker\s+(system\s+prune|rm\b|rmi\b|volume\s+rm)/, 'removes containers, images or volumes'],
  [/\bkubectl\s+delete\b/, 'deletes cluster resources'],
  [/\bdrop\s+(table|database|schema)\b/i, 'drops a database object'],
  [/(^|[\s;&|(])>{1,2}\s*\/(dev|etc|usr|bin|boot|var)\//, 'writes outside the project'],
  [/\bfind\s[^|;&]*-delete\b/, 'deletes every file it finds'],
  [/(^|[\s;&|(])shred\s/, 'destroys a file beyond recovery'],
  [/\btruncate\s[^|;&]*-s\s*0\b/, 'empties a file in place'],
];

// The reason to stop, or null when the command reads as ordinary work.
function riskOf(command) {
  for (const [re, why] of RISKY) if (re.test(command)) return why;
  return null;
}

const ALLOW = { action: 'allow' };
const ask = (reason) => ({ action: 'ask', reason });
const deny = (reason) => ({ action: 'deny', reason });

/**
 * Whether a tool call runs, waits for a card, or is refused.
 * The same answer for every agent. Claude's SDK still swallows some of these
 * before they arrive (plan refuses a write, bypass never asks), so the callers
 * that do not have that layer, Codex and the ACP CLIs, rely on this entirely.
 */
function decide(mode, tool, input) {
  // The agent asking the human something is the one call no mode may answer on
  // their behalf. Full bypass is the exception the SDK makes for us: it never
  // calls canUseTool at all, so the question resolves unanswered.
  if (tool === 'AskUserQuestion') return ask();

  const browser = browserTool(tool);
  const looking = browser && READS.has(browser);
  if (looking || READ_ONLY.has(tool)) return ALLOW;

  if (mode === 'bypass') return ALLOW;

  if (mode === 'plan') {
    if (tool === 'ExitPlanMode') return ask();
    return deny(browser ? 'plan mode only looks at the page' : 'plan mode only reads');
  }

  if (mode === 'auto') {
    if (browser) return ALLOW;
    if (WRITES.has(tool)) return ALLOW;
    if (tool === 'Bash') {
      const why = riskOf(String(input?.command || ''));
      return why ? ask(why) : ALLOW;
    }
  }

  return ask();
}

// Codex has no SDK layer in front of this, so it uses the same decision.
function decideCodex(mode, tool, input) {
  return decide(mode, tool, input);
}

module.exports = {
  SDK_MODE, CODEX_MODE, DEFAULT_MODE, MODES, isMode, everyMode, normalizeMode, decide, decideCodex, riskOf, READ_ONLY,
  browserTool,
};
