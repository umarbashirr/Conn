'use strict';
/* A saved chat longer than the 400 messages a replay reads opens on its last
   400, and the rest is one button away. Load earlier reads twice as many, keeps
   the row being read where it was, shows the new rows above it without another
   Show earlier step, pairs a call with a result the old cut split, names an
   agent row from its meta file, and leaves a running turn alone even after that
   turn was written to the same transcript. Needs a built renderer: `npx vite
   build` first. CONN_ROOT picks the checkout to boot; SHOT_DIR and SHOT_TAG name
   the screenshots. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = process.env.CONN_ROOT || path.join(__dirname, '..');
const SHOT_DIR = process.env.SHOT_DIR || os.tmpdir();
const SHOT_TAG = process.env.SHOT_TAG || 'run';
const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` ${J(detail)}`}`);
  if (!ok) failures.push(name);
};

const SESSION = '5e551011-0000-4000-8000-00000000c0de';
const TOTAL = 1000;
const FIRST = 'quasar-ember-7 is where this chat began';
const STRADDLE = 'toolu_straddle';
const EARLY_AGENT = 'toolu_early_agent';
const LIVE_Q = 'live question kappa';
const LIVE_A = 'live answer kappa';

const uuidOf = (i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

// Message i of the stored chat. 599 calls a tool and 600 carries its result, so
// the 400-message cut at 600 splits the pair.
function messageAt(i) {
  if (i === 0) return { type: 'user', content: FIRST };
  if (i === 101) return { type: 'assistant', content: [{ type: 'tool_use', id: EARLY_AGENT, name: 'Agent', input: { description: 'early helper', prompt: 'look around' } }] };
  if (i === 102) return { type: 'user', content: [{ type: 'tool_result', tool_use_id: EARLY_AGENT, content: 'looked around' }] };
  if (i === 599) return { type: 'assistant', content: [{ type: 'tool_use', id: STRADDLE, name: 'Bash', input: { command: 'echo straddle' } }] };
  if (i === 600) return { type: 'user', content: [{ type: 'tool_result', tool_use_id: STRADDLE, content: 'straddle-output' }] };
  return i % 2
    ? { type: 'assistant', content: [{ type: 'text', text: `answer ${(i - 1) / 2}` }] }
    : { type: 'user', content: `question ${i / 2}` };
}

const lineOf = (i, { type, content }, cwd) => J({
  type,
  uuid: uuidOf(i),
  parentUuid: i ? uuidOf(i - 1) : null,
  sessionId: SESSION,
  cwd,
  timestamp: new Date(Date.UTC(2026, 9, 1) + i * 60000).toISOString(),
  message: { role: type, content },
});

function writeTranscript(s) {
  const dir = path.join(s.home, '.claude', 'projects', s.project.replace(/[/.]/g, '-'));
  fs.mkdirSync(path.join(dir, SESSION, 'subagents'), { recursive: true });
  const file = path.join(dir, `${SESSION}.jsonl`);
  fs.writeFileSync(file, `${Array.from({ length: TOTAL }, (_, i) => lineOf(i, messageAt(i), s.project)).join('\n')}\n`);
  fs.writeFileSync(path.join(dir, SESSION, 'subagents', 'agent-early1.meta.json'),
    J({ agentType: 'Explore', description: 'early helper', toolUseId: EARLY_AGENT }));
  return file;
}

async function cdpPage(s) {
  const list = await (await fetch(`http://127.0.0.1:${s.cdp}/json/list`)).json();
  const hit = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
  const ws = new WebSocket(hit.webSocketDebuggerUrl);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
  let seq = 0;
  const waiting = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise((ok) => {
    const id = ++seq;
    waiting.set(id, ok);
    ws.send(J({ id, method, params }));
  });
  return { send, close: () => ws.close() };
}

const SCROLLER = `document.querySelector('#agent-root [role=log] > div')`;
// The control at the top of the transcript, marked so a click lands on it and
// on nothing else.
const TOP_CONTROL = `(() => {
  document.querySelector('[data-repro-top]')?.removeAttribute('data-repro-top');
  const b = [...document.querySelectorAll('#agent-root [role=log] button')].find((e) => /earlier/i.test(e.innerText));
  b?.setAttribute('data-repro-top', '');
  return b ? b.innerText.replace(/\\s+/g, ' ').trim() : null;
})()`;
// A user row also holds its Edit and Retry labels, so a row is named by its
// last line.
const LINE = `const line = (r) => r.innerText.trim().split('\\n').pop();`;
// The first message row not yet scrolled past, the one a reader at the top is
// reading, and where it sits in the view.
const READING = `(() => {
  const sc = ${SCROLLER};
  const top = sc.getBoundingClientRect().top;
  ${LINE}
  const row = [...sc.querySelectorAll('.is-user, .is-assistant')].find((r) => r.getBoundingClientRect().bottom > top + 40);
  return row && { text: line(row), top: Math.round(row.getBoundingClientRect().top - top) };
})()`;
const placeOf = (text) => `(() => {
  const sc = ${SCROLLER};
  const top = sc.getBoundingClientRect().top;
  ${LINE}
  const rows = [...sc.querySelectorAll('.is-user, .is-assistant')];
  const at = rows.findIndex((r) => line(r) === ${J(text)});
  return at < 0 ? null : { top: Math.round(rows[at].getBoundingClientRect().top - top), above: at, scrollTop: Math.round(sc.scrollTop) };
})()`;
const said = (text) => `(() => {
  ${LINE}
  return [...document.querySelectorAll('#agent-root .is-user, #agent-root .is-assistant')].filter((r) => line(r) === ${J(text)}).length;
})()`;
const order = (a, b) => `(() => {
  ${LINE}
  const rows = [...document.querySelectorAll('#agent-root .is-user, #agent-root .is-assistant')].map(line);
  return [rows.indexOf(${J(a)}), rows.indexOf(${J(b)})];
})()`;

async function main() {
  const drive = await import(pathToFileURL(path.join(ROOT, '.claude/skills/verify/drive.mjs')).href);
  const { boot, stop, evaluate, click, key, say, type, shot } = drive;
  const s = await boot({ root: ROOT, xvfb: true });
  const cdp = await cdpPage(s);
  console.log(`root ${ROOT}`);
  const SHOT = (name) => path.join(SHOT_DIR, `load-earlier-${SHOT_TAG}-${name}.png`);

  try {
    const until = async (fn, ms = 6000) => {
      const end = Date.now() + ms;
      let got;
      while (Date.now() < end && !(got = await fn())) await sleep(100);
      return got;
    };
    const toTop = async () => {
      const at = await evaluate(s, `(() => { const r = document.querySelector('#agent-root [role=log]').getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 3)]; })()`);
      for (let i = 0; i < 400; i++) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at[0], y: at[1], deltaX: 0, deltaY: -3000 });
        if (i % 10 === 9 && await evaluate(s, `${SCROLLER}.scrollTop === 0`)) break;
      }
      await sleep(400);
    };
    // Every in-memory step first, the way a reader climbing the chat meets them.
    const showAllShown = async () => {
      let steps = 0;
      while (steps < 100 && /^Show \d+ earlier$/.test(await evaluate(s, TOP_CONTROL) || '')) {
        await toTop();
        await click(s, 'css=[data-repro-top]');
        await sleep(300);
        steps++;
      }
      await toTop();
      return steps;
    };

    await click(s, 'Later').catch(() => {});
    const file = writeTranscript(s);
    await key(s, 'Ctrl+K');
    await key(s, 'Escape');
    const listed = await until(() => evaluate(s, `!!document.querySelector(${J(`button[title="${FIRST}"]`)})`));
    check('rail: the stored 1000-message chat is listed', !!listed, FIRST);
    await click(s, `css=button[title="${FIRST}"]`);
    const opened = await until(() => evaluate(s, `${said('answer 499')} === 1`));
    check('open: the last message is shown', !!opened, await evaluate(s, `document.querySelector('#agent-root').innerText.slice(-200)`));

    const steps = await showAllShown();
    console.log(`show-earlier steps before the top: ${steps}`);
    const top = await evaluate(s, TOP_CONTROL);
    await shot(s, SHOT('1-top-of-opened-chat'));
    check('top: offers the 600 messages still on disk', /load earlier/i.test(top || '') && /600 earlier/.test(top || ''), top);
    check('top: the first message is not shown yet', (await evaluate(s, said(FIRST))) === 0, null);

    const loadKeepingPlace = async (shown) => {
      const was = await evaluate(s, READING);
      const wasAt = was && await evaluate(s, placeOf(was.text));
      if (await evaluate(s, TOP_CONTROL)) await click(s, 'css=[data-repro-top]');
      const drawn = await until(() => evaluate(s, `${said(shown)} === 1`));
      await sleep(500);
      const now = was && await evaluate(s, placeOf(was.text));
      return { drawn, kept: !!wasAt && !!now && Math.abs(wasAt.top - now.top) <= 2, above: !!wasAt && !!now && now.above - wasAt.above, was, wasAt, now };
    };

    const one = await loadKeepingPlace('question 100');
    await shot(s, SHOT('2-after-load-earlier'));
    check('load earlier: messages 200 to 599 are drawn', !!one.drawn, await evaluate(s, TOP_CONTROL));
    check('load earlier: the row being read stays where it was on screen', one.kept, one);
    check('load earlier: the new rows are above it, not behind another Show earlier step',
      one.above >= 300 && !/^Show/.test(await evaluate(s, TOP_CONTROL) || ''), { above: one.above, top: await evaluate(s, TOP_CONTROL) });
    check('load earlier: says 200 are left', /200 earlier/.test(await evaluate(s, TOP_CONTROL) || ''), await evaluate(s, TOP_CONTROL));
    const straddle = await evaluate(s, `(() => { const r = document.querySelector('#row-${STRADDLE}'); return r && r.innerText; })()`);
    if (straddle) await click(s, `css=#row-${STRADDLE} button`).catch(() => {});
    const paired = await until(() => evaluate(s, `document.querySelector('#row-${STRADDLE}')?.innerText.includes('straddle-output')`), 2000);
    check('load earlier: the call the old cut split from its result is drawn with that result', !!paired, straddle);

    await click(s, 'css=[title="New chat in shop"]');
    await click(s, `css=button[title="${FIRST}"]`);
    await until(() => evaluate(s, `${said('answer 499')} === 1`));
    const climbed = await showAllShown();
    check('back again: the rows already read in climb by Show earlier, then the next read is offered',
      climbed > 0 && /200 earlier/.test(await evaluate(s, TOP_CONTROL) || ''), { climbed, top: await evaluate(s, TOP_CONTROL) });

    await evaluate(s, `document.querySelector('#agent-root [contenteditable="true"]').focus()`);
    await type(s, LIVE_Q, { enter: true });
    await until(() => evaluate(s, `${said(LIVE_Q)} === 1`));
    await until(() => evaluate(s, '!!globalThis.__agent', { main: true }));
    await say(s, LIVE_A, { open: true });
    fs.appendFileSync(file, `${lineOf(TOTAL, { type: 'user', content: LIVE_Q }, s.project)}\n${lineOf(TOTAL + 1, { type: 'assistant', content: [{ type: 'text', text: LIVE_A }] }, s.project)}\n`);
    const busy = await evaluate(s, `!!document.querySelector('#agent-root [aria-label="Stop"]')`);
    check('live turn: the chat is mid-turn, and its transcript has the turn in it too', busy, busy);

    await toTop();
    const two = await loadKeepingPlace(FIRST);
    await shot(s, SHOT('3-after-load-earlier-mid-turn'));
    check('load earlier mid-turn: the first message can be reached', !!two.drawn, await evaluate(s, TOP_CONTROL));
    check('load earlier mid-turn: the row being read stays where it was on screen', two.kept, two);
    check('load earlier mid-turn: nothing is left to load', !(await evaluate(s, TOP_CONTROL)), await evaluate(s, TOP_CONTROL));
    check('load earlier mid-turn: the running turn is drawn once, after the stored chat',
      (await evaluate(s, said(LIVE_Q))) === 1 && (await evaluate(s, said(LIVE_A))) === 1
        && (([a, b]) => a >= 0 && a < b)(await evaluate(s, order('answer 499', LIVE_Q))),
      { q: await evaluate(s, said(LIVE_Q)), a: await evaluate(s, said(LIVE_A)), order: await evaluate(s, order('answer 499', LIVE_Q)) });
    const agentRow = await evaluate(s, `document.querySelector('#row-${EARLY_AGENT}')?.innerText || null`);
    check('load earlier mid-turn: an agent row from the early part is named from its meta file', /early helper/.test(agentRow || ''), agentRow);
    await toTop();
    await shot(s, SHOT('4-first-message'));
  } finally {
    cdp.close();
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
