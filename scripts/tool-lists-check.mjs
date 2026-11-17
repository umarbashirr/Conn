/* Which batch steps Conn refuses for the tool lists skills, commands and
   agents declare, under plain node. Each case says which of four conn tools
   the claude CLI was seen to leave the caller: an agent as the subagent it
   spawns, a skill or command as the main thread once the Skill tool has
   run it. A step is refused when the caller keeps the batch and not the
   step's tool. `--cli` checks every case against the claude on PATH,
   against the stand-in Messages API in .claude/skills/verify, by reading the
   tools each request offers. Linux only. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const CLI = process.argv.includes('--cli');
const J = JSON.stringify;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-tool-lists-'));
const { toolLists } = require('../src/main/permission-rules.js');
const { reply } = await import(pathToFileURL(path.join(ROOT, '.claude/skills/verify/claude-api.mjs')).href);

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail !== undefined ? `: ${detail}` : ''}`);
  if (!ok) failures.push(name);
};
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof text === 'string' ? text : J(text));
};

// Each tool by its letter.
const TOOLS = { b: 'batch', c: 'click', e: 'evaluate', f: 'fill' };
const full = (l) => `mcp__conn__browser_${TOOLS[l]}`;
const STEPS = 'cef';
// What a caller left `kept` may not batch.
const refused = (kept) => (kept.includes('b') ? [...STEPS].filter((l) => !kept.includes(l)).join('') : '');

const PLUGIN = 'pl';
function layout(name) {
  const dir = path.join(tmp, name);
  const t = { home: path.join(dir, 'home'), config: path.join(dir, 'config'), project: path.join(dir, 'up', 'project') };
  for (const d of Object.values(t)) fs.mkdirSync(d, { recursive: true });
  t.plugin = path.join(t.home, 'mkf', PLUGIN);
  write(path.join(t.plugin, '.claude-plugin', 'plugin.json'), { name: PLUGIN, version: '1.0.0' });
  write(path.join(t.home, 'mkf', '.claude-plugin', 'marketplace.json'), { name: 'mkf', owner: { name: 'conn' }, plugins: [{ name: PLUGIN, source: `./${PLUGIN}`, version: '1.0.0' }] });
  write(path.join(t.config, 'plugins', 'known_marketplaces.json'), { mkf: { source: { source: 'directory', path: path.join(t.home, 'mkf') }, installLocation: path.join(t.home, 'mkf'), lastUpdated: '2026-01-01T00:00:00.000Z' } });
  write(path.join(t.config, 'settings.json'), { enabledPlugins: { [`${PLUGIN}@mkf`]: true } });
  // A project's agents load only from a folder the person has trusted.
  write(path.join(t.config, '.claude.json'), { projects: Object.fromEntries([t.project, path.dirname(t.project)].map((d) => [d, { hasTrustDialogAccepted: true }])) });
  return t;
}
const WHERE = {
  project: (t, f) => path.join(t.project, '.claude', f),
  parent: (t, f) => path.join(t.project, '..', '.claude', f),
  user: (t, f) => path.join(t.config, f),
  plugin: (t, f) => path.join(t.plugin, f),
};
const declare = (file, name, lines) => write(file, `---\nname: ${name}\ndescription: Drives the browser for tool-lists-check.\n${lines.join('\n')}\n---\nDo as asked.\n`);

function listsIn(t, binds) {
  process.env.HOME = t.home;
  process.env.CLAUDE_CONFIG_DIR = t.config;
  const lists = toolLists(t.project, binds);
  return [...STEPS].filter((l) => lists(full(l))).join('');
}

/* What the CLI offered each request, by the end of the text of its first
   message, which for a subagent is the prompt it was given. */
async function offered(t, prompt) {
  const server = path.join(t.home, 'tools.cjs');
  fs.writeFileSync(server, `const { McpServer } = require(${J(require.resolve('@modelcontextprotocol/sdk/server/mcp.js'))});
const { StdioServerTransport } = require(${J(require.resolve('@modelcontextprotocol/sdk/server/stdio.js'))});
const s = new McpServer({ name: 'conn', version: '0' });
for (const name of ${J(Object.values(TOOLS).map((n) => `browser_${n}`))}) s.registerTool(name, { description: name }, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
s.connect(new StdioServerTransport());`);
  write(path.join(t.home, 'mcp.json'), { mcpServers: { conn: { command: process.execPath, args: [server] } } });
  const seen = [];
  let n = 0;
  const api = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw); } catch {}
      if (!/^\/v1\/messages(\?|$)/.test(req.url)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(/count_tokens/.test(req.url) ? J({ input_tokens: 10 }) : '{}');
      }
      const first = body?.messages?.[0]?.content;
      const text = typeof first === 'string' ? first : (first || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const names = new Set((body?.tools || []).map((x) => x.name));
      if (body?.tools?.length) seen.push({ text, kept: Object.keys(TOOLS).filter((l) => names.has(full(l))).join('') });
      const step = reply(body, t.project);
      n += 1;
      const ev = (type, data) => `event: ${type}\ndata: ${J({ type, ...data })}\n\n`;
      const block = step.tool ? { type: 'tool_use', id: `toolu_lists_${n}`, name: step.tool, input: {} } : { type: 'text', text: '' };
      const delta = step.tool ? { type: 'input_json_delta', partial_json: J(step.input) } : { type: 'text_delta', text: step.text };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end([
        ev('message_start', { message: { id: `msg_lists_${n}`, type: 'message', role: 'assistant', model: body?.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }),
        ev('content_block_start', { index: 0, content_block: block }),
        ev('content_block_delta', { index: 0, delta }),
        ev('content_block_stop', { index: 0 }),
        ev('message_delta', { delta: { stop_reason: step.tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }),
        ev('message_stop', {}),
      ].join(''));
    });
  });
  await new Promise((ok) => api.listen(0, '127.0.0.1', ok));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC)/.test(k)));
  // Tool search would hold MCP tools back from the list a request offers.
  Object.assign(env, {
    HOME: t.home, CLAUDE_CONFIG_DIR: t.config, ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.address().port}`,
    ANTHROPIC_API_KEY: 'sk-ant-conn-verify', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ENABLE_TOOL_SEARCH: 'false',
  });
  const said = await new Promise((done) => {
    const c = spawn('claude', ['-p', `${prompt}\nsay: ran`, '--mcp-config', path.join(t.home, 'mcp.json'), '--strict-mcp-config', '--dangerously-skip-permissions'], { cwd: t.project, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    c.on('exit', () => done(out.trim()));
  });
  api.close();
  if (!/^ran$/m.test(said)) throw new Error(`claude did not finish: ${said}`);
  return seen;
}

/* Agents, all in one layout: [label, where, file, frontmatter lines, what
   the CLI leaves it, the name it goes by]. A plugin's agent goes by its
   plugin's name and its own. Two agents of one name are the project's. */
const EVALUATE = ['disallowedTools: mcp__conn__browser_evaluate'];
const AGENTS = [
  ['none', 'project', 'agents/none.md', [], 'bcef'],
  ['tools-comma', 'project', 'agents/tools-comma.md', ['tools: mcp__conn__browser_batch, mcp__conn__browser_click'], 'bc'],
  ['tools-space', 'project', 'agents/tools-space.md', ['tools: mcp__conn__browser_batch mcp__conn__browser_click'], 'bc'],
  ['tools-yaml', 'project', 'agents/tools-yaml.md', ['tools:', '  - mcp__conn__browser_batch', '  - mcp__conn__browser_click'], 'bc'],
  ['tools-flow', 'project', 'agents/tools-flow.md', ['tools: [mcp__conn__browser_batch, mcp__conn__browser_click]'], 'bc'],
  ['tools-server', 'project', 'agents/tools-server.md', ['tools: mcp__conn'], 'bcef'],
  ['tools-server-star', 'project', 'agents/tools-server-star.md', ['tools: mcp__conn__*'], 'bcef'],
  ['tools-star', 'project', 'agents/tools-star.md', ['tools: "*"'], 'bcef'],
  ['tools-paren', 'project', 'agents/tools-paren.md', ['tools: mcp__conn__browser_batch(x), mcp__conn__browser_click'], 'bc'],
  ['tools-case', 'project', 'agents/tools-case.md', ['tools: MCP__CONN__BROWSER_BATCH, mcp__conn__browser_click'], 'c'],
  ['tools-builtin', 'project', 'agents/tools-builtin.md', ['tools: Read, Grep'], ''],
  ['disallowed', 'project', 'agents/disallowed.md', EVALUATE, 'bcf'],
  ['disallowed-yaml', 'project', 'agents/disallowed-yaml.md', ['disallowedTools:', '  - mcp__conn__browser_evaluate', '  - mcp__conn__browser_fill'], 'bc'],
  ['disallowed-comma', 'project', 'agents/disallowed-comma.md', ['disallowedTools: mcp__conn__browser_evaluate, mcp__conn__browser_fill'], 'bc'],
  ['disallowed-hyphen', 'project', 'agents/disallowed-hyphen.md', ['disallowed-tools: mcp__conn__browser_evaluate'], 'bcef'],
  ['disallowed-paren', 'project', 'agents/disallowed-paren.md', ['disallowedTools: mcp__conn__browser_evaluate(x)'], 'bcf'],
  ['disallowed-server', 'project', 'agents/disallowed-server.md', ['disallowedTools: mcp__conn'], ''],
  ['disallowed-server-star', 'project', 'agents/disallowed-server-star.md', ['disallowedTools: mcp__conn__*'], ''],
  ['disallowed-mcp', 'project', 'agents/disallowed-mcp.md', ['disallowedTools: mcp__*'], ''],
  ['disallowed-case', 'project', 'agents/disallowed-case.md', ['disallowedTools: MCP__CONN__BROWSER_EVALUATE'], 'bcef'],
  ['disallowed-wildcard', 'project', 'agents/disallowed-wildcard.md', ['disallowedTools: mcp__conn__browser_e*'], 'bcef'],
  ['disallowed-batch', 'project', 'agents/disallowed-batch.md', ['disallowedTools: mcp__conn__browser_batch'], 'cef'],
  ['both', 'project', 'agents/both.md', ['tools: mcp__conn__browser_batch, mcp__conn__browser_evaluate', ...EVALUATE], 'b'],
  ['nested', 'project', 'agents/team/nested.md', EVALUATE, 'bcf'],
  ['parent', 'parent', 'agents/parent.md', EVALUATE, 'bcf'],
  ['user', 'user', 'agents/user.md', EVALUATE, 'bcf'],
  ['plugin', 'plugin', 'agents/plugin.md', EVALUATE, 'bcf', `${PLUGIN}:plugin`],
  ['renamed', 'project', 'agents/file-name.md', EVALUATE, 'bcf'],
  ['twice', 'project', 'agents/twice.md', EVALUATE, 'bcf'],
  ['twice-user', 'user', 'agents/twice.md', ['disallowedTools: mcp__conn__browser_fill'], 'bcf', 'twice'],
  ['twice-up', 'project', 'agents/twice-up.md', EVALUATE, 'bcf'],
  ['twice-up-parent', 'parent', 'agents/twice-up.md', ['disallowedTools: mcp__conn__browser_fill'], 'bcf', 'twice-up'],
];
{
  const t = layout('agents');
  const nameOf = ([label, where, , , , name = label]) => (where === 'plugin' ? name.split(':')[1] : name);
  for (const a of AGENTS) declare(WHERE[a[1]](t, a[2]), nameOf(a), a[3]);
  const seen = CLI ? await offered(t, AGENTS.map(([label, , , , , name = label]) => `tool Agent ${J({ subagent_type: name, description: label, prompt: `agent ${label}\nsay: done`, run_in_background: false })}`).join('\n')) : null;
  for (const [label, , , , kept, name = label] of AGENTS) {
    const got = listsIn(t, (n) => n === name);
    check(`agent ${label} may not batch ${J(refused(kept))}`, got === refused(kept), J(got));
    if (seen) {
      const cli = seen.find((s) => s.text.endsWith(`agent ${label}\nsay: done`))?.kept ?? '';
      check(`claude leaves agent ${label} ${J(kept)}`, cli === kept, J(cli));
    }
  }
  // Through the bridge the caller could be any agent.
  const shadowed = new Set(['twice-user', 'twice-up-parent']);
  const any = [...new Set(AGENTS.filter(([label]) => !shadowed.has(label)).flatMap(([, , , , kept]) => [...refused(kept)]))].sort().join('');
  const got = listsIn(t, () => true);
  check(`any agent may not batch ${J(any)}`, got === any, J(got));
  check('the main thread is bound by no agent', listsIn(t, () => false) === '', listsIn(t, () => false));
}

/* Skills and commands, each in a layout of its own, since every skill binds
   every caller: [label, where, file, frontmatter lines, what the CLI leaves
   the main thread once the Skill tool runs it, the name it goes by]. */
const SKILL = ['disallowed-tools: mcp__conn__browser_evaluate'];
const SKILLS = [
  ['skill', 'project', 'skills/skill/SKILL.md', SKILL, 'bcf'],
  ['skill-camel', 'project', 'skills/skill-camel/SKILL.md', ['disallowedTools: mcp__conn__browser_evaluate'], 'bcf'],
  ['skill-yaml', 'project', 'skills/skill-yaml/SKILL.md', ['disallowed-tools:', '  - mcp__conn__browser_evaluate', '  - mcp__conn__browser_fill'], 'bc'],
  ['skill-space', 'project', 'skills/skill-space/SKILL.md', ['disallowed-tools: mcp__conn__browser_evaluate mcp__conn__browser_fill'], 'bc'],
  ['skill-server', 'project', 'skills/skill-server/SKILL.md', ['disallowed-tools: mcp__conn'], ''],
  ['skill-mcp', 'project', 'skills/skill-mcp/SKILL.md', ['disallowed-tools: mcp__*'], ''],
  ['skill-paren', 'project', 'skills/skill-paren/SKILL.md', ['disallowed-tools: mcp__conn__browser_evaluate(x)'], 'bcef'],
  ['skill-case', 'project', 'skills/skill-case/SKILL.md', ['disallowed-tools: MCP__CONN__BROWSER_EVALUATE'], 'bcef'],
  ['skill-allowed', 'project', 'skills/skill-allowed/SKILL.md', ['allowed-tools: mcp__conn__browser_click'], 'bcef'],
  ['skill-batch', 'project', 'skills/skill-batch/SKILL.md', ['disallowed-tools: mcp__conn__browser_batch'], 'cef'],
  ['command', 'project', 'commands/command.md', SKILL, 'bcf'],
  ['parent-skill', 'parent', 'skills/parent-skill/SKILL.md', SKILL, 'bcf'],
  ['user-skill', 'user', 'skills/user-skill/SKILL.md', SKILL, 'bcf'],
  ['plugin-skill', 'plugin', 'skills/plugin-skill/SKILL.md', SKILL, 'bcf', `${PLUGIN}:plugin-skill`],
  ['plugin-command', 'plugin', 'commands/plugin-command.md', SKILL, 'bcf', `${PLUGIN}:plugin-command`],
];
for (const [label, where, file, lines, kept, name = label] of SKILLS) {
  const t = layout(label);
  declare(WHERE[where](t, file), label, lines);
  const got = listsIn(t, () => false);
  check(`skill ${label} may not batch ${J(refused(kept))}`, got === refused(kept), J(got));
  if (CLI) {
    const seen = await offered(t, `tool Skill ${J({ skill: name })}\ntool mcp__conn__browser_click {}`);
    const cli = seen[1]?.kept ?? '';
    check(`claude leaves the main thread ${J(kept)} after skill ${label}`, seen[0]?.kept === 'bcef' && cli === kept, J(seen.map((s) => s.kept)));
  }
}

{
  // Rewritten where it stands, as an editor saving in place does.
  const t = layout('in-place');
  const file = WHERE.project(t, 'agents/late.md');
  declare(file, 'late', []);
  check('an agent with no list binds nothing', listsIn(t, () => true) === '');
  declare(file, 'late', EVALUATE);
  check('a list added to an agent in place is seen by the next batch', listsIn(t, () => true) === 'e');
}

fs.rmSync(tmp, { recursive: true, force: true });
if (failures.length) {
  console.log(`\n${failures.length} FAIL(s): ${failures.join(', ')}`);
  process.exit(1);
}
console.log(`\ntool-lists-check${CLI ? ' --cli' : ''}: all passed`);
