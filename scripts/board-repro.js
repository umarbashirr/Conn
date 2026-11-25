'use strict';
/* The Board, driven in a real window. Four chats are put in four states (one
   idle, one that finished while you were in another chat, one still working,
   one waiting on a permission) and each has to land in its lane. A second
   Conn window is played by a small server this script runs, advertised the
   way a window advertises itself, and `claude agents --json` is played by a
   fake CLI, so every source the Board reads is real traffic. Then the clicks:
   a card here opens its chat, a card in the other window asks that window,
   and a background session copies its attach command.

   Needs a built renderer: `npx vite build` first. Screenshots go to
   BOARD_SHOTS (default the temp dir). */
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = process.env.CONN_ROOT || path.join(__dirname, '..');
const SHOTS = process.env.BOARD_SHOTS || os.tmpdir();
const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
};

// Another Conn window, as far as the Board can tell: a bridge that answers
// GET /board and POST /board/open behind a token.
function peerWindow(cards) {
  const token = 'peer-token-0123456789';
  const opened = [];
  const server = http.createServer(async (req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(J(body)); };
    if (req.headers['x-conn-token'] !== token) return send(401, { error: 'bad token' });
    if (req.url === '/board' && req.method === 'GET') return send(200, { cards });
    if (req.url === '/board/open' && req.method === 'POST') {
      let body = '';
      for await (const c of req) body += c;
      opened.push(JSON.parse(body));
      return send(200, { ok: true });
    }
    return send(404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, token, opened, url: `http://127.0.0.1:${server.address().port}` })));
}

async function main() {
  const drive = await import(pathToFileURL(path.join(ROOT, '.claude/skills/verify/drive.mjs')).href);
  const { boot, stop, evaluate, click, key, type, say, perm, shot } = drive;
  const s = await boot({ root: ROOT, xvfb: true });

  const now = Date.now();
  const peer = await peerWindow([
    { id: 'peer-s1', key: 'peer-k1', session: 'peer-s1', title: 'Migrate the API', project: '/work/api/.claude/worktrees/migrate', provider: 'codex', at: now - 60000, waiting: true, activity: { state: 'waiting', line: 'Wants to run npm test' } },
    { id: 'peer-s2', key: 'peer-k2', session: 'peer-s2', title: 'Write release notes', project: '/work/site', provider: 'claude', at: now - 30000, busy: true, activity: { state: 'working', line: 'Editing notes.md' } },
  ]);

  try {
    const js = (code) => evaluate(s, code);
    const until = async (fn, ms = 6000) => {
      const end = Date.now() + ms;
      let got;
      while (Date.now() < end && !(got = await fn())) await sleep(150);
      return got;
    };
    const newChat = async (prompt) => {
      await click(s, 'Start a chat in this folder');
      await js('window.connChat.focusComposer()');
      await until(() => js(`!!document.activeElement?.matches('#composer [contenteditable="true"]')`), 2000);
      await type(s, prompt);
      await key(s, 'Enter');
      await sleep(400);
    };
    const lanes = () => js(`(() => Object.fromEntries([...document.querySelectorAll('[data-slot="board-lane"]')].map((l) => [
      l.dataset.lane,
      [...l.querySelectorAll('[data-slot="board-card"]')].map((c) => ({ title: c.getAttribute('aria-label'), where: c.dataset.where, text: c.innerText })),
    ])))()`);

    await click(s, 'Later').catch(() => {});

    // Another window, advertised where windows advertise themselves. The pid is
    // this script's, which is alive and is not the app's own.
    const projects = path.join(s.home, '.conn', 'projects');
    fs.mkdirSync(projects, { recursive: true });
    fs.writeFileSync(path.join(projects, 'peer-window.json'), J({ url: peer.url, token: peer.token, pid: process.pid, cwds: ['/work/api', '/work/site'], cwd: '/work/api' }));

    // The CLI's own list, from a fake claude the app is pointed at.
    const fake = path.join(s.dir, 'fake-claude.js');
    fs.writeFileSync(fake, `console.log(JSON.stringify([
      { id: 'bg42', sessionId: 'out-1', name: 'Nightly flaky-test hunt', cwd: '/work/api', kind: 'background', state: 'blocked', startedAt: ${now - 120000} },
      { pid: 9, sessionId: 'out-2', name: 'Terminal refactor', cwd: '/work/web', kind: 'interactive', status: 'busy', startedAt: ${now - 90000} },
    ]));`);
    await evaluate(s, `req('./driver').preferBinary(${J(fake)})`, { main: true });

    // Recent: a turn that ended while it was on screen.
    await say(s, 'All set.', { prompt: 'Tidy the README' });
    // Done: a turn that ends after you moved to another chat.
    await newChat('Fix the coupon bug');
    await say(s, 'Looking into it.', { open: true });
    await click(s, 'Start a chat in this folder');
    await say(s, 'Fixed: SAVE10 now applies once.');
    // Working: a turn still running.
    await newChat('Refactor the cart');
    await say(s, 'Working on it.', { open: true });
    // Needs you: a permission card.
    await newChat('Delete the old build');
    await say(s, 'I need to remove the old build folder.', { open: true });
    await perm(s, { tool: 'Bash', input: { command: 'rm -rf build-old' } });

    const badge = await until(() => js(`document.querySelector('[data-slot="board-needs"]')?.innerText`));
    check('rail-badge-counts-what-needs-you-here', badge === '1', J(badge));

    // The right column is open before the Board, and has to come back after.
    const rightOpen = () => js(`(() => { const r = document.querySelector('section#right'); return !!r && r.getBoundingClientRect().width > 1 && r.getBoundingClientRect().left < innerWidth; })()`);
    await js('document.activeElement?.blur()');
    await key(s, 'Ctrl+Shift+D');
    check('the-right-column-is-open-before-the-board', !!(await until(rightOpen)), 'Files did not open');

    await key(s, 'Ctrl+Shift+M');
    const shown = await until(() => js(`!!document.querySelector('[data-slot="board-page"]')`));
    check('ctrl-shift-m-opens-the-board', !!shown, 'no board page');
    check('board-takes-the-right-columns-room', !(await rightOpen()), 'right column still open');
    check('rail-stays-up', await js(`!!document.querySelector('[data-slot="board-needs"]')`), 'rail is gone');

    const got = await until(async () => {
      const l = await lanes();
      return l.needs?.some((c) => c.where === 'peer') && l.needs?.some((c) => c.where === 'outside') && l;
    }, 12000) || await lanes();
    const titles = (lane, where) => (got[lane] || []).filter((c) => !where || c.where === where).map((c) => c.title);
    check('needs-you-has-the-permission-card', titles('needs', 'here').includes('Delete the old build'), J(got.needs));
    check('working-has-the-running-turn', titles('working', 'here').includes('Refactor the cart'), J(got.working));
    check('done-has-the-turn-that-ended-unseen', titles('done', 'here').includes('Fix the coupon bug'), J(got.done));
    check('recent-has-the-idle-chat', titles('recent', 'here').includes('Tidy the README'), J(got.recent));
    check('each-chat-is-on-one-lane', ['Delete the old build', 'Refactor the cart', 'Fix the coupon bug', 'Tidy the README']
      .every((t) => Object.values(got).flat().filter((c) => c.title === t).length === 1), J(got));
    check('other-window-cards-are-shown-and-marked', titles('needs', 'peer').includes('Migrate the API') && titles('working', 'peer').includes('Write release notes')
      && got.needs.find((c) => c.title === 'Migrate the API').text.includes('other window'), J(got));
    check('a-worktree-card-names-repo-and-worktree', /api[\s\S]*migrate/.test(got.needs.find((c) => c.title === 'Migrate the API')?.text || ''), J(got.needs));
    check('outside-sessions-are-shown-and-marked', titles('needs', 'outside').includes('Nightly flaky-test hunt') && titles('working', 'outside').includes('Terminal refactor'), J(got));
    check('a-background-session-shows-its-attach-command', /claude attach bg42/.test(got.needs.find((c) => c.title === 'Nightly flaky-test hunt')?.text || ''), J(got.needs));
    check('the-header-says-what-it-covers', /1 other/.test(await js(`document.querySelector('[data-slot="board-page"]').innerText`)), 'header');
    await shot(s, path.join(SHOTS, 'board-lanes.png'));

    // A card in the other window asks that window to open it.
    await click(s, 'css=[data-slot="board-card"][data-where="peer"][aria-label="Migrate the API"]');
    const asked = await until(() => peer.opened.length && peer.opened);
    check('a-peer-card-asks-its-window-to-open-it', !!asked && asked[0].key === 'peer-k1' && asked[0].session === 'peer-s1', J(peer.opened));
    check('the-board-stays-open-after-a-peer-open', await js(`!!document.querySelector('[data-slot="board-page"]')`), 'board closed');

    // A background session's card copies its attach command.
    await click(s, 'css=[data-slot="board-card"][data-where="outside"][aria-label="Nightly flaky-test hunt"]');
    const copied = await until(() => evaluate(s, `electron.clipboard.readText()`, { main: true }).then((t) => t === 'claude attach bg42' && t));
    check('an-outside-background-card-copies-claude-attach', !!copied, 'clipboard did not get the command');

    // Closing it gives the chat its room back, right column and all.
    await key(s, 'Escape');
    check('escape-closes-the-board', !!(await until(() => js(`!document.querySelector('[data-slot="board-page"]')`))), 'still open');
    check('the-right-column-comes-back', !!(await until(rightOpen)), 'right column stayed closed');

    // A card here opens its chat. The right column is per chat, so that one
    // shows whatever its own chat had open, which is not checked here.
    await key(s, 'Ctrl+Shift+M');
    await until(() => js(`!!document.querySelector('[data-slot="board-card"][aria-label="Fix the coupon bug"]')`));
    await click(s, 'css=[data-slot="board-card"][data-where="here"][aria-label="Fix the coupon bug"]');
    const back = await until(() => js(`!document.querySelector('[data-slot="board-page"]') && document.body.innerText.includes('Fixed: SAVE10 now applies once.')`));
    check('a-card-here-opens-its-chat', !!back, 'chat not shown');

    // Opening a chat reads it, so it leaves Done.
    await key(s, 'Ctrl+Shift+M');
    const after = await until(async () => { const l = await lanes(); return l.done && l; });
    check('a-read-chat-leaves-done', !(after.done || []).some((c) => c.title === 'Fix the coupon bug') && (after.recent || []).some((c) => c.title === 'Fix the coupon bug'), J(after));
    await key(s, 'Ctrl+Shift+M');
    check('ctrl-shift-m-toggles-it-closed', !!(await until(() => js(`!document.querySelector('[data-slot="board-page"]')`))), 'still open');

    // The palette reaches it by name.
    await key(s, 'Ctrl+K');
    await type(s, 'Board');
    await key(s, 'Enter');
    check('the-palette-opens-the-board', !!(await until(() => js(`!!document.querySelector('[data-slot="board-page"]')`))), 'palette did not open it');
    await shot(s, path.join(SHOTS, 'board-after-reading.png'));
  } finally {
    peer.server.close();
    await stop(s);
  }

  if (failures.length) {
    console.log(`\n${failures.length} failure(s)`);
    process.exit(1);
  }
  console.log('\nall passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
