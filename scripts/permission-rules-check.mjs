/* Which settings files Conn reads a permission rule from, under plain node,
   against the files the CLI reads: the project's two, the user's in
   CLAUDE_CONFIG_DIR when that is set, the cached server-managed settings
   beside it, and the administrator's file with its managed-settings.d
   drop-ins. The administrator's folder is under /etc, so reads of it are sent
   to a temporary folder instead. Linux only, like the CLI's folder for it. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-rules-'));
const home = path.join(tmp, 'home');
const config = path.join(tmp, 'config');
const project = path.join(tmp, 'project');
const policy = path.join(tmp, 'etc-claude-code');
for (const dir of [path.join(home, '.claude'), config, path.join(project, '.claude'), path.join(policy, 'managed-settings.d')]) {
  fs.mkdirSync(dir, { recursive: true });
}
process.env.HOME = home;
process.env.CLAUDE_CONFIG_DIR = config;

const POLICY = '/etc/claude-code';
const moved = (p) => (typeof p === 'string' && (p === POLICY || p.startsWith(`${POLICY}/`)) ? policy + p.slice(POLICY.length) : p);
for (const name of ['readFileSync', 'readdirSync']) {
  const real = fs[name];
  fs[name] = (p, ...rest) => real(moved(p), ...rest);
}
const { ruleFor, list, remove } = require('../src/main/permission-rules.js');

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail !== undefined ? `: ${detail}` : ''}`);
  if (!ok) failures.push(name);
};
const write = (file, permissions) => fs.writeFileSync(file, JSON.stringify({ permissions }));
const tool = (n) => `mcp__conn__browser_${n}`;

write(path.join(config, 'settings.json'), { deny: [tool('evaluate')] });
write(path.join(home, '.claude', 'settings.json'), { deny: [tool('click')] });
check('user-rule-read-from-claude-config-dir', ruleFor(project, tool('evaluate')) === 'deny', ruleFor(project, tool('evaluate')));
check('home-settings-ignored-under-claude-config-dir', ruleFor(project, tool('click')) === null, ruleFor(project, tool('click')));
const listed = list(project).rules.find((r) => r.rule === tool('evaluate'));
check('settings-lists-the-claude-config-dir-rule', listed?.scope === 'user' && listed.file === path.join(config, 'settings.json'), JSON.stringify(listed));
const gone = remove(project, { scope: 'user', kind: 'deny', rule: tool('evaluate') });
check('settings-removes-the-claude-config-dir-rule', gone.ok && ruleFor(project, tool('evaluate')) === null, JSON.stringify(gone));

write(path.join(config, 'remote-settings.json'), { deny: [tool('fill')] });
check('server-managed-cache-read', ruleFor(project, tool('fill')) === 'deny', ruleFor(project, tool('fill')));

write(path.join(policy, 'managed-settings.json'), { allow: [tool('press')] });
write(path.join(policy, 'managed-settings.d', '10-browser.json'), { ask: [tool('press')] });
check('managed-drop-in-read', ruleFor(project, tool('press')) === 'ask', ruleFor(project, tool('press')));
write(path.join(policy, 'managed-settings.d', '.20-hidden.json'), { deny: [tool('press')] });
fs.writeFileSync(path.join(policy, 'managed-settings.d', '30-notes.txt'), JSON.stringify({ permissions: { deny: [tool('press')] } }));
check('drop-ins-skip-hidden-and-non-json-files', ruleFor(project, tool('press')) === 'ask', ruleFor(project, tool('press')));

fs.rmSync(tmp, { recursive: true, force: true });
if (failures.length) {
  console.log(`\n${failures.length} FAIL(s): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\npermission-rules-check: all passed');
