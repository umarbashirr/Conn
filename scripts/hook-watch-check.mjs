/* Which PreToolUse hooks Conn takes to watch a browser batch's steps, under
   plain node. Every expectation here is what the claude CLI was seen to do,
   and `--cli` checks them against the claude on PATH: it starts it once per
   layout, against the stand-in Messages API in .claude/skills/verify, with an
   MCP server named conn whose tools are the names below, and reads which
   hooks it ran. The administrator's settings are the exception. The CLI reads
   them from /etc/claude-code, and the cached server-managed settings only for
   an organisation's account, so `--cli` leaves them out, and what is
   expected of them is what the CLI's own code says. Plain node sends reads of
   /etc/claude-code to a temporary folder. Linux only. */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const CLI = process.argv.includes('--cli');
const J = JSON.stringify;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-hooks-'));

const POLICY = '/etc/claude-code';
let policy = null;
const moved = (p) => (typeof p === 'string' && policy && (p === POLICY || p.startsWith(`${POLICY}/`)) ? policy + p.slice(POLICY.length) : p);
for (const name of ['readFileSync', 'readdirSync']) {
  const real = fs[name];
  fs[name] = (p, ...rest) => real(moved(p), ...rest);
}
const { hookWatch } = require('../src/main/permission-rules.js');

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail !== undefined ? `: ${detail}` : ''}`);
  if (!ok) failures.push(name);
};
const write = (file, json) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, J(json));
};

const RAN = path.join(tmp, 'ran.txt');
fs.writeFileSync(path.join(tmp, 'hook.cjs'), `let s = '';
process.stdin.on('data', (d) => { s += d; }).on('end', () => require('fs').appendFileSync(${J(RAN)}, process.argv[2] + ' ' + JSON.parse(s).tool_name + '\\n'));`);
const hook = (label, matcher) => ({ ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: 'command', command: `node ${J(path.join(tmp, 'hook.cjs'))} ${label}` }] });

function layout(name) {
  const dir = path.join(tmp, name);
  const t = { home: path.join(dir, 'home'), config: path.join(dir, 'config'), project: path.join(dir, 'project'), policy: path.join(dir, 'etc') };
  for (const d of Object.values(t)) fs.mkdirSync(d, { recursive: true });
  return t;
}
function watchIn(t) {
  process.env.HOME = t.home;
  process.env.CLAUDE_CONFIG_DIR = t.config;
  policy = t.policy;
  return hookWatch(t.project);
}

/* What the CLI ran, keyed `<label> <tool>`. The stand-in API takes each step
   in order, by default a call of each tool, and every tool answers `ok`. */
const { serve } = CLI ? await import(pathToFileURL(path.join(ROOT, '.claude/skills/verify/claude-api.mjs')).href) : {};
async function cliRan(t, tools, steps = tools.map((x) => `tool ${x} {}`)) {
  const server = path.join(t.home, 'tools.cjs');
  fs.writeFileSync(server, `const { McpServer } = require(${J(require.resolve('@modelcontextprotocol/sdk/server/mcp.js'))});
const { StdioServerTransport } = require(${J(require.resolve('@modelcontextprotocol/sdk/server/stdio.js'))});
const s = new McpServer({ name: 'conn', version: '0' });
for (const name of ${J([...new Set(tools.map((x) => x.split('__')[2]))])}) s.registerTool(name, { description: name }, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
s.connect(new StdioServerTransport());`);
  const servers = Object.fromEntries([...new Set(tools.map((x) => x.split('__')[1]))].map((n) => [n, { command: process.execPath, args: [server] }]));
  write(path.join(t.home, 'mcp.json'), { mcpServers: servers });
  fs.rmSync(RAN, { force: true });
  const api = await serve({ project: t.project });
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC)/.test(k)));
  Object.assign(env, {
    HOME: t.home, CLAUDE_CONFIG_DIR: t.config, ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.port}`,
    ANTHROPIC_API_KEY: 'sk-ant-conn-verify', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  });
  const prompt = [...steps, 'say: ran'].join('\n');
  const said = await new Promise((done) => {
    const c = spawn('claude', ['-p', prompt, '--mcp-config', path.join(t.home, 'mcp.json'), '--strict-mcp-config', '--dangerously-skip-permissions'], { cwd: t.project, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    c.on('exit', () => done(out.trim()));
  });
  api.server.close();
  if (!/^ran$/m.test(said)) throw new Error(`claude did not finish its tools: ${said}`);
  return new Set((fs.existsSync(RAN) ? fs.readFileSync(RAN, 'utf8') : '').split('\n').filter(Boolean));
}

/* A matcher, and which of the two names the CLI ran it for: `c` the conn MCP
   server's evaluate, `p` the in-process server's. */
const TOOLS = { c: 'mcp__conn__browser_evaluate', p: 'mcp__preview__browser_evaluate' };
const MATCHERS = [
  [undefined, 'cp'], ['', 'cp'], ['*', 'cp'], ['.*', 'cp'],
  ['mcp__conn__browser_evaluate', 'c'], [' mcp__conn__browser_evaluate ', 'c'], ['mcp__conn__browser_evaluate|', 'c'],
  ['mcp__conn__browser_click|mcp__conn__browser_evaluate', 'c'], ['mcp__conn__browser_click, mcp__conn__browser_evaluate', 'c'],
  ['browser_evaluate', ''], ['evaluate', ''], ['conn', ''], ['mcp__conn', ''], ['mcp__conn__browser_eval', ''],
  ['mcp__conn__browser-evaluate', ''], ['MCP__CONN__BROWSER_EVALUATE', ''],
  ['Write', ''], ['Bash|PowerShell', ''], ['Read|Write|Edit|MultiEdit|NotebookEdit|Grep', ''],
  ['mcp__conn__.*', 'c'], ['mcp__conn__*', 'c'], ['browser_eval.*', 'cp'], ['^browser_evaluate$', ''],
  ['mcp__.*__browser_evaluate', 'cp'], ['mcp__(conn|preview)__browser_evaluate', 'cp'], ['mcp__conn__browser_evaluate$', 'c'],
  ['^mcp__conn__browser_evaluate', 'c'], ['mcp__conn__browser_evaluate\\b', 'c'], ['[', ''], ['(?i)MCP__CONN__BROWSER_EVALUATE', ''],
];
{
  const all = layout('matchers');
  write(path.join(all.config, 'settings.json'), { hooks: { PreToolUse: MATCHERS.map(([m], i) => hook(`m${i}`, m)) } });
  const ran = CLI ? await cliRan(all, Object.values(TOOLS)) : null;
  for (const [i, [matcher, want]] of MATCHERS.entries()) {
    const one = layout(`matcher-${i}`);
    write(path.join(one.config, 'settings.json'), { hooks: { PreToolUse: [hook(`m${i}`, matcher)] } });
    const watch = watchIn(one);
    const conn = Object.keys(TOOLS).filter((k) => watch(TOOLS[k])).join('');
    check(`matcher ${J(matcher ?? null)} watches ${J(want)}`, conn === want, J(conn));
    if (ran) {
      const cli = Object.keys(TOOLS).filter((k) => ran.has(`m${i} ${TOOLS[k]}`)).join('');
      check(`claude runs matcher ${J(matcher ?? null)} for ${J(want)}`, cli === want, J(cli));
    }
  }
}

/* Every place a hook can come from, each watching a tool named for it. */
const tool = (label) => `mcp__conn__browser_${label.replaceAll('-', '_')}`;
const hooksFor = (label) => ({ PreToolUse: [hook(label, tool(label))] });
const ADMIN = ['managed', 'drop-in', 'remote', 'managed-enables'];
const LABELS = [
  'home', 'user', 'project', 'local', ...ADMIN,
  'hooks-json', 'manifest-inline', 'manifest-path', 'bare-hooks-json', 'not-enabled', 'enabled-in-project', 'local-turns-off',
  'directory-folder', 'directory-cache',
];
const PLUGINS = ['hooks-json', 'manifest-inline', 'manifest-path', 'bare-hooks-json', 'not-enabled', 'enabled-in-project', 'local-turns-off', 'managed-enables'];

function everywhere(t, { user = {}, project = {}, local = {}, managed = {} } = {}) {
  const on = (...ids) => Object.fromEntries(ids.map((id) => [id, true]));
  write(path.join(t.home, '.claude', 'settings.json'), { hooks: hooksFor('home') });
  write(path.join(t.config, 'settings.json'), {
    hooks: hooksFor('user'),
    enabledPlugins: on('hooks-json@mkg', 'manifest-inline@mkg', 'manifest-path@mkg', 'bare-hooks-json@mkg', 'local-turns-off@mkg', 'directory@mkd'),
    ...user,
  });
  write(path.join(t.project, '.claude', 'settings.json'), { hooks: hooksFor('project'), enabledPlugins: on('enabled-in-project@mkg'), ...project });
  write(path.join(t.project, '.claude', 'settings.local.json'), { hooks: hooksFor('local'), enabledPlugins: { 'local-turns-off@mkg': false }, ...local });
  write(path.join(t.policy, 'managed-settings.json'), { hooks: hooksFor('managed'), enabledPlugins: on('managed-enables@mkg'), ...managed });
  write(path.join(t.policy, 'managed-settings.d', '10-browser.json'), { hooks: hooksFor('drop-in') });
  write(path.join(t.config, 'remote-settings.json'), { hooks: hooksFor('remote') });

  const plugins = path.join(t.config, 'plugins');
  const folder = path.join(t.home, 'mkd');
  const cached = (name, market) => path.join(plugins, 'cache', market, name, '1.0.0');
  write(path.join(plugins, 'known_marketplaces.json'), {
    mkg: { source: { source: 'github', repo: 'conn-check/mkg' }, installLocation: path.join(plugins, 'marketplaces', 'mkg'), lastUpdated: '2026-01-01T00:00:00.000Z' },
    mkd: { source: { source: 'directory', path: folder }, installLocation: folder, lastUpdated: '2026-01-01T00:00:00.000Z' },
  });
  const ids = [...PLUGINS.map((n) => [n, 'mkg']), ['directory', 'mkd']];
  write(path.join(plugins, 'installed_plugins.json'), {
    version: 2,
    plugins: Object.fromEntries(ids.map(([n, m]) => [`${n}@${m}`, [{ scope: 'user', installPath: cached(n, m), version: '1.0.0', installedAt: '2026-01-01T00:00:00.000Z', lastUpdated: '2026-01-01T00:00:00.000Z' }]])),
  });
  write(path.join(plugins, 'marketplaces', 'mkg', '.claude-plugin', 'marketplace.json'), { name: 'mkg', owner: { name: 'conn' }, plugins: PLUGINS.map((n) => ({ name: n, source: `./${n}`, version: '1.0.0' })) });
  for (const [n, m] of ids) {
    const root = cached(n, m);
    const manifest = { name: n, version: '1.0.0' };
    if (n === 'manifest-inline') manifest.hooks = hooksFor(n);
    if (n === 'manifest-path') {
      manifest.hooks = './more/hooks.json';
      write(path.join(root, 'more', 'hooks.json'), { hooks: hooksFor(n) });
    }
    write(path.join(root, '.claude-plugin', 'plugin.json'), manifest);
    if (n === 'bare-hooks-json') write(path.join(root, 'hooks', 'hooks.json'), hooksFor(n));
    else if (!n.startsWith('manifest-')) write(path.join(root, 'hooks', 'hooks.json'), { hooks: hooksFor(n === 'directory' ? 'directory-cache' : n) });
  }
  write(path.join(folder, '.claude-plugin', 'marketplace.json'), { name: 'mkd', owner: { name: 'conn' }, plugins: [{ name: 'directory', source: './directory', version: '1.0.0' }] });
  write(path.join(folder, 'directory', '.claude-plugin', 'plugin.json'), { name: 'directory', version: '1.0.0' });
  write(path.join(folder, 'directory', 'hooks', 'hooks.json'), { hooks: hooksFor('directory-folder') });
}

/* hooks/hooks.json holds its hooks under `hooks`: the CLI refuses to load a
   plugin whose file has them at the top. A plugin is loaded from a local
   marketplace's own folder rather than its cached copy. A later settings
   file's enabledPlugins and disableAllHooks win over an earlier one's. */
const ALL = ['user', 'project', 'local', ...ADMIN, 'hooks-json', 'manifest-inline', 'manifest-path', 'enabled-in-project', 'directory-folder'];
const LAYOUTS = [
  ['every-source', {}, ALL],
  ['user-disables', { user: { disableAllHooks: true } }, ADMIN],
  ['project-disables', { project: { disableAllHooks: true } }, ADMIN],
  ['local-disables', { local: { disableAllHooks: true } }, ADMIN],
  ['user-false-changes-nothing', { user: { disableAllHooks: false } }, ALL],
  ['local-undoes-user', { user: { disableAllHooks: true }, local: { disableAllHooks: false } }, ALL],
  ['project-overrides-user', { user: { disableAllHooks: false }, project: { disableAllHooks: true } }, ADMIN],
  ['managed-disables', { managed: { disableAllHooks: true } }, []],
  ['managed-only', { managed: { allowManagedHooksOnly: true } }, ADMIN],
];
for (const [name, extra, want] of LAYOUTS) {
  const t = layout(name);
  everywhere(t, extra);
  const watch = watchIn(t);
  const got = LABELS.filter((l) => watch(tool(l)));
  check(`${name} watches ${want.join(', ') || 'nothing'}`, J(got) === J(want), J(got));
  if (CLI && !extra.managed) {
    const ran = await cliRan(t, LABELS.map(tool));
    const cli = LABELS.filter((l) => ran.has(`${l} ${tool(l)}`));
    const runs = want.filter((l) => !ADMIN.includes(l));
    check(`claude in ${name} runs ${runs.join(', ') || 'nothing'}`, J(cli) === J(runs), J(cli));
  }
}

{
  const t = layout('sources');
  everywhere(t);
  const watch = watchIn(t);
  check('a settings hook is named by its file', watch(tool('user')) === path.join(t.config, 'settings.json'), watch(tool('user')));
  check('a plugin hook is named by its plugin', watch(tool('hooks-json')) === 'plugin hooks-json@mkg', watch(tool('hooks-json')));
}

/* Skills, commands and agents declare hooks in their frontmatter, which the
   CLI runs while that skill or agent is at work. Conn cannot tell when that
   is, so each counts as always on, and `--cli` puts each to work before the
   call its hook watches: a skill or command through the Skill tool, an agent
   as the subagent that makes the call. Each is [label, file, kind, the name
   the CLI knows it by]. A plugin's agents and commands, and a skill shelved
   one folder deeper, are ones the CLI was seen to run no hooks for. */
const PLUGIN = 'declares';
const pluginRoot = (t) => path.join(t.home, 'mkf', PLUGIN);
const DECLARED = [
  ['project-skill', (t) => path.join(t.project, '.claude/skills/project-skill/SKILL.md'), 'skill'],
  ['parent-skill', (t) => path.join(t.project, '..', '.claude/skills/parent-skill/SKILL.md'), 'skill'],
  ['user-skill', (t) => path.join(t.config, 'skills/user-skill/SKILL.md'), 'skill'],
  ['colon-skill', (t) => path.join(t.project, '.claude/skills/colon-skill/SKILL.md'), 'skill'],
  ['project-command', (t) => path.join(t.project, '.claude/commands/project-command.md'), 'skill'],
  ['nested-command', (t) => path.join(t.project, '.claude/commands/team/nested-command.md'), 'skill', 'team:nested-command'],
  ['user-command', (t) => path.join(t.config, 'commands/user-command.md'), 'skill'],
  ['project-agent', (t) => path.join(t.project, '.claude/agents/project-agent.md'), 'agent'],
  ['nested-agent', (t) => path.join(t.project, '.claude/agents/team/nested-agent.md'), 'agent'],
  ['parent-agent', (t) => path.join(t.project, '..', '.claude/agents/parent-agent.md'), 'agent'],
  ['user-agent', (t) => path.join(t.config, 'agents/user-agent.md'), 'agent'],
  ['plugin-skill', (t) => path.join(pluginRoot(t), 'skills/plugin-skill/SKILL.md'), 'skill', `${PLUGIN}:plugin-skill`],
  ['listed-skill', (t) => path.join(pluginRoot(t), 'more/listed-skill/SKILL.md'), 'skill', `${PLUGIN}:listed-skill`],
  ['plugin-agent', (t) => path.join(pluginRoot(t), 'agents/plugin-agent.md'), 'agent', `${PLUGIN}:plugin-agent`],
  ['plugin-command', (t) => path.join(pluginRoot(t), 'commands/plugin-command.md'), 'skill', `${PLUGIN}:plugin-command`],
  ['shelved-skill', (t) => path.join(t.project, '.claude/skills/shelf/shelved-skill/SKILL.md'), 'skill'],
];
const IGNORED = ['plugin-agent', 'plugin-command', 'shelved-skill'];
// An unquoted ": " in a value is not YAML; the CLI quotes such a value and
// reads the frontmatter again.
const declares = (label) => `---\nname: ${label}\ndescription: ${label === 'colon-skill' ? 'Watches: the browser' : 'Watches the browser'} for hook-watch-check.
hooks:\n  PreToolUse:\n    - matcher: "${tool(label)}"\n      hooks:\n        - type: command\n          command: '${hook(label).hooks[0].command}'\n---\nCall the tool you are asked to.\n`;

function declaredEverywhere(t, user = {}) {
  for (const [label, file] of DECLARED) {
    fs.mkdirSync(path.dirname(file(t)), { recursive: true });
    fs.writeFileSync(file(t), declares(label));
  }
  const folder = path.dirname(pluginRoot(t));
  write(path.join(pluginRoot(t), '.claude-plugin', 'plugin.json'), { name: PLUGIN, version: '1.0.0', skills: ['./more/listed-skill'] });
  write(path.join(folder, '.claude-plugin', 'marketplace.json'), { name: 'mkf', owner: { name: 'conn' }, plugins: [{ name: PLUGIN, source: `./${PLUGIN}`, version: '1.0.0' }] });
  write(path.join(t.config, 'plugins', 'known_marketplaces.json'), {
    mkf: { source: { source: 'directory', path: folder }, installLocation: folder, lastUpdated: '2026-01-01T00:00:00.000Z' },
  });
  write(path.join(t.config, 'settings.json'), { enabledPlugins: { [`${PLUGIN}@mkf`]: true }, ...user });
  // A project's agents run their hooks only once the person has trusted the
  // folder they come from.
  write(path.join(t.config, '.claude.json'), { projects: Object.fromEntries([t.project, path.dirname(t.project)].map((d) => [d, { hasTrustDialogAccepted: true }])) });
}
const putToWork = DECLARED.flatMap(([label, , kind, name = label]) => (kind === 'agent'
  ? [`tool Agent ${J({ subagent_type: name, description: label, prompt: `tool ${tool(label)} {}\nsay: done` })}`]
  : [`tool Skill ${J({ skill: name })}`, `tool ${tool(label)} {}`]));

const LABELLED = DECLARED.map(([l]) => l);
const SEEN = LABELLED.filter((l) => !IGNORED.includes(l));
for (const [name, setup, want] of [
  ['declared-everywhere', (t) => declaredEverywhere(t), SEEN],
  ['declared-above-the-repository', (t) => { declaredEverywhere(t); spawnSync('git', ['init', '-q'], { cwd: t.project }); }, SEEN.filter((l) => !l.startsWith('parent-'))],
  ['declared-user-disables', (t) => declaredEverywhere(t, { disableAllHooks: true }), []],
]) {
  const t = layout(name);
  setup(t);
  const watch = watchIn(t);
  const got = LABELLED.filter((l) => watch(tool(l)));
  check(`${name} watches ${want.join(', ') || 'nothing'}`, J(got) === J(want), J(got));
  if (CLI) {
    const ran = await cliRan(t, LABELLED.map(tool), putToWork);
    const cli = LABELLED.filter((l) => ran.has(`${l} ${tool(l)}`));
    check(`claude in ${name} runs ${want.join(', ') || 'nothing'}`, J(cli) === J(want), J(cli));
  }
}

{
  const t = layout('declared-sources');
  declaredEverywhere(t);
  const watch = watchIn(t);
  const [, file] = DECLARED.find(([l]) => l === 'project-skill');
  check('a skill\'s hook is named by the skill and its file', watch(tool('project-skill')) === `skill project-skill (${file(t)})`, watch(tool('project-skill')));
  const [, agent] = DECLARED.find(([l]) => l === 'user-agent');
  check('an agent\'s hook is named by the agent and its file', watch(tool('user-agent')) === `agent user-agent (${agent(t)})`, watch(tool('user-agent')));

  // Rewritten where it stands, as an editor saving in place does, which
  // leaves its folder's mtime alone.
  const late = path.join(t.project, '.claude/skills/late-skill/SKILL.md');
  fs.mkdirSync(path.dirname(late), { recursive: true });
  fs.writeFileSync(late, '---\nname: late-skill\ndescription: Watches nothing yet.\n---\n');
  check('a skill that declares no hook watches nothing', !watchIn(t)(tool('late-skill')));
  const folder = fs.statSync(path.dirname(late)).mtimeMs;
  fs.writeFileSync(late, declares('late-skill'));
  check('a hook added to a skill in place is seen by the next batch', !!watchIn(t)(tool('late-skill')) && fs.statSync(path.dirname(late)).mtimeMs === folder);
}

fs.rmSync(tmp, { recursive: true, force: true });
if (failures.length) {
  console.log(`\n${failures.length} FAIL(s): ${failures.join(', ')}`);
  process.exit(1);
}
console.log(`\nhook-watch-check${CLI ? ' --cli' : ''}: all passed`);
