'use strict';
// Speech to text for the chat box. With no command set, Conn uses its own
// Whisper model. A command replaces that: it reads a 16 kHz mono WAV at
// {file} and prints the words.
//
// The command is split into argv here and run with no shell, so nothing in
// the string is expanded except a leading ~ and {file}. Nothing here throws to
// the renderer: every outcome is { ok: true, ... } or { ok: false, reason }.
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { systemPreferences } = require('electron');

const shellEnv = require('./shell-env');
const builtin = require('./builtin-speech');
const { ensurePrivateDir } = require('./private-dir');
const { SPEECH_RATE, MAX_SECONDS } = require('../shared/speech');

const FILE = '{file}';
const TIMEOUT_MS = 120 * 1000;
const MAX_OUTPUT = 1024 * 1024;
const EXTS = process.platform === 'win32' ? ['.exe', ''] : [''];

// Shell-style words: whitespace separates, quotes group, and outside single
// quotes a backslash escapes the next character. Not on Windows, where a
// backslash is the path separator people will paste.
function words(command) {
  const out = [];
  let word = null;
  let quote = null;
  const escapes = process.platform !== 'win32';
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && escapes && quote === '"' && i + 1 < command.length) word += command[++i];
      else word += c;
    } else if (/\s/.test(c)) {
      if (word !== null) out.push(word);
      word = null;
    } else if (c === '"' || c === "'") {
      quote = c;
      word = word ?? '';
    } else if (c === '\\' && escapes && i + 1 < command.length) {
      word = (word ?? '') + command[++i];
    } else {
      word = (word ?? '') + c;
    }
  }
  if (quote) return null;
  if (word !== null) out.push(word);
  return out;
}

const home = (arg) => (arg === '~' || arg.startsWith('~/') ? path.join(os.homedir(), arg.slice(1)) : arg);

function findProgram(name) {
  if (name.includes('/') || name.includes(path.sep)) {
    return fs.existsSync(name) ? name : null;
  }
  for (const dir of shellEnv.cached().split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of EXTS) {
      const candidate = path.join(dir, name + ext);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function parse(command) {
  if (typeof command !== 'string' || !command.trim()) {
    return { ok: false, reason: 'No dictation command is set.' };
  }
  const argv = words(command.trim());
  if (!argv) return { ok: false, reason: 'The dictation command has a quote that is never closed.' };
  if (!argv.some((a) => a.includes(FILE))) {
    return { ok: false, reason: `The dictation command needs ${FILE} where the recording goes.` };
  }
  const [name, ...args] = argv.map(home);
  const program = findProgram(name);
  if (!program) return { ok: false, reason: `${name} was not found on your PATH.` };
  return { ok: true, program, args };
}

async function macMic() {
  if (process.platform !== 'darwin') return { ok: true };
  const granted = await systemPreferences.askForMediaAccess('microphone').catch(() => false);
  if (granted) return { ok: true };
  return { ok: false, reason: 'Conn is not allowed to use the microphone. Allow it in System Settings › Privacy & Security › Microphone.' };
}

// Ready to listen. An empty command is Conn's own model, which starts loading
// now so the first take is not waiting on a download. A command is checked
// before anyone speaks. On macOS the OS permission is asked here too.
async function arm(command) {
  if (!String(command || '').trim()) {
    builtin.warm().catch(() => {});
    return macMic();
  }
  const parsed = parse(command);
  if (!parsed.ok) return parsed;
  return macMic();
}

// The IPC payload is untrusted: an Int16Array, or its bytes as a Buffer.
function samplesOf(audio) {
  let samples = null;
  if (audio instanceof Int16Array) samples = audio;
  else if (Buffer.isBuffer(audio) && audio.length % 2 === 0) samples = new Int16Array(Uint8Array.from(audio).buffer);
  if (!samples || !samples.length || samples.length > MAX_SECONDS * SPEECH_RATE) return null;
  return samples;
}

function wav(samples) {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(SPEECH_RATE, 24);
  head.writeUInt32LE(SPEECH_RATE * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

// whisper.cpp marks silence and noise as [BLANK_AUDIO], [MUSIC], (wind) and
// the like. None of that is something the person said.
function clean(stdout) {
  return stdout
    .replace(/\[[^\]\n]*\]/g, ' ')
    .split('\n')
    .filter((line) => !/^\s*\([^)]*\)\s*$/.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function run(program, args) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let child;
    try {
      child = spawn(program, args, { env: shellEnv.env(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      resolve({ ok: false, reason: `Could not run ${path.basename(program)}: ${e.message}` });
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ ok: false, reason: `${path.basename(program)} took longer than two minutes and was stopped.` });
    }, TIMEOUT_MS);
    child.stdout.on('data', (d) => { if (stdout.length < MAX_OUTPUT) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < MAX_OUTPUT) stderr += d; });
    child.on('error', (e) => done({ ok: false, reason: `Could not run ${path.basename(program)}: ${e.message}` }));
    child.on('close', (code) => {
      if (code === 0) return done({ ok: true, stdout });
      const last = stderr.trim().split('\n').pop();
      done({ ok: false, reason: `${path.basename(program)} exited with code ${code}${last ? `: ${last}` : '.'}` });
    });
  });
}

let takes = 0;

async function transcribe(command, audio) {
  const samples = samplesOf(audio);
  if (!samples) return { ok: false, reason: `The recording was empty or longer than ${MAX_SECONDS / 60} minutes.` };
  if (!String(command || '').trim()) {
    try {
      return { ok: true, text: await builtin.transcribe(samples) };
    } catch (e) {
      return { ok: false, reason: `Couldn't run Conn's speech model: ${e.message}` };
    }
  }
  const parsed = parse(command);
  if (!parsed.ok) return parsed;
  let file = null;
  try {
    file = path.join(ensurePrivateDir('conn-dictation'), `take-${process.pid}-${Date.now()}-${takes += 1}.wav`);
    await fsp.writeFile(file, wav(samples), { mode: 0o600 });
    const out = await run(parsed.program, parsed.args.map((a) => a.split(FILE).join(file)));
    return out.ok ? { ok: true, text: clean(out.stdout) } : out;
  } catch (e) {
    return { ok: false, reason: `Dictation failed: ${e.message}` };
  } finally {
    if (file) await fsp.rm(file, { force: true }).catch(() => {});
  }
}

module.exports = { arm, transcribe };
