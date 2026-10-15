import { query } from '/home/xclore/Applications/conn/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const mode = process.argv[2] || 'live';
const dir = mkdtempSync(join(tmpdir(), 'conn-ckpt-'));
execSync('git init -q', { cwd: dir });
const show = (label) => console.log(label, JSON.stringify({
  a: existsSync(join(dir, 'a.txt')) ? readFileSync(join(dir, 'a.txt'), 'utf8') : null,
  b: existsSync(join(dir, 'b.txt')) ? readFileSync(join(dir, 'b.txt'), 'utf8') : null,
}));
const opts = (extra) => ({
  cwd: dir, model: 'haiku', permissionMode: 'acceptEdits', enableFileCheckpointing: true,
  settingSources: [], ...(process.argv[3] === 'nobash' ? { disallowedTools: ['Bash'] } : {}), pathToClaudeCodeExecutable: '/home/xclore/.local/bin/claude',
  stderr: (d) => process.stderr.write('[stderr] ' + d), ...extra,
});

function channel() {
  const q = []; let wake = null; let done = false;
  return {
    push(m) { q.push(m); wake?.(); },
    end() { done = true; wake?.(); },
    async *iter() {
      while (true) {
        if (!q.length) { if (done) return; await new Promise((r) => { wake = r; }); wake = null; continue; }
        yield q.shift();
      }
    },
  };
}

async function drain(it, until) {
  for (;;) {
    const { value: m, done } = await it.next();
    if (done) return null;
    if (m.type === 'system' && m.subtype === 'init') console.log('init session', m.session_id);
    if (m.type === 'user' && !m.message?.content?.some?.((b) => b.type === 'tool_result'))
      console.log('echoed user msg', { uuid: m.uuid, isReplay: m.isReplay });
    if (m.type === 'result') { console.log('result', m.subtype, 'cost', m.total_cost_usd); if (until === 'result') return m; }
    if (until === 'init' && m.type === 'system' && m.subtype === 'init') return m;
  }
}

const turn = (text, uuid) => ({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '', uuid });
const tryRewind = async (q, id, o, label) => {
  try { console.log(label, JSON.stringify(await q.rewindFiles(id, o))); }
  catch (e) { console.log(label, 'THREW', e.message); }
};

const u1 = randomUUID(); const u2 = randomUUID();
console.log('dir', dir, 'mode', mode, 'u1', u1, 'u2', u2);
const ch = channel();
const q1 = query({ prompt: ch.iter(), options: opts({}) });
const it = q1[Symbol.asyncIterator]();
ch.push(turn('Create a.txt containing exactly: one', u1));
const r1 = await drain(it, 'result'); show('after turn 1');
ch.push(turn('Change a.txt to contain exactly: two. Then create b.txt containing exactly: x', u2));
await drain(it, 'result'); show('after turn 2');
const sid = r1.session_id;

const proj = join(homedir(), '.claude/projects', dir.replace(/[^a-zA-Z0-9]/g, '-'));
try {
  const lines = readFileSync(join(proj, sid + '.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  console.log('transcript user uuids', lines.filter((l) => l.type === 'user' && typeof l.message?.content === 'string').map((l) => l.uuid));
  console.log('transcript snapshot entries', lines.filter((l) => l.type === 'file-history-snapshot').map((l) => ({ messageId: l.messageId, files: Object.keys(l.snapshot?.trackedFileBackups || {}) })));
} catch (e) { console.log('transcript read failed', e.message); }
const fh = join(homedir(), '.claude/file-history', sid);
console.log('file-history dir', fh, existsSync(fh) ? readdirSync(fh) : 'missing');

if (mode === 'live') {
  await tryRewind(q1, u2, { dryRun: true }, 'live dryRun u2');
  show('after live dryRun');
  await tryRewind(q1, u2, undefined, 'live rewind u2');
  show('after live rewind u2');
  await tryRewind(q1, 'not-a-real-id', { dryRun: true }, 'live dryRun bogus id');
  ch.end(); await drain(it);
  await tryRewind(q1, u2, { dryRun: true }, 'rewind on ended query');
} else {
  ch.end(); await drain(it);
  console.log('query 1 ended');
  await tryRewind(q1, u2, { dryRun: true }, 'rewind on ended query');
  const ch2 = channel();
  const q2 = query({ prompt: ch2.iter(), options: opts({ resume: sid, forkSession: false }) });
  const it2 = q2[Symbol.asyncIterator]();
  await new Promise((r) => setTimeout(r, 4000));
  await tryRewind(q2, u2, { dryRun: true }, 'resumed dryRun u2');
  show('after resumed dryRun');
  await tryRewind(q2, u2, undefined, 'resumed rewind u2');
  show('after resumed rewind u2');
  await tryRewind(q2, u1, undefined, 'resumed rewind u1');
  show('after resumed rewind u1');
  ch2.end(); await drain(it2);
}
process.exit(0);
