#!/usr/bin/env node
'use strict';
// Command-line front end to the preview pane. Meant to be run from inside the
// app's own terminal, where CONN_BRIDGE_URL and CONN_TOKEN are already set.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const state = require('./state');
const { mcpServerPath } = require('./packaged-path');

// Which project the command was typed in. One window can have several open,
// so every request says where it came from and the window routes it from
// there. The app's terminals export CONN_CWD, and that beats the shell's own
// cwd: a shell that has wandered into node_modules, or into a checkout sitting
// inside the project, still belongs to the project its terminal was opened for.
const callerCwd = () => process.env.CONN_CWD || process.cwd();

function connection() {
  if (process.env.CONN_BRIDGE_URL && process.env.CONN_TOKEN) {
    return { url: process.env.CONN_BRIDGE_URL, token: process.env.CONN_TOKEN };
  }
  const found = state.find(callerCwd());
  if (found) return found;
  die('no window open for this folder. Run `conn .` to open one.');
}

// ------------------------------------------------------------ opening a project

const expand = (p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const looksLikePath = (a) =>
  a === '.' || a === '..' || a.startsWith('/') || a.startsWith('./') || a.startsWith('../') || a.startsWith('~');

// Find the app binary. Installed, packaged, AppImage, or a source checkout.
function findApp() {
  const named = process.env.CONN_APP;
  if (named && fs.existsSync(named)) return { bin: named, args: [] };

  if (process.env.APPIMAGE && fs.existsSync(process.env.APPIMAGE)) return { bin: process.env.APPIMAGE, args: [] };

  // /usr/bin/conn runs the app's own binary as node, so execPath is the app.
  const exe = process.execPath;
  if (process.env.ELECTRON_RUN_AS_NODE && path.basename(exe) !== 'node' && fs.existsSync(exe)) {
    return { bin: exe, args: [] };
  }

  // Packaged beside us: <app>/resources/app.asar.unpacked/cli/conn.js
  const exeName = process.platform === 'win32' ? 'conn.exe' : 'conn';
  const beside = path.join(__dirname, '..', '..', '..', '..', exeName);
  if (fs.existsSync(beside)) return { bin: beside, args: [] };

  const installed = process.platform === 'win32'
    ? [
      // Where the one-click installer puts it, then the machine-wide places
      // someone may have moved it to.
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'conn', 'conn.exe'),
      path.join(process.env.PROGRAMFILES || '', 'conn', 'conn.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'conn', 'conn.exe'),
    ]
    : [
      '/opt/conn/conn',
      '/usr/bin/conn',
    ];
  for (const p of installed) if (p && fs.existsSync(p)) return { bin: p, args: [] };

  // Source checkout: go through the launcher so the sandbox check still runs.
  const repo = path.join(__dirname, '..');
  const launcher = path.join(repo, 'scripts', 'launch.js');
  if (fs.existsSync(path.join(repo, 'node_modules', 'electron')) && fs.existsSync(launcher)) {
    return { bin: 'node', args: [launcher] };
  }
  return null;
}

// A copy installed without root has a chrome-sandbox that is not setuid, and
// Electron aborts rather than quietly running unsandboxed. The launcher script
// makes the same check for a source checkout; this is it for an installed one.
function sandboxArgs(bin) {
  try {
    const st = fs.statSync(path.join(path.dirname(bin), 'chrome-sandbox'));
    if (st.uid === 0 && (st.mode & 0o4000) !== 0) return [];
  } catch {
    return [];
  }
  return ['--no-sandbox'];
}

async function openProject(target) {
  const dir = path.resolve(expand(target || '.'));
  if (!isDir(dir)) die(`${dir} is not a directory`);

  // Already open? Raise it, the way `cursor .` does.
  const open = state.forDir(dir);
  if (open) {
    try {
      const res = await fetch(`${open.url}/focus`, {
        method: 'POST',
        headers: { 'x-conn-token': open.token, 'x-conn-cwd': dir },
      });
      if (res.ok) { process.stdout.write(`focused the window already open on ${dir}\n`); return; }
    } catch { /* dead or wedged: fall through and start a new one */ }
  }

  const app = findApp();
  if (!app) die('cannot find the app. Install it, or set CONN_APP to its binary.');

  const env = { ...process.env, CONN_CWD: dir };
  // A new window gets its own bridge and must not start life as node.
  delete env.CONN_BRIDGE_URL;
  delete env.CONN_TOKEN;
  delete env.CONN_MCP_SERVER;
  delete env.ELECTRON_RUN_AS_NODE;

  const args = [...app.args, ...sandboxArgs(app.bin)];
  const child = spawn(app.bin, args, { cwd: dir, env, detached: true, stdio: 'ignore' });
  child.on('error', (e) => die(`could not start ${app.bin}: ${e.message}`));
  child.unref();
  process.stdout.write(`opening ${dir}\n`);
}

function die(msg) {
  process.stderr.write(`conn: ${msg}\n`);
  process.exit(1);
}

async function call(tool, args) {
  const { url, token } = connection();
  let res;
  try {
    res = await fetch(`${url}/tool/${tool}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-conn-token': token, 'x-conn-cwd': callerCwd() },
      body: JSON.stringify(args || {}),
    });
  } catch (e) {
    die(`cannot reach the preview pane at ${url} (${e.message})`);
  }
  const body = await res.json().catch(() => ({ error: 'bad response' }));
  if (!res.ok || body.error) die(body.error || `request failed (${res.status})`);
  return body.result;
}

// conn click e12 --button right  ->  { target: 'e12', button: 'right' }
function parse(argv, positional) {
  const args = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=');
      const key = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (inline !== undefined) args[key] = coerce(inline);
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) args[key] = coerce(argv[++i]);
      else args[key] = true;
    } else rest.push(a);
  }
  positional.forEach((name, i) => { if (rest[i] !== undefined) args[name] = coerce(rest[i]); });
  if (rest.length > positional.length) args._extra = rest.slice(positional.length);
  return args;
}

const coerce = (v) => (v === 'true' ? true : v === 'false' ? false : v);

const COMMANDS = {
  go: { tool: 'navigate', pos: ['url'], help: 'conn go localhost:3000' },
  navigate: { tool: 'navigate', pos: ['url'], help: 'conn navigate https://example.com' },
  back: { tool: 'back', pos: [], help: 'conn back' },
  forward: { tool: 'forward', pos: [], help: 'conn forward' },
  reload: { tool: 'reload', pos: [], help: 'conn reload' },
  snapshot: { tool: 'snapshot', pos: [], help: 'conn snapshot  (page outline with [ref=eN] handles)' },
  text: { tool: 'text', pos: [], help: 'conn text' },
  html: { tool: 'html', pos: [], help: 'conn html' },
  click: { tool: 'click', pos: ['target'], help: 'conn click e12   |   conn click "button.save"' },
  hover: { tool: 'hover', pos: ['target'], help: 'conn hover e4' },
  fill: { tool: 'fill', pos: ['target', 'value'], help: 'conn fill e3 "user@example.com"' },
  select: { tool: 'select', pos: ['target', 'value'], help: 'conn select e7 "Large"' },
  type: { tool: 'type', pos: ['text'], help: 'conn type "hello" --target e3' },
  press: { tool: 'press', pos: ['key'], help: 'conn press Enter   |   conn press ctrl+a' },
  scroll: { tool: 'scroll', pos: ['dy'], help: 'conn scroll 600' },
  highlight: { tool: 'highlight', pos: ['target'], help: 'conn highlight e9' },
  eval: { tool: 'evaluate', pos: ['code'], help: 'conn eval "document.title"' },
  wait: { tool: 'waitFor', pos: ['selector'], help: 'conn wait ".chart" | conn wait --ms 500 | conn wait --network-idle' },
  shot: { tool: 'screenshot', pos: ['name'], help: 'conn shot --full   |   conn shot --target e2' },
  screenshot: { tool: 'screenshot', pos: ['name'], help: 'conn screenshot --full' },
  viewport: { tool: 'setViewport', pos: ['width', 'height'], help: 'conn viewport 390 844' },
  console: { tool: 'console', pos: [], help: 'conn console --level error --limit 20' },
  network: { tool: 'network', pos: [], help: 'conn network' },
  state: { tool: 'state', pos: [], help: 'conn state' },
  devtools: { tool: 'devtools', pos: [], help: 'conn devtools' },
  preview: { tool: 'preview', pos: ['open'], help: 'conn preview open | close | toggle' },
};

// Register the MCP server with whatever agent is running in this terminal.
function setup(rest) {
  const root = path.join(__dirname, '..');
  const server = process.env.CONN_MCP_SERVER || mcpServerPath(root);
  const target = rest[0] || 'print';
  const command = process.env.CONN_NODE || 'node';
  const entry = { command, args: [server] };

  if (target === 'print') {
    process.stdout.write(
      'Add the preview browser to your agent:\n\n' +
      `  claude mcp add conn -- ${command} ${server}\n\n` +
      'or write it into this project:\n\n' +
      '  conn setup project      # creates or updates ./.mcp.json\n\n' +
      'No MCP? The CLI works on its own: conn go 3000 && conn snapshot\n',
    );
    return;
  }

  if (target === 'project') {
    const file = path.resolve('.mcp.json');
    let json = {};
    try { json = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    json.mcpServers = { ...(json.mcpServers || {}), conn: entry };
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
    process.stdout.write(`wrote ${file}\n`);
    return;
  }

  die(`unknown setup target ${target}. Use: conn setup [print|project]`);
}

function usage() {
  const lines = [
    'Open a project, and drive its preview pane from the terminal.',
    '',
    'open:',
    '  conn .            open this folder in a new window',
    '  conn ~/code/app   open that folder',
    '',
    'commands:',
  ];
  for (const [name, c] of Object.entries(COMMANDS)) lines.push(`  ${name.padEnd(11)} ${c.help}`);
  lines.push(`  ${'setup'.padEnd(11)} conn setup project   (register the MCP server in ./.mcp.json)`);
  lines.push('', 'Typical loop: conn go 3000 && conn snapshot, then act on the [ref=eN] handles.');
  lines.push('Add --json to any command for raw JSON.');
  return lines.join('\n');
}

(async () => {
  const argv = process.argv.slice(2);
  // Let --json sit anywhere, including before the command.
  const wantJsonGlobal = argv.includes('--json');
  const [cmd, ...rest] = argv.filter((a) => a !== '--json');
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(usage() + '\n');
    return;
  }
  if (cmd === 'setup') return setup(rest);
  if (cmd === 'open') return openProject(rest[0]);
  // `conn .` and `conn ~/code/app`, the way `cursor .` works.
  if (!COMMANDS[cmd] && (looksLikePath(cmd) || isDir(cmd))) return openProject(cmd);

  const spec = COMMANDS[cmd];
  if (!spec) die(`unknown command ${cmd}. Try: conn help`);

  const args = parse(rest, spec.pos);
  const wantJson = wantJsonGlobal || args.json === true;
  delete args.json;
  if (spec.tool === 'screenshot' && args.full) { args.fullPage = true; delete args.full; }
  if (spec.tool === 'preview') {
    const word = String(args.open ?? 'toggle');
    args.open = word === 'open' ? true : word === 'close' ? false : undefined;
  }
  if (spec.tool === 'waitFor' && args.selector === undefined && !args.ms && !args.networkIdle) args.networkIdle = true;
  // `conn viewport` with no size means "stop emulating".
  const tool = spec.tool === 'setViewport' && !args.width ? 'clearViewport' : spec.tool;

  const result = await call(tool, args);

  if (wantJson) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else if (typeof result === 'string') process.stdout.write(result + '\n');
  else if (Array.isArray(result)) {
    if (!result.length) process.stdout.write('(empty)\n');
    else for (const r of result) {
      process.stdout.write(typeof r === 'string' ? r + '\n' : `${r.level || r.kind || ''} ${r.message || `${r.status || r.error || ''} ${r.url || ''}`}`.trim() + '\n');
    }
  } else if (result && typeof result === 'object') {
    const compact = Object.entries(result).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join('  ');
    process.stdout.write(compact + '\n');
  } else process.stdout.write(String(result) + '\n');
})().catch((e) => die(e.message));
