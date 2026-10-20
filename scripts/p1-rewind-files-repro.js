'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = process.env.CONN_ROOT || path.join(__dirname, '..');
const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
};
const until = async (fn, ms = 5000, every = 100) => {
  const end = Date.now() + ms;
  let got;
  while (Date.now() < end && !(got = await fn())) await sleep(every);
  return got;
};
const SHOT = (name) => path.join(os.tmpdir(), `conn-rewind-files-${name}.png`);

for (const k of Object.keys(process.env)) if (/^(CLAUDE|ANTHROPIC)/.test(k) && k !== 'CLAUDE_BIN') delete process.env[k];

async function onAgentSession(bin, api) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-rewind-files-'));
  const cwd = path.join(home, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd });
  Object.assign(process.env, { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude') });
  const { server, port } = await api.serve({ project: cwd });
  Object.assign(process.env, {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_API_KEY: 'sk-ant-conn-rewind-files',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  });
  require(path.join(ROOT, 'src/main/driver.js')).preferBinary(bin);
  const { AgentSession } = require(path.join(ROOT, 'src/main/agent.js'));

  const files = () => J(Object.fromEntries(['a', 'b'].map((f) => {
    const p = path.join(cwd, `${f}.txt`);
    return [f, fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null];
  })));
  const sessions = [];
  const open = async (resume) => {
    const s = new AgentSession({ cwd, resume, model: 'claude-sonnet-4-5' });
    s.results = 0;
    s.on('message', (m) => { if (m.type === 'result') s.results += 1; });
    s.on('permission', (p) => s.decide(p.id, 'allow'));
    sessions.push(s);
    await s.start();
    return s;
  };
  const turn = async (s, text) => {
    const want = s.results + 1;
    const uuid = s.send(text);
    if (!await until(() => s.results >= want, 60000, 50)) throw new Error(`no result for ${J(text)}`);
    return uuid;
  };
  const call = (s, method, ...args) => Promise.resolve().then(() => s[method](...args)).catch((e) => ({ threw: e.message }));
  const sorted = (r) => J([...(r?.files || [])].sort());
  const empty = (r) => !r.error && Array.isArray(r.files) && !r.files.length;
  const stderr = [];

  try {
    const s1 = await open(null);
    s1.on('stderr', (d) => stderr.push(String(d)));
    await turn(s1, 'write a.txt: one');
    const second = await turn(s1, 'edit a.txt: one => two\nwrite b.txt: x');
    const shell = await turn(s1, 'bash: printf z > c.txt');
    check('turns-edit-the-files', files() === J({ a: 'two', b: 'x' }) && fs.existsSync(path.join(cwd, 'c.txt')), files());

    const raw = await s1.query.rewindFiles(second, { dryRun: true }).catch((e) => ({ threw: e.message }));
    check('checkpointing-is-on-with-conns-env', raw.canRewind === true && raw.filesChanged?.length === 2, J(raw));
    const since = await call(s1, 'editsSince', second);
    check('edits-since-names-the-files-from-the-project', sorted(since) === J(['a.txt', 'b.txt']), J(since));
    check('edits-since-changes-nothing', files() === J({ a: 'two', b: 'x' }), files());
    const shellOnly = await call(s1, 'editsSince', shell);
    check('shell-only-turn-tracks-nothing', empty(shellOnly), J(shellOnly));
    const unknown = await call(s1, 'editsSince', '00000000-0000-4000-8000-000000000000');
    check('unknown-message-is-an-error-not-a-throw', !!unknown.error && !unknown.threw, J(unknown));

    const id = s1.sessionId;
    s1.stop();
    await sleep(500);
    const ended = await call(s1, 'editsSince', second);
    check('ended-session-answers-with-an-error', !!ended.error && !ended.threw, J(ended));

    const s2 = new AgentSession({ cwd, resume: id, model: 'claude-sonnet-4-5' });
    s2.results = 0;
    s2.on('message', (m) => { if (m.type === 'result') s2.results += 1; });
    s2.on('permission', (p) => s2.decide(p.id, 'allow'));
    s2.on('stderr', (d) => stderr.push(String(d)));
    sessions.push(s2);
    const starting = s2.start();
    const early = await call(s2, 'editsSince', second);
    check('edits-since-waits-for-the-start', sorted(early) === J(['a.txt', 'b.txt']), J(early));
    await starting;
    check('resumed-session-is-idle', !s2.busy, 'busy with no turn sent');
    const undone = await call(s2, 'undoEdits', second);
    check('undo-puts-the-files-back', sorted(undone) === J(['a.txt', 'b.txt']) && files() === J({ a: 'one', b: null }), `${J(undone)} ${files()}`);
    check('undo-leaves-untracked-files', fs.existsSync(path.join(cwd, 'c.txt')), 'c.txt is gone');
    const again = await call(s2, 'undoEdits', second);
    check('second-undo-is-a-no-op', empty(again) && files() === J({ a: 'one', b: null }), J(again));

    const want = s2.results + 1;
    s2.send('wait 3');
    await sleep(300);
    const busy = await call(s2, 'editsSince', second);
    check('refuses-while-a-turn-runs', /working/.test(busy.error || ''), J(busy));
    await until(() => s2.results >= want, 20000, 50);
    check('stderr-has-no-transport-error', !/ProcessTransport/.test(stderr.join('')), stderr.join('').slice(-400));
  } catch (e) {
    check('agent-session-run', false, e.stack || e.message);
  } finally {
    for (const s of sessions) s.stop();
    server.close();
    await sleep(500);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

async function inTheApp() {
  const drive = await import(pathToFileURL(path.join(ROOT, '.claude/skills/verify/drive.mjs')).href);
  const { boot, stop, evaluate, click, hover, shot, type, heldBy } = drive;
  const s = await boot({ root: ROOT, xvfb: true, claude: true });
  const html = path.join(s.project, 'index.html');
  const original = fs.readFileSync(html, 'utf8');
  try {
    const transcript = () => evaluate(s, `document.querySelector('#agent-root').innerText`);
    const results = async () => ((await transcript()).match(/done in/g) || []).length;
    const send = async (text) => {
      await evaluate(s, `document.querySelector('#agent-root [contenteditable="true"]').focus()`);
      await type(s, text, { enter: true });
    };
    const allow = () => until(async () => {
      if (!/Allow Edit\?|Allow Write\?|Allow Bash\?/.test(await transcript())) return false;
      await click(s, 'Allow');
      return true;
    }, 20000, 250);
    const undo = (row) => evaluate(s, `(() => {
      const rows = [...document.querySelectorAll('#agent-root .is-user')];
      const b = rows[${row}] && [...rows[${row}].querySelectorAll('button')].find((e) => /Undo edits/.test(e.getAttribute('aria-label') || e.title || e.innerText));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { at: Math.round(r.x + r.width / 2) + ',' + Math.round(r.y + r.height / 2), text: [b.innerText, b.title, b.getAttribute('aria-label')].join(' | '), disabled: b.disabled };
    })()`);
    const hoverRow = async (row) => {
      const at = await evaluate(s, `(() => {
        const r = [...document.querySelectorAll('#agent-root .is-user')][${row}]?.getBoundingClientRect();
        return r ? Math.round(r.x + r.width / 2) + ',' + Math.round(r.y + r.height / 2) : null;
      })()`);
      if (at) await hover(s, `xy=${at}`);
    };
    const dialog = () => evaluate(s, `document.querySelector('[role=dialog]')?.innerText || null`);
    const dialogButton = (name) => evaluate(s, `(() => {
      const b = [...document.querySelectorAll('[role=dialog] button')].find((e) => e.innerText.trim().startsWith(${J(name)}));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return Math.round(r.x + r.width / 2) + ',' + Math.round(r.y + r.height / 2);
    })()`);
    const clis = () => heldBy(s).filter((p) => {
      try { return fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0').includes('stream-json'); } catch { return false; }
    });

    await click(s, 'Later').catch(() => {});
    await send('edit index.html: <h1>Your cart</h1> => <h1>Your basket</h1>');
    await allow();
    await until(async () => (await results()) >= 1, 30000, 250);
    check('agent-edited-index-html', /Your basket/.test(fs.readFileSync(html, 'utf8')), 'index.html unchanged');

    await hoverRow(0);
    const shown = await until(() => undo(0), 3000);
    await shot(s, SHOT('hover'));
    check('hover-shows-undo-edits-with-one-file', !!shown && /1 file/.test(shown.text), J(shown));

    if (shown) {
      await click(s, `xy=${shown.at}`);
      const asked = await until(dialog, 3000);
      await shot(s, SHOT('dialog'));
      check('dialog-names-the-file', /index\.html/.test(asked || ''), J(asked));
      check('dialog-says-later-turns-are-undone', /later/i.test(asked || ''), J(asked));
      check('dialog-says-the-conversation-stays', /conversation/i.test(asked || ''), J(asked));
      const edited = fs.readFileSync(html, 'utf8');
      const cancel = await dialogButton('Cancel');
      if (cancel) await click(s, `xy=${cancel}`);
      check('cancel-closes-the-dialog', !!cancel && !!await until(async () => !(await dialog()), 3000), J(await dialog()));
      check('cancel-leaves-index-html', fs.readFileSync(html, 'utf8') === edited, fs.readFileSync(html, 'utf8').match(/<h1>.*<\/h1>/)?.[0]);
      await hoverRow(0);
      const again = await until(() => undo(0), 3000);
      if (again) await click(s, `xy=${again.at}`);
      check('dialog-opens-again-after-cancel', !!await until(dialog, 3000), J(again));
      const confirm = await dialogButton('Undo');
      if (confirm) await click(s, `xy=${confirm}`);
      const restored = await until(() => fs.readFileSync(html, 'utf8') === original, 5000);
      await shot(s, SHOT('restored'));
      check('undo-restores-index-html', restored, fs.readFileSync(html, 'utf8').match(/<h1>.*<\/h1>/)?.[0]);
      check('conversation-text-stays', /Your basket/.test(await transcript()), 'the edit turn left the transcript');
    }

    await send('bash: printf hi > shell-only.txt');
    await allow();
    await until(async () => (await results()) >= 2, 30000, 250);
    check('shell-turn-wrote-its-file', fs.existsSync(path.join(s.project, 'shell-only.txt')), 'no shell-only.txt');
    await hoverRow(1);
    await sleep(1000);
    check('shell-only-turn-has-no-undo', !(await undo(1)), J(await undo(1)));
    check('one-cli-for-the-chat-after-undo-and-send', clis().length === 1, J(clis()));

    await send('edit index.html: <h1>Your cart</h1> => <h1>Your bag</h1> ;; wait 30');
    await allow();
    await until(() => /Your bag/.test(fs.readFileSync(html, 'utf8')), 15000, 250);
    await hoverRow(2);
    await sleep(800);
    const whileBusy = await undo(2);
    check('no-undo-while-the-turn-runs', !whileBusy || whileBusy.disabled, J(whileBusy));
    await click(s, 'Stop').catch(() => {});
    await until(async () => !/working/.test(await transcript()), 10000, 250);
    await hoverRow(2);
    const stopped = await until(() => undo(2), 3000);
    check('stopped-turn-offers-undo', !!stopped && /1 file/.test(stopped.text), J(stopped));
    if (stopped) {
      await click(s, `xy=${stopped.at}`);
      await until(dialog, 3000);
      const confirm = await dialogButton('Undo');
      if (confirm) await click(s, `xy=${confirm}`);
      check('stopped-turn-undo-restores', await until(() => fs.readFileSync(html, 'utf8') === original, 5000), fs.readFileSync(html, 'utf8').match(/<h1>.*<\/h1>/)?.[0]);
    }
    const before = await results();
    await send('edit index.html: <h1>Your cart</h1> => <h1>Your tote</h1>');
    await allow();
    await until(async () => (await results()) > before, 30000, 250);
    check('tote-turn-edited-index-html', /Your tote/.test(fs.readFileSync(html, 'utf8')), (await transcript()).slice(-600));

    const railRow = (title) => until(() => evaluate(s, `(() => {
      const b = [...document.querySelectorAll('[title]')].find((e) => e.title.startsWith(${J(title)}));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return Math.round(r.x + r.width / 2) + ',' + Math.round(r.y + r.height / 2);
    })()`), 10000, 250);
    await click(s, 'css=[title="New chat in shop"]');
    await sleep(800);
    await send('say: another chat');
    await until(async () => /another chat/.test(await transcript()) && !/working/.test(await transcript()), 20000, 250);
    check('a-second-chat-parks-the-first', !!await until(() => clis().length === 1, 10000, 250), J(clis()));
    await evaluate(s, 'window.connRail?.refresh()').catch(() => {});
    const reopen = await railRow('edit index.html: <h1>Your cart</h1> => <h1>Your basket');
    check('rail-lists-the-chat', !!reopen, 'no rail row titled with the first prompt');
    if (reopen) await click(s, `xy=${reopen}`);
    check('reopening-parks-the-second-chat', !!await until(() => clis().length === 0, 10000, 250), J(clis()));
    const replayed = await until(async () => {
      const t = await transcript();
      return /Your tote/.test(t) && !/opening this chat/.test(t);
    }, 15000, 250);
    check('reopened-chat-replays', !!replayed, (await transcript()).slice(0, 400));
    const tote = await evaluate(s, `[...document.querySelectorAll('#agent-root .is-user')].findIndex((r) => /Your tote/.test(r.innerText))`);
    await hoverRow(tote);
    const reopened = tote >= 0 && await until(() => undo(tote), 20000);
    check('reopened-chat-offers-undo', !!reopened && /1 file/.test(reopened.text), J(reopened));
    if (reopened) {
      await click(s, `xy=${reopened.at}`);
      await until(dialog, 3000);
      const confirm = await dialogButton('Undo');
      if (confirm) await click(s, `xy=${confirm}`);
      check('reopened-chat-undo-restores', await until(() => fs.readFileSync(html, 'utf8') === original, 8000), fs.readFileSync(html, 'utf8').match(/<h1>.*<\/h1>/)?.[0]);
      await shot(s, SHOT('reopened'));
    }
    await send('write after.txt: next');
    await allow();
    check('reopened-chat-sends', !!await until(() => fs.existsSync(path.join(s.project, 'after.txt')), 30000, 250), 'no after.txt');
    const held = clis().map((p) => `${p} ${fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0').find((a) => a.startsWith('--resume')) || 'new session'}`);
    check('one-resumed-cli-after-reopen-undo-and-send', held.length === 1 && /--resume/.test(held[0]), J(held));
    check('log-has-no-transport-error', !/ProcessTransport|Operation aborted/.test(fs.readFileSync(path.join(s.dir, 'app.log'), 'utf8')), 'app.log names a transport error');
  } catch (e) {
    check('app-run', false, e.stack || e.message);
  } finally {
    await stop(s);
  }
}

(async () => {
  const bin = process.env.CLAUDE_BIN || require(path.join(ROOT, 'src/main/driver.js')).claudeBinary();
  if (!bin) {
    console.log('SKIP: no claude binary found; set CLAUDE_BIN to run it');
    process.exit(0);
  }
  const api = await import(pathToFileURL(path.join(ROOT, '.claude/skills/verify/claude-api.mjs')).href);
  await onAgentSession(bin, api);
  await inTheApp();
  console.log(failures.length ? `\n${failures.length} failed` : '\nall passed');
  process.exit(failures.length ? 1 : 0);
})();
