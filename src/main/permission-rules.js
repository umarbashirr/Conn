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
  // remote-settings.json is the CLI's copy of the organisation's
  // server-managed settings, written as plain JSON each time it fetches them.
  const places = [...files(project).map((f) => f.file), ...managed(), path.join(configDir(), 'remote-settings.json')];
  for (const file of places) {
    const perms = read(file).json?.permissions;
    if (!perms || typeof perms !== 'object') continue;
    for (const kind of KINDS) {
      if ((Array.isArray(perms[kind]) ? perms[kind] : []).some((r) => names.has(r))) found.add(kind);
    }
  }
  return ['deny', 'ask', 'allow'].find((k) => found.has(k)) || null;
}

module.exports = { list, remove, files, ruleFor };
