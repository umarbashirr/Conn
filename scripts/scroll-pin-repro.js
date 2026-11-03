'use strict';
/* Sending pins the message near the top of the view while its reply fills in
   below, then follows the stream once the reply passes the fold. Scrolling up
   still holds the view, opening a saved chat lands on its last message without
   a jump, Show earlier keeps the reader's place, and reduced motion scrolls
   instantly. Every claim is a measured scrollTop or offset. Needs a built
   renderer: `npx vite build` first. CONN_ROOT picks the checkout to boot. */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = process.env.CONN_ROOT || path.join(__dirname, '..');
const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PEEK = 48;

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${J(detail)}`);
  if (!ok) failures.push(name);
};

// Every reply's text is its own: the stand-in agent drops a whole reply that
// repeats an earlier one.
const para = (tag, n, words) => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}. ${'lorem ipsum dolor sit amet '.repeat(words)}`).join('\n\n');

// Sampled where the frame is painted: a ResizeObserver on a probe resized every
// animation frame. Its callbacks run after the app's own observers have settled
// the scroll and before paint. A plain timer can land between frames, after a
// React commit forced a layout but before those observers ran, and read a
// scroll position no frame ever shows.
// atBottom is use-stick-to-bottom's isAtBottom as the reader sees it: the
// scroll-to-bottom button shows exactly when it is false.
const GEO = `(() => {
  const sc = document.querySelector('#agent-root [role=log] > div');
  if (!sc) return null;
  const top = sc.getBoundingClientRect().top;
  const rel = (el) => el ? Math.round(el.getBoundingClientRect().top - top) : null;
  const user = [...sc.querySelectorAll('.is-user')].pop();
  const reply = [...sc.querySelectorAll('.is-assistant')].pop();
  return {
    t: Math.round(performance.now()),
    scrollTop: Math.round(sc.scrollTop),
    scrollHeight: sc.scrollHeight,
    view: sc.clientHeight,
    fromBottom: Math.round(sc.scrollHeight - sc.clientHeight - sc.scrollTop),
    userTop: rel(user),
    replyBottom: reply ? Math.round(reply.getBoundingClientRect().bottom - top) : null,
    atBottom: !document.querySelector('#agent-root .lucide-arrow-down'),
  };
})()`;

const SAMPLE_START = `(() => {
  window.__samples = [];
  window.__sampling = true;
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;pointer-events:none;opacity:0';
  document.body.append(probe);
  const watch = new ResizeObserver(() => window.__samples.push(${GEO}));
  watch.observe(probe);
  let wide = false;
  const tick = () => {
    if (!window.__sampling) { watch.disconnect(); probe.remove(); return; }
    wide = !wide;
    probe.style.width = wide ? '2px' : '1px';
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})()`;
const SAMPLE_STOP = `(() => { window.__sampling = false; return window.__samples; })()`;

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

async function main() {
  const drive = await import(pathToFileURL(path.join(ROOT, '.claude/skills/verify/drive.mjs')).href);
  const { boot, stop, evaluate, click, say, type, key } = drive;
  const s = await boot({ root: ROOT, xvfb: true });
  const cdp = await cdpPage(s);
  console.log(`root ${ROOT}`);

  try {
    const geo = () => evaluate(s, GEO);
    const settled = async () => {
      let last = await geo();
      for (let i = 0; i < 40; i++) {
        await sleep(100);
        const now = await geo();
        if (now.scrollTop === last.scrollTop && now.scrollHeight === last.scrollHeight) return now;
        last = now;
      }
      return last;
    };
    const users = () => evaluate(s, `document.querySelectorAll('#agent-root .is-user').length`);
    const send = async (text) => {
      const had = await users();
      for (let i = 0; i < 40 && await evaluate(s, `!!document.querySelector('#agent-root [aria-label="Stop"]')`); i++) await sleep(100);
      await evaluate(s, `document.querySelector('#agent-root [contenteditable="true"]').focus()`);
      await type(s, text, { enter: true });
      for (let i = 0; i < 40 && (await users()) === had; i++) await sleep(100);
    };
    const wheel = async (dy) => {
      const at = await evaluate(s, `(() => { const r = document.querySelector('#agent-root [role=log]').getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 3)]; })()`);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at[0], y: at[1], deltaX: 0, deltaY: dy });
    };
    const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;

    await click(s, 'Later').catch(() => {});
    await say(s, para('First', 12, 12), { prompt: 'first question' });
    await settled();

    await send('second question');
    const sent = await settled();
    check('send: the sent message sits near the top with a sliver of the last reply above it',
      sent.userTop >= PEEK - 8 && sent.userTop <= PEEK + 16, sent);
    check('send: isAtBottom stays true at the pin (no scroll button)', sent.atBottom, sent);

    await evaluate(s, SAMPLE_START);
    await say(s, para('Second', 14, 10), { stream: 60, size: 30 });
    await sleep(800);
    const streamed = await evaluate(s, SAMPLE_STOP);
    const before = streamed.filter((g) => g.replyBottom - g.userTop < g.view - PEEK - 20);
    const drift = before.length ? Math.max(...before.map((g) => Math.abs(g.scrollTop - sent.scrollTop))) : null;
    check('stream: the view does not move while the reply fills in above the fold',
      before.length >= 5 && drift <= 2, { framesAboveFold: before.length, maxScrollTopDrift: drift, drifted: before.filter((g) => g.scrollTop !== sent.scrollTop).slice(0, 4), first: before[0], last: before[before.length - 1] });
    const after = streamed[streamed.length - 1];
    check('stream: once the reply passes the fold the view follows it to the end',
      after.fromBottom <= 70 && after.atBottom && after.userTop < 0, after);

    await send('third question');
    await settled();
    const streaming = say(s, para('Third', 28, 10), { stream: 60, size: 30 });
    let past = null;
    for (let i = 0; i < 100 && !past; i++) {
      await sleep(100);
      const g = await geo();
      if (g.userTop < -150) past = g;
    }
    await wheel(-400);
    await sleep(400);
    const lifted = await geo();
    await sleep(1200);
    const held = await geo();
    check('scroll up: the view holds its position while the reply keeps arriving',
      !!past && lifted.scrollTop < past.scrollTop && near(held.scrollTop, lifted.scrollTop) && held.scrollHeight > lifted.scrollHeight,
      { past, lifted, held });
    check('scroll up: isAtBottom is false and the scroll button shows', !held.atBottom, held);
    await click(s, 'css=#agent-root button:has(.lucide-arrow-down)');
    await sleep(1200);
    const resumed = await geo();
    await streaming;
    await sleep(800);
    const ended = await geo();
    check('scroll button: resumes following the stream to its end',
      resumed.fromBottom <= 70 && ended.fromBottom <= 70 && ended.atBottom, { resumed, ended });

    await send('fourth question');
    await settled();
    await say(s, 'Short answer.');
    const leftAt = await settled();

    await click(s, 'css=[title="New chat in shop"]');
    await sleep(600);
    const opening = async (title) => {
      await evaluate(s, SAMPLE_START);
      await click(s, `css=button[title="${title}"]`);
      await sleep(1200);
      const frames = (await evaluate(s, SAMPLE_STOP)).filter((g) => g && g.userTop !== null);
      return { frames, first: frames[0], last: frames[frames.length - 1] };
    };
    const short = await opening('first question');
    const tops = short.frames.map((g) => g.scrollTop);
    check('open saved chat: lands with the last message near the top',
      !!short.last && short.last.userTop >= PEEK - 8 && short.last.userTop <= PEEK + 16, { leftAt, last: short.last });
    check('open saved chat: no visible jump, the first painted frame is already in place',
      tops.length > 0 && Math.max(...tops) - Math.min(...tops) <= 2, { frames: tops.length, min: Math.min(...tops), max: Math.max(...tops) });
    check('open saved chat: a last turn that fits is pinned, isAtBottom true', !!short.last?.atBottom, short.last);

    await click(s, 'css=[title="New chat in shop"]');
    await sleep(600);
    await send('long one');
    await sleep(400);
    await say(s, para('Long', 24, 12));
    await settled();
    for (let i = 0; i < 17; i++) {
      await send(`filler ${i}`);
      await say(s, `Filler reply ${i}.`);
    }
    await send('last long');
    await sleep(300);
    await say(s, para('Last', 24, 12));
    await settled();
    await click(s, 'css=[title="New chat in shop"]');
    await sleep(600);
    const long = await opening('long one');
    const ltops = long.frames.map((g) => g.scrollTop);
    check('open long saved chat: lands at the start of the last turn, not its end',
      !!long.last && long.last.userTop >= PEEK - 8 && long.last.userTop <= PEEK + 16, long.last);
    check('open long saved chat: free, so the scroll button offers the rest', !!long.last && !long.last.atBottom, long.last);
    check('open long saved chat: no visible jump',
      ltops.length > 0 && Math.max(...ltops) - Math.min(...ltops) <= 2, { frames: ltops.length, min: Math.min(...ltops), max: Math.max(...ltops) });

    for (let i = 0; i < 30; i++) await wheel(-2000);
    await sleep(600);
    const reading = `(() => {
      const sc = document.querySelector('#agent-root [role=log] > div');
      const top = sc.getBoundingClientRect().top;
      const row = [...sc.querySelectorAll('.is-user, .is-assistant')].find((r) => r.getBoundingClientRect().bottom > top + 40);
      return row && { text: row.innerText.slice(0, 40), top: Math.round(row.getBoundingClientRect().top - top), scrollTop: Math.round(sc.scrollTop) };
    })()`;
    const was = await evaluate(s, reading);
    await click(s, 'earlier');
    await sleep(600);
    const now = await evaluate(s, reading.replace('.find((r) => r.getBoundingClientRect().bottom > top + 40)', `.find((r) => r.innerText.slice(0, 40) === ${J(was?.text)})`));
    check('show earlier: the row being read stays where it was',
      !!was && !!now && near(was.top, now.top), { was, now });

    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const reduced = await evaluate(s, `matchMedia('(prefers-reduced-motion: reduce)').matches`);
    await click(s, 'css=#agent-root button:has(.lucide-arrow-down)').catch(() => {});
    await settled();
    await evaluate(s, SAMPLE_START);
    await send('reduced motion question');
    await sleep(800);
    const moves = (await evaluate(s, SAMPLE_STOP)).map((g) => g.scrollTop).filter((v, i, a) => i === 0 || v !== a[i - 1]);
    check('reduced motion: the send scroll is instant, one step with no frames in between',
      reduced && moves.length <= 2, { reduced, scrollTopSteps: moves });
    await say(s, 'Reduced answer.');
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
