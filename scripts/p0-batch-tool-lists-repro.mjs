/* A skill's disallowed-tools, and an agent's tools and disallowedTools, take
   tools away from the model, and Claude Code applies them to the tool it
   sees. For a batch that is browser_batch alone, so a step inside one could
   run a browser tool the list took away (#71). Checked on both ways Claude
   reaches a batch.

   The chat panel: Conn's own session in plain node, with the claude on PATH
   against the stand-in Messages API in .claude/skills/verify. A subagent's
   own lists bind its batches, and the main thread and a subagent without a
   list keep theirs. A skill's list binds every caller, because Conn cannot
   tell which skill is at work.

   Terminal claude, through the conn MCP server when Claude Code is its
   client. The window cannot tell which agent is calling, so any agent's
   list binds every caller, as any skill's does. Another agent, which never
   reads Claude's lists, keeps its batches. Boots the app on the shop
   fixture. Needs a built renderer: `npx vite build`. Linux only. */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = process.env.CONN_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const drive = await import(pathToFileURL(path.join(ROOT, '.claude/skills/verify/drive.mjs')).href);
const { serve } = await import(pathToFileURL(path.join(ROOT, '.claude/skills/verify/claude-api.mjs')).href);

const J = JSON.stringify;
const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? `: ${detail}` : ''}`);
  if (!ok) failures.push(name);
};
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const declare = (file, name, lines) => write(file, `---\nname: ${name}\ndescription: Drives the preview browser.\n${lines.join('\n')}\n---\nDo the browser steps you are asked for.\n`);
const KEPT = /^(error: )?step 2 \((evaluate|press)\): browser_\2 is taken away by the (tools|disallowedTools|disallowed-tools) of (skill|agent) \S+ \(.+\), so a batch cannot run it either\. Call it on its own if you have it\. Nothing ran\.$/;

/* The chat panel. Each turn's script is one tool call for the stand-in API
   to make, and every browser step Conn runs lands in `ran`, with the agent
   whose call it was. */
async function chatPanel() {
  const bin = process.env.CLAUDE_BIN || require(path.join(ROOT, 'src/main/driver.js')).claudeBinary();
  if (!bin) return check('chat-panel-has-a-claude', false, 'no claude on PATH; set CLAUDE_BIN');
  const env = { ...process.env };
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|ANTHROPIC)/.test(k) && k !== 'CLAUDE_BIN') delete process.env[k];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-tool-lists-'));
  const cwd = path.join(home, 'work');
  const config = path.join(home, '.claude');
  fs.mkdirSync(cwd, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd });
  // A project's agents load only from a folder the person has trusted.
  write(path.join(config, '.claude.json'), J({ projects: { [cwd]: { hasTrustDialogAccepted: true } } }));
  const agents = path.join(cwd, '.claude', 'agents');
  declare(path.join(agents, 'lister.md'), 'lister', ['tools: mcp__preview__browser_batch, mcp__preview__browser_fill']);
  declare(path.join(agents, 'denier.md'), 'denier', ['disallowedTools: mcp__preview__browser_evaluate']);
  declare(path.join(agents, 'plain.md'), 'plain', []);
  // Leaves the batch out, so it never batches and binds nothing.
  declare(path.join(agents, 'reader.md'), 'reader', ['tools: Read, Grep']);
  const skill = path.join(cwd, '.claude', 'skills', 'guard', 'SKILL.md');
  declare(skill, 'guard', ['disallowed-tools: mcp__preview__browser_press']);

  Object.assign(process.env, { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: config });
  const { server, port } = await serve({ project: cwd });
  Object.assign(process.env, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: 'sk-ant-conn-tool-lists', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
  require(path.join(ROOT, 'src/main/driver.js')).preferBinary(bin);
  const { AgentSession } = require(path.join(ROOT, 'src/main/agent.js'));

  const ran = [];
  const invoke = async (route, args, actor) => {
    ran.push(`${actor.type || actor.id} ${route}`);
    return { result: 'ok', caused: null };
  };
  const s = new AgentSession({ cwd, invoke, mode: 'auto', model: 'claude-sonnet-4-5' });
  let results = 0;
  const batches = new Set();
  const answers = new Map();
  s.on('permission', (p) => s.decide(p.id, 'allow'));
  s.on('message', (m) => {
    if (m.type === 'result') results += 1;
    for (const b of Array.isArray(m.message?.content) ? m.message.content : []) {
      if (b.type === 'tool_use' && b.name === 'mcp__preview__browser_batch') batches.add(b.id);
      if (b.type === 'tool_result' && batches.has(b.tool_use_id)) {
        const text = typeof b.content === 'string' ? b.content : (b.content || []).map((c) => c.text || '').join('\n');
        answers.set(b.tool_use_id, { isError: !!b.is_error, text });
      }
    }
  });
  const batch = (steps) => `tool mcp__preview__browser_batch ${J({ actions: steps })}`;
  const turn = async (lines) => {
    ran.length = 0;
    answers.clear();
    const want = results + 1;
    s.send([...lines, 'say: ran'].join('\n'));
    const end = Date.now() + 60000;
    while (results < want && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    if (results < want) throw new Error(`no result for ${J(lines)}`);
    return { ran: [...ran], answer: [...answers.values()][0] || null };
  };
  const by = (agent, prompt) => `tool Agent ${J({ subagent_type: agent, description: agent, prompt: `${prompt}\nsay: done`, run_in_background: false })}`;
  const EVALUATED = [{ tool: 'fill', target: '#coupon', value: 'LISTED' }, { tool: 'evaluate', code: '2' }];
  const PRESSED = [{ tool: 'fill', target: '#coupon', value: 'LISTED' }, { tool: 'press', key: 'Enter' }];
  const both = (who, last) => J([`${who} fill`, `${who} ${last}`]);

  try {
    await s.start();
    {
      const r = await turn([batch(EVALUATED)]);
      check('chat-main-thread-batches-past-agent-lists', J(r.ran) === both('main', 'evaluate') && r.answer && !r.answer.isError, J(r));
    }
    {
      const alone = await turn([by('plain', 'tool mcp__preview__browser_evaluate {"code":"2"}')]);
      check('chat-plain-calls-evaluate-alone', J(alone.ran) === J(['plain evaluate']), J(alone.ran));
    }
    for (const agent of ['lister', 'denier']) {
      // The CLI takes the tool away from the agent, so a call of it alone
      // never reaches Conn.
      const alone = await turn([by(agent, 'tool mcp__preview__browser_evaluate {"code":"2"}')]);
      check(`chat-${agent}-cannot-call-evaluate-alone`, alone.ran.length === 0, J(alone.ran));
      const r = await turn([by(agent, batch(EVALUATED))]);
      check(`chat-${agent}-list-refuses-the-batch`, r.answer?.isError && KEPT.test(r.answer.text) && r.answer.text.includes(path.join(agents, `${agent}.md`)), J(r));
      check(`chat-${agent}-list-runs-no-step`, r.ran.length === 0, J(r.ran));
    }
    for (const agent of ['plain', 'general-purpose']) {
      const r = await turn([by(agent, batch(EVALUATED))]);
      check(`chat-${agent}-subagent-batches`, J(r.ran) === both(agent, 'evaluate') && r.answer && !r.answer.isError, J(r));
    }
    {
      const r = await turn([by('lister', batch([EVALUATED[0]]))]);
      check('chat-lister-batches-the-tools-it-lists', J(r.ran) === J(['lister fill']) && r.answer && !r.answer.isError, J(r));
    }
    {
      const before = await turn(['tool mcp__preview__browser_press {"key":"Enter"}']);
      check('chat-calls-press-alone-before-the-skill', J(before.ran) === J(['main press']), J(before.ran));
      const alone = await turn(['tool Skill {"skill":"guard"}', 'tool mcp__preview__browser_press {"key":"Enter"}']);
      check('chat-cannot-call-press-alone-under-the-skill', alone.ran.length === 0, J(alone.ran));
      const r = await turn(['tool Skill {"skill":"guard"}', batch(PRESSED)]);
      check('chat-skill-list-refuses-the-batch', r.answer?.isError && KEPT.test(r.answer.text) && r.answer.text.includes(skill), J(r));
      check('chat-skill-list-runs-no-step', r.ran.length === 0, J(r.ran));
    }
    {
      const r = await turn([by('plain', batch(PRESSED))]);
      check('chat-skill-list-binds-subagents-too', r.answer?.isError && KEPT.test(r.answer.text) && r.ran.length === 0, J(r));
    }
  } catch (e) {
    check('chat-panel-run', false, e.stack || e.message);
  } finally {
    s.stop();
    server.close();
    await new Promise((r) => setTimeout(r, 500));
    fs.rmSync(home, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
    Object.assign(process.env, env);
  }
}

/* Terminal claude, and another agent, through the conn MCP server. The fill
   would leave its value in the field, and the evaluate its mark on the page,
   had either run. */
async function bridge() {
  const STEPS = [{ tool: 'fill', target: '#coupon', value: 'LISTED' }, { tool: 'evaluate', code: 'window.__batched = 2; 2' }];
  const LEFT = { code: 'document.querySelector("#coupon").value + "|" + String(window.__batched)' };
  const UNTOUCHED = '|undefined';
  const RAN = 'LISTED|2';
  const s = await drive.boot({ root: ROOT, xvfb: true });
  let shop;
  const clients = [];
  try {
    shop = spawn(process.execPath, ['server.mjs'], { cwd: s.project, stdio: ['ignore', 'pipe', 'inherit'] });
    const url = await new Promise((res, rej) => {
      shop.stdout.on('data', (d) => { const m = /Local: (\S+)/.exec(String(d)); if (m) res(m[1]); });
      shop.on('exit', () => rej(new Error('the shop server exited')));
    });
    await drive.invoke(s, 'navigate', { url });
    await drive.evaluate(s, `globalThis.__agent.mode = 'auto'`, { main: true });
    const connect = async (name, env) => {
      const mcp = new Client({ name, version: '0' });
      clients.push(mcp);
      await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'mcp/server.js')], cwd: s.project, env }));
      return async (tool, args) => {
        const r = await mcp.callTool({ name: tool, arguments: args });
        return { isError: !!r.isError, text: r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') };
      };
    };
    const base = { ...process.env, HOME: s.home, CONN_CWD: s.project };
    delete base.CLAUDECODE;
    const runs = {
      'claude-code': await connect('claude-code', base),
      'other-agent': await connect('p0-batch-tool-lists-repro', { ...base, CLAUDECODE: '1' }),
    };
    const run = async (via) => {
      await runs[via]('browser_navigate', { url });
      const out = await runs[via]('browser_batch', { actions: STEPS });
      return { ...out, left: (await runs[via]('browser_evaluate', LEFT)).text };
    };

    // Written after the window is up, so only a read when the batch is
    // planned can see them.
    const dir = path.join(s.project, '.claude');
    const CASES = [
      ['none', null, null, true],
      ['agent-without-the-batch', path.join(dir, 'agents', 'reader.md'), ['tools: Read, Grep'], true],
      ['agent-tools', path.join(dir, 'agents', 'lister.md'), ['tools: mcp__conn__browser_batch, mcp__conn__browser_fill'], false],
      ['agent-disallowed', path.join(dir, 'agents', 'denier.md'), ['disallowedTools: mcp__conn__browser_evaluate'], false],
      ['skill-disallowed', path.join(dir, 'skills', 'guard', 'SKILL.md'), ['disallowed-tools: mcp__conn__browser_evaluate'], false],
      ['skill-allowed', path.join(dir, 'skills', 'helper', 'SKILL.md'), ['allowed-tools: mcp__conn__browser_evaluate'], true],
    ];
    for (const [name, file, lines, batches] of CASES) {
      if (file) declare(file, path.basename(file) === 'SKILL.md' ? path.basename(path.dirname(file)) : path.basename(file, '.md'), lines);
      const r = await run('claude-code');
      if (batches) check(`bridge-claude-code-batches-with-${name}`, !r.isError && r.left === RAN, J(r));
      else {
        check(`bridge-claude-code-${name}-refuses-the-batch`, r.isError && KEPT.test(r.text) && r.text.includes(file), J(r));
        check(`bridge-claude-code-${name}-leaves-the-page`, r.left === UNTOUCHED, J(r));
        const other = await run('other-agent');
        check(`bridge-other-agent-batches-past-${name}`, !other.isError && other.left === RAN, J(other));
      }
      if (file) fs.rmSync(file);
    }
  } finally {
    for (const c of clients) await c.close().catch(() => {});
    shop?.kill();
    await drive.stop(s);
  }
}

await chatPanel();
await bridge();
if (failures.length) {
  console.log(`\n${failures.length} FAIL(s): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\np0-batch-tool-lists-repro: all passed');
process.exit(0);
