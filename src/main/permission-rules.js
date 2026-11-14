'use strict';
// The permission rules Claude keeps, so they can be read and taken back.
// **Always** on a permission card hands the CLI the rule it suggested, and the
// CLI writes it into one of three settings files. Conn only ever touches the
// `permissions` lists in those three, and leaves the rest of each file as it was.
const fs = require('fs');
const os = require('os');
const path = require('path');

const KINDS = ['allow', 'ask', 'deny'];

// Each place a rule can live, most personal first.
function files(project) {
  const home = path.join(os.homedir(), '.claude', 'settings.json');
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

module.exports = { list, remove, files };
