'use strict';
// The permission rules Claude keeps, so they can be read and taken back.
// **Always** on a permission card hands the CLI the rule it suggested, and the
// CLI writes it into one of three settings files. Conn only ever touches the
// `permissions` lists in those three, and leaves the rest of each file as it was.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');
const shellEnv = require('./shell-env');

const KINDS = ['allow', 'ask', 'deny'];

// Where the CLI keeps the user's settings: CLAUDE_CONFIG_DIR when the
// environment it is started with sets one, ~/.claude otherwise.
const configDir = () => shellEnv.env().CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

// Each place a rule can live, most personal first.
function files(project) {
  const home = path.join(configDir(), 'settings.json');
  if (!project) return [{ scope: 'user', file: home }];
  return [
    { scope: 'local', file: path.join(project, '.claude', 'settings.local.json') },
    { scope: 'project', file: path.join(project, '.claude', 'settings.json') },
    { scope: 'user', file: home },
  ];
}

function read(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return { json: JSON.parse(text) };
  } catch (e) {
    if (e.code === 'ENOENT') return { json: null };
    return { json: null, error: `${file} could not be read: ${e.message}` };
  }
}

// Every rule in every file, in file order, then allow, ask, deny.
function list(project) {
  const rules = [];
  const errors = [];
  for (const { scope, file } of files(project)) {
    const { json, error } = read(file);
    if (error) errors.push(error);
    const perms = json?.permissions;
    if (!perms || typeof perms !== 'object') continue;
    for (const kind of KINDS) {
      for (const rule of Array.isArray(perms[kind]) ? perms[kind] : []) {
        if (typeof rule === 'string') rules.push({ scope, file, kind, rule });
      }
    }
  }
  return { rules, errors };
}

// Takes one rule out of one file. The file is read again first, so a rule the
// CLI added since the list was drawn is not lost, and written back whole.
function remove(project, { scope, kind, rule } = {}) {
  const place = files(project).find((f) => f.scope === scope);
  if (!place || !KINDS.includes(kind) || typeof rule !== 'string') return { ok: false, error: 'Not a rule Conn knows how to remove.' };
  const { json, error } = read(place.file);
  if (error) return { ok: false, error };
  const lst = json?.permissions?.[kind];
  if (!Array.isArray(lst) || !lst.includes(rule)) return { ok: false, error: 'That rule is no longer there.' };
  json.permissions[kind] = lst.filter((r) => r !== rule);
  try {
    fs.writeFileSync(place.file, `${JSON.stringify(json, null, 2)}\n`);
  } catch (e) {
    return { ok: false, error: `${place.file} could not be written: ${e.message}` };
  }
  return { ok: true };
}

// Where an administrator's policy lives: managed-settings.json, then the
// .json files in managed-settings.d in name order, as the CLI reads them.
// Conn never lists or edits them, but a rule there binds every session all
// the same.
const POLICY = { darwin: '/Library/Application Support/ClaudeCode', win32: 'C:\\Program Files\\ClaudeCode' }[process.platform]
  || '/etc/claude-code';

function managed() {
  const dropIns = path.join(POLICY, 'managed-settings.d');
  let names = [];
  try { names = fs.readdirSync(dropIns).filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort(); } catch {}
  return [path.join(POLICY, 'managed-settings.json'), ...names.map((n) => path.join(dropIns, n))];
}

// Every settings file the CLI reads, least binding first.
// remote-settings.json is the CLI's copy of the organisation's server-managed
// settings, written as plain JSON each time it fetches them.
function settings(project) {
  return [
    ...files(project).reverse(),
    ...managed().map((file) => ({ scope: 'managed', file })),
    { scope: 'managed', file: path.join(configDir(), 'remote-settings.json') },
  ];
}

/**
 * What the rules say about one MCP tool by its full name: 'deny', 'ask',
 * 'allow' or null. Deny beats ask beats allow, the order the CLI weighs them
 * in. A rule can name the tool, or its whole server (`mcp__preview` or
 * `mcp__preview__*`). This is for the steps of a browser batch, which the CLI
 * only ever sees as the batch: without it a step would slip past a rule that
 * names its tool.
 */
function ruleFor(project, tool) {
  const server = tool.split('__').slice(0, 2).join('__');
  const names = new Set([tool, server, `${server}__*`]);
  const found = new Set();
  for (const { file } of settings(project)) {
    const perms = read(file).json?.permissions;
    if (!perms || typeof perms !== 'object') continue;
    for (const kind of KINDS) {
      if ((Array.isArray(perms[kind]) ? perms[kind] : []).some((r) => names.has(r))) found.add(kind);
    }
  }
  return ['deny', 'ask', 'allow'].find((k) => found.has(k)) || null;
}

// How the CLI reads a hook's matcher, as tried against its own runs: none,
// empty or * is every tool; one of only letters, digits, _, |, commas, spaces
// and - is a list of exact names; anything else is a regular expression,
// unanchored and case-sensitive, and one that does not compile matches nothing.
function matches(matcher, tool) {
  if (!matcher || matcher === '*') return true;
  if (/^[\w|, -]+$/.test(matcher)) return matcher.split(/[|,]/).some((name) => name.trim() === tool);
  try { return new RegExp(matcher).test(tool); } catch { return false; }
}

const preToolUse = (hooks, source) => (Array.isArray(hooks?.PreToolUse) ? hooks.PreToolUse : [])
  .filter((e) => e?.hooks?.length)
  .map((e) => ({ source, matcher: e.matcher }));

/* The plugins `enabled` turns on, which names each `<plugin>@<marketplace>`,
   with the folder each loads from and its plugin.json. A plugin from a
   marketplace kept in a local folder loads from that folder, any other from
   the copy installed_plugins.json names. */
function pluginRoots(enabled) {
  const dir = path.join(configDir(), 'plugins');
  const installed = read(path.join(dir, 'installed_plugins.json')).json?.plugins || {};
  const markets = read(path.join(dir, 'known_marketplaces.json')).json || {};
  return Object.keys(enabled).filter((id) => enabled[id]).flatMap((id) => {
    const at = id.lastIndexOf('@');
    const market = markets[id.slice(at + 1)];
    const folder = market?.source?.source === 'directory'
      ? read(path.join(market.installLocation, '.claude-plugin', 'marketplace.json')).json?.plugins?.find((p) => p?.name === id.slice(0, at))?.source
      : null;
    const roots = typeof folder === 'string' ? [path.resolve(market.installLocation, folder)]
      : [installed[id] ?? []].flat().map((e) => e?.installPath).filter(Boolean);
    return roots.map((root) => ({ id, root, manifest: read(path.join(root, '.claude-plugin', 'plugin.json')).json || {} }));
  });
}

// A plugin's hooks are hooks/hooks.json's, and those its plugin.json names:
// files of the same shape, or the hooks themselves.
function pluginHooks({ id, root, manifest }) {
  const sets = [read(path.join(root, 'hooks', 'hooks.json')).json?.hooks,
    ...[manifest.hooks ?? []].flat().map((h) => (typeof h === 'string' ? read(path.resolve(root, h)).json?.hooks : h))];
  return sets.flatMap((hooks) => preToolUse(hooks, `plugin ${id}`));
}

const below = (dir) => {
  try { return fs.readdirSync(dir).filter((n) => !n.startsWith('.')).map((n) => path.join(dir, n)); } catch { return []; }
};
const skillFiles = (dir) => below(dir).map((d) => path.join(d, 'SKILL.md'));
// Stops three folders down, so a link back up cannot loop it.
const markdown = (dir, depth = 0) => below(dir).flatMap((p) => (p.endsWith('.md') ? [p] : depth < 3 ? markdown(p, depth + 1) : []));
// A plugin's skills are in skills/, and where its plugin.json lists them: a
// skill's own folder, or a folder of them.
const pluginSkills = ({ root, manifest }) => [
  ...skillFiles(path.join(root, 'skills')),
  ...[manifest.skills ?? []].flat().filter((s) => typeof s === 'string').map((s) => path.resolve(root, s))
    .flatMap((dir) => [path.join(dir, 'SKILL.md'), ...skillFiles(dir)]),
];

// The folder and each one above it up to the repository's root.
function upToRoot(dir) {
  const dirs = [dir];
  while (!fs.existsSync(path.join(dir, '.git')) && path.dirname(dir) !== dir) {
    dir = path.dirname(dir);
    dirs.push(dir);
  }
  return dirs;
}

// Discover nested hook folders once per project in this process. Their files
// still use declaration()'s mtime/size cache, so edits are seen by the next
// batch. Git skips dependency trees but includes gitignored declarations,
// which Claude can still load. Plain folders use a walk
// that never follows symlinks or enters node_modules and .git.
const nestedFolders = new Map();
function nestedClaudeFolders(project) {
  const root = path.resolve(project);
  if (nestedFolders.has(root)) return nestedFolders.get(root);
  const found = new Set();
  try {
    const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude=node_modules/', '--exclude=.git/', '-z', '--', ':(glob)**/.claude/**'], {
      cwd: root, encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    for (const file of files.split('\0')) {
      const parts = file.split('/');
      if (parts.some((p) => p === 'node_modules' || p === '.git' || p === '..')) continue;
      const at = parts.indexOf('.claude');
      if (at > 0) found.add(path.join(root, ...parts.slice(0, at + 1)));
    }
  } catch {
    const pending = [root];
    while (pending.length) {
      const dir = pending.pop();
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name === '.git') continue;
        const child = path.join(dir, entry.name);
        if (entry.name === '.claude') {
          if (dir !== root) found.add(child);
        } else pending.push(child);
      }
    }
  }
  const folders = [...found].sort();
  nestedFolders.set(root, folders);
  return folders;
}

/* The files whose frontmatter can declare hooks the CLI runs while that
   skill, command or agent is at work, as tried against the CLI's own runs:
   skills/<name>/SKILL.md, commands/**.md and agents/**.md in each of
   `folders`, and an enabled plugin's skills. The CLI ignores what a plugin's
   agents and commands declare. */
function declarers(folders, plugins) {
  return [
    ...folders.flatMap((dir) => [
      ...skillFiles(path.join(dir, 'skills')).map((file) => ({ kind: 'skill', file })),
      ...markdown(path.join(dir, 'commands')).map((file) => ({ kind: 'command', file })),
      ...markdown(path.join(dir, 'agents')).map((file) => ({ kind: 'agent', file })),
    ]),
    ...plugins.flatMap(pluginSkills).map((file) => ({ kind: 'skill', file })),
  ];
}

/* A frontmatter as the CLI reads it: the text between the first two ---
   lines as YAML, and when that does not parse, again with each top-level
   value that holds YAML's special characters quoted and leading tabs made
   spaces. An unquoted "description: Use when: ..." parses only the second
   time. */
const FENCE = /^---\s*\n([\s\S]*?)---\s*\n?/;
function frontmatter(block) {
  const load = (text) => {
    const v = yaml.load(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  };
  try { return load(block); } catch {}
  const quoted = block.split('\n').map((line) => {
    const m = /^([a-zA-Z_-]+):\s+(\S.*)$/.exec(line);
    if (!m || /^(".*"|'.*')$/.test(m[2]) || !/[{}[\]*&#!|>%@`]|: /.test(m[2])) return line;
    if (/^\[.*\]$/.test(m[2])) { try { if (Array.isArray(yaml.load(m[2]))) return line; } catch {} }
    return `${m[1]}: "${m[2].replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  }).join('\n').replace(/^\t+/gm, (tabs) => '  '.repeat(tabs.length));
  try { return load(quoted); } catch { return {}; }
}

// What each file declares, kept by its mtime and size so a batch reads again
// only a file that changed. Its folder's mtime would miss an edit made in place.
// Only a frontmatter that can hold hooks or a tool list is parsed.
const declared = new Map();
function declaration({ kind, file }) {
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  const stamp = `${stat.mtimeMs}:${stat.size}`;
  if (declared.get(file)?.stamp !== stamp) {
    let block;
    try { block = FENCE.exec(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))?.[1]; } catch {}
    const meta = /PreToolUse|tools/i.test(block ?? '') ? frontmatter(block) : {};
    const name = String(meta.name || (kind === 'skill' ? path.basename(path.dirname(file)) : path.basename(file, '.md')));
    declared.set(file, { stamp, name, meta });
  }
  return declared.get(file);
}

function declaredHooks(d) {
  const found = declaration(d);
  return found ? preToolUse(found.meta.hooks, `${d.kind} ${found.name} (${d.file})`) : [];
}

/* A tool list as the CLI reads it, as tried against its own runs: a YAML
   list, or a string of names split on commas and spaces. An agent's entry
   names its tool whatever follows it in parentheses, a skill's only bare. */
function entries(value, agent) {
  const all = Array.isArray(value) ? value.map(String) : typeof value === 'string' ? value.match(/[^\s,(]+(\([^)]*\))?/g) || [] : [];
  return all.map((e) => (agent ? e.trim().replace(/\(.*\)$/, '') : e.trim()));
}

// Whether a list names an MCP tool: by its full name, by its server as
// mcp__<server> or mcp__<server>__*, or as mcp__*. Case counts.
function named(list, tool) {
  const server = tool.split('__').slice(0, 2).join('__');
  return list.some((e) => e === tool || e === server || e === `${server}__*` || e === 'mcp__*');
}

/* The lists one file declares. A skill or command takes away what its
   disallowed-tools or disallowedTools names; its allowed-tools only grants.
   An agent has only what its tools names, all of them for none or *, less
   what its disallowedTools names. A plugin's agent is known by the plugin's
   name and its own. */
function declaredLists(d) {
  const found = declaration(d);
  if (!found) return null;
  const { meta } = found;
  const agent = d.kind === 'agent';
  const tools = agent && meta.tools != null ? entries(meta.tools, true) : null;
  return {
    ...d,
    name: d.plugin ? `${d.plugin}:${found.name}` : found.name,
    tools: tools?.includes('*') ? null : tools,
    disallowed: entries(agent ? meta.disallowedTools : meta['disallowed-tools'] ?? meta.disallowedTools, agent),
  };
}

// Which of a file's lists takes `tool` away, or null.
function takes({ kind, name, file, tools, disallowed }, tool) {
  const list = tools && !named(tools, tool) ? 'tools'
    : named(disallowed, tool) ? (kind === 'agent' ? 'disallowedTools' : 'disallowed-tools') : null;
  return list && `the ${list} of ${kind} ${name} (${file})`;
}

// A plugin's agents and commands. The CLI keeps their tool lists, though it
// runs none of their hooks.
const pluginAgents = ({ id, root, manifest }) => [
  ...markdown(path.join(root, 'agents')).map((file) => ({ kind: 'agent', file, plugin: manifest.name || id.slice(0, id.lastIndexOf('@')) })),
  ...markdown(path.join(root, 'commands')).map((file) => ({ kind: 'command', file })),
];

/**
 * The PreToolUse hooks the CLI runs in `project`, as a test of a tool's full
 * name that answers where the first hook watching it is set, or null. The CLI
 * runs a hook against the call it sees, which for a browser batch is the
 * batch, so a step a hook watches has to be called alone. Read when a batch
 * is planned, so a hook added mid-session counts.
 * A hook a skill, command or agent declares runs only while that one is at
 * work, which Conn cannot tell, so it counts as always on. The .claude folders
 * they are read from are the project's, each one above it up to the
 * repository's root, nested folders in the project, and the user's config folder.
 * A managed disableAllHooks turns every hook off. Elsewhere disableAllHooks
 * takes the value of the last file that sets it, and true there, or a managed
 * allowManagedHooksOnly, leaves only what the managed settings bring: their
 * own hooks and those of the plugins they turn on, skills included.
 */
function hookWatch(project) {
  const sources = settings(project).map((s) => ({ ...s, json: read(s.file).json || {} }));
  const policy = sources.filter((s) => s.scope === 'managed');
  if (policy.some((s) => s.json.disableAllHooks === true)) return () => null;
  const off = sources.map((s) => s.json.disableAllHooks).filter((v) => v !== undefined).at(-1) === true;
  const kept = off || policy.some((s) => s.json.allowManagedHooksOnly === true) ? policy : sources;
  const plugins = pluginRoots(Object.assign({}, ...kept.map((s) => s.json.enabledPlugins)));
  const folders = kept === sources ? [...(project ? [...upToRoot(project).map((d) => path.join(d, '.claude')), ...nestedClaudeFolders(project)] : []), configDir()] : [];
  const watches = [
    ...kept.flatMap((s) => preToolUse(s.json.hooks, s.file)),
    ...plugins.flatMap(pluginHooks),
    ...declarers(folders, plugins).flatMap(declaredHooks),
  ];
  return (tool) => watches.find((w) => matches(w.matcher, tool))?.source ?? null;
}

/**
 * The tool lists of the skills, commands and agents the CLI loads in
 * `project`, as a test of a browser tool's full name that answers which list
 * takes it away from the caller, or null. The CLI applies a list to the call
 * it sees, which for a browser batch is the batch, so a step a list takes
 * away has to be refused here. Read when a batch is planned, from the same
 * ancestor and config folders as hookWatch, a plugin's agents and commands
 * included. Nested project folders are currently checked only for hooks.
 * A skill's list binds only while that skill is at work, which Conn cannot
 * tell, so every skill's binds every caller. An agent's binds that agent
 * alone, and `binds` picks by name the agents the caller may be. A list that
 * takes the batch itself away binds no one, since a batch never comes from
 * under it. Of two agents with one name, the CLI keeps the nearer one's.
 */
function toolLists(project, binds) {
  const plugins = pluginRoots(Object.assign({}, ...settings(project).map((s) => read(s.file).json?.enabledPlugins)));
  const folders = [...(project ? upToRoot(project).map((d) => path.join(d, '.claude')) : []), configDir()];
  const seen = new Set();
  const lists = [...declarers(folders, plugins), ...plugins.flatMap(pluginAgents)].map(declaredLists).filter((l) => {
    if (!l || l.kind !== 'agent') return !!l;
    if (seen.has(l.name)) return false;
    seen.add(l.name);
    return binds(l.name);
  });
  return (tool) => {
    const batch = `${tool.split('__').slice(0, 2).join('__')}__browser_batch`;
    for (const l of lists) {
      const why = !takes(l, batch) && takes(l, tool);
      if (why) return why;
    }
    return null;
  };
}

module.exports = { list, remove, files, ruleFor, hookWatch, toolLists };
