'use strict';
// The permission rules Claude keeps, so they can be read and taken back.
// **Always** on a permission card hands the CLI the rule it suggested, and the
// CLI writes it into one of three settings files. Conn only ever touches the
// `permissions` lists in those three, and leaves the rest of each file as it was.
const fs = require('fs');
const os = require('os');
const path = require('path');
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

/* The PreToolUse hooks of the plugins `enabled` turns on, which names each
   `<plugin>@<marketplace>`. A plugin from a marketplace kept in a local folder
   loads from that folder, any other from the copy installed_plugins.json
   names. Its hooks are hooks/hooks.json's, and those its plugin.json names:
   files of the same shape, or the hooks themselves. */
function pluginHooks(enabled) {
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
    return roots.flatMap((root) => {
      const named = read(path.join(root, '.claude-plugin', 'plugin.json')).json?.hooks ?? [];
      const sets = [read(path.join(root, 'hooks', 'hooks.json')).json?.hooks,
        ...[named].flat().map((h) => (typeof h === 'string' ? read(path.resolve(root, h)).json?.hooks : h))];
      return sets.flatMap((hooks) => preToolUse(hooks, `plugin ${id}`));
    });
  });
}

/**
 * The PreToolUse hooks the CLI runs in `project`, as a test of a tool's full
 * name that answers where the first hook watching it is set, or null. The CLI
 * runs a hook against the call it sees, which for a browser batch is the
 * batch, so a step a hook watches has to be called alone. Read when a batch
 * is planned, so a hook added mid-session counts.
 * A managed disableAllHooks turns every hook off. Elsewhere disableAllHooks
 * takes the value of the last file that sets it, and true there, or a managed
 * allowManagedHooksOnly, leaves only what the managed settings bring: their
 * own hooks and those of the plugins they turn on.
 */
function hookWatch(project) {
  const sources = settings(project).map((s) => ({ ...s, json: read(s.file).json || {} }));
  const policy = sources.filter((s) => s.scope === 'managed');
  if (policy.some((s) => s.json.disableAllHooks === true)) return () => null;
  const off = sources.map((s) => s.json.disableAllHooks).filter((v) => v !== undefined).at(-1) === true;
  const kept = off || policy.some((s) => s.json.allowManagedHooksOnly === true) ? policy : sources;
  const watches = [
    ...kept.flatMap((s) => preToolUse(s.json.hooks, s.file)),
    ...pluginHooks(Object.assign({}, ...kept.map((s) => s.json.enabledPlugins))),
  ];
  return (tool) => watches.find((w) => matches(w.matcher, tool))?.source ?? null;
}

module.exports = { list, remove, files, ruleFor, hookWatch };
