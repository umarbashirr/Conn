'use strict';
// Session history. The claude binary already writes every session to
// ~/.claude/projects/<slug>/<id>.jsonl, and those lines carry the same message
// shape the panel renders. So we list and replay those rather than keeping a
// second copy that would drift from what `claude --resume` sees.
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { execFile } = require('child_process');
const { chatTitle, TITLE_MAX } = require('../shared/chat-title');
const chatTitles = require('./chat-titles');
const shellEnv = require('./shell-env');
const { parseQuery, snippetOf } = require('./transcript-search');
const { windowOf, MAX_MESSAGES } = require('./transcript-clip');

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');

// Claude Code slugifies a cwd by replacing / and . with -.
const slugFor = (cwd) => cwd.replace(/[/.]/g, '-');

// One entry per project. This was a single cwd for as long as a window held a
// single folder, and the rail now asks about every project that is open: with
// one slot, a list of four projects missed on all four every time, and a miss
// can fall through to scanForCwd, which reads a line out of every directory
// under ~/.claude/projects.
const dirs = new Map();

function projectDir(cwd) {
  const hit = dirs.get(cwd);
  if (hit) return hit;
  let dir = path.join(PROJECTS, slugFor(cwd));
  if (!fs.existsSync(dir)) dir = scanForCwd(cwd) || dir;
  dirs.set(cwd, dir);
  return dir;
}

// If that slug rule ever changes, fall back to reading one line out of each
// candidate directory and matching the cwd it recorded.
function scanForCwd(cwd) {
  let entries = [];
  try { entries = fs.readdirSync(PROJECTS, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(PROJECTS, e.name);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    if (!files.length) continue;
    for (const o of parseHead(path.join(dir, files[0]), 1 << 15)) {
      if (!o.cwd) continue;
      if (o.cwd === cwd) return dir;
      break; // this directory belongs to another project
    }
  }
  return null;
}

// Read the front of a jsonl file without pulling a 500KB transcript into memory.
// The budget bounds where a line starts, not where it ends. A chat opened with a
// pasted image has a 300KB first message, and cut at the budget it never parsed,
// so the chat had no title and stayed off the rail.
function* parseHead(file, bytes) {
  let buf;
  try {
    const fd = fs.openSync(file, 'r');
    buf = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buf, 0, bytes, 0);
    const parts = [buf.subarray(0, read)];
    let at = read;
    let more = read === bytes && buf[read - 1] !== 0x0a;
    while (more) {
      const chunk = Buffer.alloc(1 << 16);
      const n = fs.readSync(fd, chunk, 0, chunk.length, at);
      const nl = chunk.subarray(0, n).indexOf(0x0a);
      parts.push(chunk.subarray(0, nl < 0 ? n : nl));
      at += n;
      more = n > 0 && nl < 0;
    }
    fs.closeSync(fd);
    buf = Buffer.concat(parts);
  } catch { return; }
  // No pop of the last line: a JSON.parse that fails is already skipped below,
  // and dropping it unread loses a chat whose only line was caught before its
  // newline landed. That chat then vanished from the rail until the next write.
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch { /* skip */ }
  }
}

const strip = (s) => s
  .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
  .replace(/\s+/g, ' ')
  .trim();

// The first thing a person actually typed, which makes a better title than a
// slash command echo or a tool result. Returned with its line breaks, which is
// how chatTitle tells an attachment block from the text typed under it.
function humanText(o) {
  if (o.type !== 'user' || o.isSidechain || o.isMeta) return null;
  const c = o.message?.content;
  const raw = typeof c === 'string' ? c
    : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n')
      : '';
  const kept = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  const text = strip(kept);
  if (!text) return null;
  if (/^<(command-name|command-message|command-args|local-command|bash-input|bash-stdout|bash-stderr|user-prompt|ide_)/.test(text)) return null;
  if (/^(Caveat|\[Request interrupted)/.test(text)) return null;
  if (text.startsWith('Caveat:')) return null;
  return kept;
}

// A chat opened with a slash command, as the person typed it. humanText turns
// these down because a replay would draw the tags, but for a title it is still
// the first thing typed, and the next prompt is often past the read budget.
function typedCommand(o) {
  if (o.type !== 'user' || o.isSidechain || o.isMeta || typeof o.message?.content !== 'string') return null;
  const c = o.message.content;
  const name = c.match(/<command-name>([^<]*)<\/command-name>/)?.[1].trim();
  if (!name) return null;
  const args = c.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1].trim();
  return args ? `${name} ${args}` : name;
}

// Claude's resume picker reads 64KB at each end of the transcript. The same
// budget here, so a name it would show is a name we show.
const TAIL_BYTES = 65536;

// A later /rename grows the transcript or rewrites custom-title.json.
const titles = new Map();

function readAt(file, start, length) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

function edge(file, size, fromEnd) {
  const length = Math.min(size, TAIL_BYTES);
  const start = fromEnd ? size - length : 0;
  return readAt(file, start, length);
}

// Last `"key":"..."` in the slice. Claude walks the same way, last one wins,
// and a line that began before the slice still counts when the value is inside it.
function lastString(text, key) {
  if (!text) return '';
  const markers = [`"${key}":"`, `"${key}": "`];
  let best = '';
  let at = -1;
  for (const marker of markers) {
    let from = 0;
    while (from < text.length) {
      const i = text.indexOf(marker, from);
      if (i < 0) break;
      const start = i + marker.length;
      let c = start;
      while (c < text.length) {
        if (text[c] === '\\') { c += 2; continue; }
        if (text[c] === '"') {
          if (i > at) {
            at = i;
            try { best = JSON.parse(`"${text.slice(start, c)}"`); } catch { best = ''; }
          }
          break;
        }
        c++;
      }
      from = c + 1;
    }
  }
  return typeof best === 'string' ? best.trim() : '';
}

function lastSummary(text) {
  if (!text) return '';
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"summary"')) continue;
    if (!line.includes('"type":"summary"') && !line.includes('"type": "summary"')) continue;
    try {
      const o = JSON.parse(line);
      if (o.type === 'summary' && typeof o.summary === 'string' && o.summary.trim()) return o.summary.trim();
    } catch {}
  }
  return '';
}

// custom-title.json sits next to the transcript, in the session directory
// Claude already uses for subagent metadata.
function sidecarOf(full) {
  const file = path.join(path.dirname(full), path.basename(full, '.jsonl'), 'custom-title.json');
  let st;
  try { st = fs.statSync(file); } catch { return { mtime: 0, title: '' }; }
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8'));
    const title = typeof o.customTitle === 'string' ? o.customTitle.trim() : '';
    return { mtime: st.mtimeMs, title };
  } catch {
    return { mtime: st.mtimeMs, title: '' };
  }
}

// The order Claude uses when it builds the name `claude --resume` shows.
// A custom title in the tail beats the sidecar, which beats one in the head,
// then the generated title, then a summary.
function claudeName(full, size, sideTitle) {
  const tail = edge(full, size, true);
  const head = size <= TAIL_BYTES ? tail : edge(full, size, false);
  return lastString(tail, 'customTitle')
    || sideTitle
    || lastString(head, 'customTitle')
    || lastString(tail, 'aiTitle')
    || lastString(head, 'aiTitle')
    || lastSummary(tail)
    || '';
}

function titleOf(full, size) {
  const side = sidecarOf(full);
  const hit = titles.get(full);
  if (hit && hit.size === size && hit.sidecarMtime === side.mtime) return hit.title;

  const named = claudeName(full, size, side.title);
  if (named) {
    titles.set(full, { title: named, size, sidecarMtime: side.mtime });
    return named;
  }

  let title = null;
  let bare = null;
  for (const o of parseHead(full, 1 << 17)) {
    title = humanText(o);
    if (title) break;
    // A command with nothing after it, like the /clear that opens the session
    // a clear starts, names the chat only when nothing typed follows it.
    const command = typedCommand(o);
    if (command && /\s/.test(command)) { title = command; break; }
    bare ||= command;
  }
  const picked = title || bare;
  titles.set(full, { title: picked, size, sidecarMtime: side.mtime });
  return picked;
}

function historyDirs(cwd) {
  const out = [];
  const add = (dir) => { if (dir && !out.includes(dir)) out.push(dir); };
  add(projectDir(cwd));
  try {
    const real = fs.realpathSync(cwd);
    if (real !== cwd) {
      const alt = path.join(PROJECTS, slugFor(real));
      if (fs.existsSync(alt)) add(alt);
    }
  } catch {}
  return out;
}

function sessionFiles(cwd) {
  const files = [];
  for (const dir of historyDirs(cwd)) {
    let names = [];
    try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const name of names) files.push(path.join(dir, name));
  }
  return files;
}

// The rail groups by day and searches across the lot, so the limit is high on
// purpose. It used to be 40, and with more transcripts than that the ones near
// the cut-off dropped off the list every time another chat was written to and
// came back the next time the order moved.
function listSessions(cwd, limit = 200) {
  const byId = new Map();
  for (const full of sessionFiles(cwd)) {
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (!st.size) continue;

    const title = titleOf(full, st.size);
    if (!title) continue;

    const id = path.basename(full, '.jsonl');
    const prev = byId.get(id);
    if (prev && prev.at >= st.mtimeMs) continue;
    byId.set(id, { id, title: chatTitle(title).slice(0, TITLE_MAX), at: st.mtimeMs });
  }
  return [...byId.values()].sort((a, b) => b.at - a.at).slice(0, limit);
}

function located(cwd, id) {
  const name = `${id}.jsonl`;
  for (const dir of historyDirs(cwd)) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return { dir, file };
  }
  const dir = projectDir(cwd);
  return { dir, file: path.join(dir, name) };
}

// Deleting a chat for good. The transcript is the chat: drop the file and
// `claude --resume` stops offering it, the rail stops listing it, and nothing
// here has a second copy to go stale. A session that spawned agents or wrote a
// long tool result also has a sibling folder of its own.
//
// The id has to be a session uuid before anything is unlinked. That folder also
// holds memory/ and every other chat in this project, and a caller passing a
// chat key or a stray path is a bug that would take one of those with it.
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function deleteSession(cwd, id) {
  if (!SESSION_ID.test(String(id || ''))) throw new Error(`not a session id: ${id}`);
  const { dir, file } = located(cwd, id);

  let gone = false;
  try {
    fs.rmSync(file);
    gone = true;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  // Subagent transcripts and spilled tool results. Missing for most chats.
  try {
    fs.rmSync(path.join(dir, id), { recursive: true, force: true });
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  titles.delete(file);
  return gone;
}

const SCAN_BATCH = 8;
const PARSE_BATCH = 4;
// A word a tool printed matches a file without being a hit, so a search reads
// every candidate in full. This bounds that read, newest chats first.
const SEARCH_BYTES = 64 << 20;
const SEARCH_FILES = 500;

const aborted = (signal) => !!signal?.aborted;

// ripgrep exits 1 when nothing matched; that is an answer, not a failure.
function rgFiles(files, needle, signal) {
  return new Promise((resolve) => {
    execFile('rg', ['--no-config', '--no-ignore', '-l', '-i', '-F', '-e', needle, '--', ...files],
      { env: shellEnv.env(), timeout: 10000, maxBuffer: 8 << 20, signal },
      (err, out) => {
        if (err && err.code !== 1) return resolve(null);
        resolve(new Set(String(out).split('\n').filter(Boolean)));
      });
  });
}

function fileHas(file, needle, signal) {
  return new Promise((resolve) => {
    const stream = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 18 });
    let tail = '';
    let found = false;
    stream.on('data', (chunk) => {
      const hay = (tail + chunk).toLowerCase();
      if (aborted(signal) || hay.includes(needle)) {
        found = !aborted(signal);
        stream.destroy();
        return;
      }
      tail = needle.length > 1 ? hay.slice(1 - needle.length) : '';
    });
    stream.on('error', () => resolve(false));
    stream.on('close', () => resolve(found));
  });
}

async function scanFiles(files, needle, signal) {
  const out = new Set();
  for (let i = 0; i < files.length && !aborted(signal); i += SCAN_BATCH) {
    const batch = files.slice(i, i + SCAN_BATCH);
    const hits = await Promise.all(batch.map((f) => fileHas(f, needle, signal)));
    batch.forEach((f, k) => { if (hits[k]) out.add(f); });
  }
  return out;
}

function recent(cwd, bytes) {
  const all = [];
  for (const file of sessionFiles(cwd)) {
    try {
      const st = fs.statSync(file);
      if (st.size) all.push({ file, size: st.size, at: st.mtimeMs });
    } catch {}
  }
  all.sort((a, b) => b.at - a.at);
  const kept = [];
  let used = 0;
  for (const f of all) {
    if (kept.length >= SEARCH_FILES) break;
    if (f.size > bytes) continue;
    if (used + f.size > bytes) break;
    kept.push(f);
    used += f.size;
  }
  return { kept, total: all.length };
}

function saidIn(o) {
  if (o.isSidechain || o.isMeta || o.isCompactSummary) return '';
  if (o.type === 'user') return humanText(o) || '';
  if (o.type !== 'assistant' || o.isApiErrorMessage) return '';
  const c = o.message?.content;
  if (typeof c === 'string') return c;
  return Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n') : '';
}

async function firstHit(file, { q, needle }, signal) {
  const stream = fs.createReadStream(file);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (aborted(signal)) return null;
      if (!line.toLowerCase().includes(needle)) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      const snippet = snippetOf(saidIn(o), q);
      if (snippet) return snippet;
    }
  } catch {} finally {
    rl.close();
    stream.destroy();
  }
  return null;
}

async function search(cwd, query, { limit = 20, signal, bytes = SEARCH_BYTES } = {}) {
  const parsed = parseQuery(query);
  const none = { hits: [], searched: 0, left: 0 };
  if (!parsed) return none;
  await shellEnv.ready();
  const { kept, total } = recent(cwd, bytes);
  if (!kept.length) return { ...none, left: total };
  const names = kept.map((f) => f.file);
  const matched = (await rgFiles(names, parsed.needle, signal)) ?? await scanFiles(names, parsed.needle, signal);

  const candidates = kept.filter((f) => matched.has(f.file));
  const hits = [];
  for (let i = 0; i < candidates.length && hits.length < limit && !aborted(signal); i += PARSE_BATCH) {
    const batch = candidates.slice(i, i + PARSE_BATCH);
    const snippets = await Promise.all(batch.map((f) => firstHit(f.file, parsed, signal)));
    batch.forEach((f, k) => {
      if (!snippets[k] || hits.length >= limit) return;
      const id = path.basename(f.file, '.jsonl');
      const title = chatTitles.get(id) || titleOf(f.file, f.size);
      hits.push({
        id,
        title: title ? chatTitle(title).slice(0, TITLE_MAX) : '',
        at: f.at,
        snippet: snippets[k],
      });
    });
  }
  return aborted(signal) ? none : { hits, searched: kept.length, left: total - kept.length };
}

const MAX_TEXT = 6000;
const MAX_IMAGES = 12;

// Trim a stored message down to something worth sending over IPC. Screenshots
// are the expensive part, so keep the most recent handful and stub the rest.
function slim(msg, budget) {
  const c = msg.message?.content;
  if (!Array.isArray(c)) return msg;
  const content = c.map((b) => {
    if (b.type === 'image') {
      if (budget.images <= 0) return { type: 'text', text: '[screenshot omitted from replay]' };
      budget.images -= 1;
      return b;
    }
    if (b.type === 'tool_result' && Array.isArray(b.content)) {
      return { ...b, content: b.content.map((inner) => slimBlock(inner, budget)) };
    }
    return slimBlock(b, budget);
  });
  return { ...msg, message: { ...msg.message, content } };
}

function slimBlock(b, budget) {
  if (b.type === 'image') {
    if (budget.images <= 0) return { type: 'text', text: '[screenshot omitted from replay]' };
    budget.images -= 1;
    return b;
  }
  if (typeof b.text === 'string' && b.text.length > MAX_TEXT) {
    return { ...b, text: b.text.slice(0, MAX_TEXT) + '\n… truncated' };
  }
  return b;
}

// Replayable messages for one session, oldest first.
async function readSession(cwd, id, { whole, ...opts } = {}) {
  const { file } = located(cwd, id);
  if (!fs.existsSync(file)) throw new Error(`no transcript for session ${id}`);

  const out = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.isSidechain || o.isMeta) continue;         // subagent traffic and bookkeeping
    if (o.type !== 'user' && o.type !== 'assistant') continue;
    if (!o.message) continue;
    if (o.type === 'user' && !humanText(o) && !hasToolResult(o)) continue;
    // What an Agent call came back with: how long it ran, how much it did, and
    // what it concluded. Cheaper and more exact than parsing the result text.
    const agent = o.toolUseResult?.agentId ? summarise(o.toolUseResult) : null;
    const failed = o.isApiErrorMessage ? { error: o.error || 'unknown' } : {};
    out.push({ type: o.type, message: o.message, at: o.timestamp, uuid: o.uuid, ...failed, ...(agent ? { agent } : {}) });
  }

  if (whole) return { id, total: out.length, truncated: false, messages: out };

  const budget = { images: MAX_IMAGES };
  const { messages: tail, ...w } = windowOf(out, opts);
  // Spend the screenshot budget from the newest message backwards: the recent
  // ones are the ones worth looking at.
  const slimmed = [];
  for (let i = tail.length - 1; i >= 0; i--) slimmed[i] = slim(tail[i], budget);
  return { id, ...w, messages: slimmed };
}

const hasToolResult = (o) =>
  Array.isArray(o.message?.content) && o.message.content.some((b) => b.type === 'tool_result');

async function* entries(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch { /* a line still being written */ }
  }
}

// Where a conversation picks up when the person edits or retries `uuid`: the
// entry it was written after. Null when nothing was said before it, so there
// is nothing to keep.
async function parentOf(file, uuid) {
  let said = false;
  for await (const o of entries(file)) {
    if (o.uuid === uuid && o.type === 'user') return { parent: said ? o.parentUuid || null : null };
    if (!o.isSidechain && (o.type === 'user' || o.type === 'assistant')) said = true;
  }
  return null;
}

// The SDK is ESM only, and Electron's require cannot load it.
const sdk = () => import('@anthropic-ai/claude-agent-sdk');

// The CLI writes a turn to its transcript a beat after the turn ends, so a
// message sent moments ago may not be on disk yet.
const LANDS_WITHIN = 3000;

// A new session holding the transcript up to just before `uuid`, for the chat
// to carry on from. The old transcript is left as it was. Every message in the
// fork gets a fresh uuid, so `uuids` maps the old ids of the person's messages
// to the new ones.
async function forkBefore(cwd, id, uuid) {
  if (!SESSION_ID.test(String(id || ''))) throw new Error(`not a session id: ${id}`);
  if (!SESSION_ID.test(String(uuid || ''))) throw new Error(`not a message id: ${uuid}`);
  const dir = projectDir(cwd);
  const file = path.join(dir, `${id}.jsonl`);
  let at = null;
  for (const end = Date.now() + LANDS_WITHIN; !at && Date.now() < end;) {
    at = fs.existsSync(file) ? await parentOf(file, uuid) : null;
    if (!at) await new Promise((r) => setTimeout(r, 200));
  }
  if (!at) throw new Error(`message ${uuid} is not in session ${id}`);
  if (!at.parent) return { sessionId: null, uuids: {} };

  const { forkSession } = await sdk();
  const { sessionId } = await forkSession(id, { dir: cwd, upToMessageId: at.parent });
  const uuids = {};
  for await (const o of entries(path.join(dir, `${sessionId}.jsonl`))) {
    if (o.type === 'user' && o.forkedFrom?.messageUuid) uuids[o.forkedFrom.messageUuid] = o.uuid;
  }
  return { sessionId, uuids };
}

// The parts of an Agent tool's result worth drawing. The rest is usage
// accounting the panel has nowhere to put.
const summarise = (r) => ({
  id: r.agentId,
  type: r.agentType || 'agent',
  tools: r.totalToolUseCount ?? 0,
  ms: r.totalDurationMs ?? 0,
  tokens: r.totalTokens ?? 0,
  stats: r.toolStats || null,
  status: r.status || 'completed',
});

// Each subagent gets its own file next to the session, with a meta.json naming
// it. Listing the metas is enough to draw every agent row on a replayed chat
// without reading a single transcript.
function subagentDir(cwd, session) {
  return path.join(located(cwd, session).dir, session, 'subagents');
}

function listSubagents(cwd, session) {
  const dir = subagentDir(cwd, session);
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.meta.json')); } catch { return []; }
  const out = [];
  for (const name of names) {
    let meta;
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { continue; }
    out.push({
      id: name.replace(/^agent-/, '').replace(/\.meta\.json$/, ''),
      type: meta.agentType || 'agent',
      description: meta.description || '',
      toolUseId: meta.toolUseId || null,
      depth: meta.spawnDepth || 1,
    });
  }
  return out;
}

// One subagent's own transcript, read only when someone opens its row. Nobody
// pays for the ten agents they did not click on.
async function readSubagent(cwd, session, agentId) {
  const file = path.join(subagentDir(cwd, session), `agent-${agentId}.jsonl`);
  if (!fs.existsSync(file)) throw new Error(`no transcript for agent ${agentId}`);

  const out = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.isMeta) continue;
    if (o.type !== 'user' && o.type !== 'assistant') continue;
    if (!o.message) continue;
    out.push({ type: o.type, message: o.message, at: o.timestamp });
  }

  const budget = { images: MAX_IMAGES };
  const tail = out.slice(-MAX_MESSAGES);
  const slimmed = [];
  for (let i = tail.length - 1; i >= 0; i--) slimmed[i] = slim(tail[i], budget);
  // The first line is the prompt the parent handed it, which the Agent row
  // already shows as its summary.
  return { id: agentId, truncated: out.length > tail.length, messages: slimmed };
}

module.exports = { listSessions, search, readSession, readSubagent, listSubagents, deleteSession, forkBefore, projectDir, LANDS_WITHIN };
