/* Issue #70: a nested skill's hook must refuse a batch before any step
   runs. No window or model is needed: this uses the real hook reader and
   batch planner. --benchmark also measures a 20,000-file repository. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import childProcess, { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const { z } = require('zod');
const originalExec = childProcess.execFileSync;
let scans = 0;
childProcess.execFileSync = (...args) => {
  if (args[1]?.[0] === 'ls-files') scans++;
  return originalExec(...args);
};
const { hookWatch } = require('../src/main/permission-rules.js');
const { planBatch } = require('../src/shared/browser-tools.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-nested-hooks-'));
const originalConfig = process.env.CLAUDE_CONFIG_DIR;
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'config');
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const declaration = (name, tool = 'evaluate') => `---
name: ${name}
description: Watches the browser.
hooks:
  PreToolUse:
    - matcher: "mcp__.*__browser_${tool}"
      hooks:
        - type: command
          command: 'exit 2'
---
`;
const actions = [{ tool: 'navigate', url: 'https://example.com' }, { tool: 'evaluate', code: '1' }];
const watched = (project) => (tool) => hookWatch(project)(`mcp__conn__${tool}`);
const failures = [];
function check(name, fn) {
  try { fn(); console.log(`PASS ${name}`); } catch (e) { failures.push(name); console.error(`FAIL ${name}: ${e.message}`); }
}

try {
  for (const git of [true, false]) {
    const project = path.join(tmp, git ? 'git project' : 'plain project');
    fs.mkdirSync(project, { recursive: true });
    if (git) execFileSync('git', ['init', '-q', project]);
    const skill = path.join(project, 'packages/x/.claude/skills/nested-guard/SKILL.md');
    const command = path.join(project, 'packages/y/.claude/commands/guard.md');
    const agent = path.join(project, 'packages/z/.claude/agents/guard.md');
    write(skill, declaration('nested-guard'));
    write(command, declaration('command-guard', 'click'));
    write(agent, declaration('agent-guard', 'fill'));
    write(path.join(project, 'node_modules/pkg/.claude/skills/ignored/SKILL.md'), declaration('ignored', 'hover'));
    write(path.join(project, '.git/pkg/.claude/skills/ignored/SKILL.md'), declaration('ignored', 'hover'));
    if (git) {
      write(path.join(project, '.gitignore'), 'packages/y/\n');
      execFileSync('git', ['add', 'packages/x'], { cwd: project });
    }
    check(`${git ? 'git' : 'fallback'} discovers nested skills, commands and agents`, () => {
      const watch = hookWatch(project);
      assert.equal(watch('mcp__conn__browser_evaluate'), `skill nested-guard (${skill})`);
      assert.equal(watch('mcp__conn__browser_click'), `command command-guard (${command})`);
      assert.equal(watch('mcp__preview__browser_fill'), `agent agent-guard (${agent})`);
      assert.equal(watch('mcp__conn__browser_hover'), null);
    });
    check(`${git ? 'git' : 'fallback'} refuses the whole batch and names the nested skill`, () => {
      assert.throws(() => planBatch(actions, z, watched(project)), /step 2 .*skill nested-guard.*Nothing ran\./);
      assert.equal(planBatch([actions[0]], z, watched(project)).length, 1);
    });
    check(`${git ? 'git' : 'fallback'} refreshes edits without rediscovering folders`, () => {
      const before = scans;
      write(skill, declaration('changed-guard', 'text'));
      const watch = hookWatch(project);
      assert.equal(watch('mcp__conn__browser_evaluate'), null);
      assert.equal(watch('mcp__conn__browser_text'), `skill changed-guard (${skill})`);
      assert.equal(scans, before, 'the next batch does not repeat Git discovery');
    });
    check(`${git ? 'git' : 'fallback'} respects disableAllHooks`, () => {
      write(path.join(project, '.claude/settings.json'), '{"disableAllHooks":true}');
      assert.equal(hookWatch(project)('mcp__conn__browser_text'), null);
    });
  }
  if (process.argv.includes('--benchmark')) {
    const project = path.join(tmp, 'large');
    for (let i = 0; i < 20000; i++) write(path.join(project, `packages/p${i % 200}/file${i}.js`), '');
    for (let i = 0; i < 50; i++) write(path.join(project, `packages/p${i}/.claude/skills/guard/SKILL.md`), declaration('guard'));
    execFileSync('git', ['init', '-q', project]);
    execFileSync('git', ['add', '.'], { cwd: project });
    const start = performance.now();
    hookWatch(project);
    const cold = performance.now() - start;
    const warm = performance.now();
    for (let i = 0; i < 100; i++) hookWatch(project);
    console.log(`20,000 files, 50 nested skills: first ${cold.toFixed(2)} ms; cached average ${((performance.now() - warm) / 100).toFixed(2)} ms`);
  }
} finally {
  childProcess.execFileSync = originalExec;
  if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalConfig;
  fs.rmSync(tmp, { recursive: true, force: true });
}
assert.equal(failures.length, 0, failures.join(', '));
