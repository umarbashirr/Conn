'use strict';
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
};

const FIRST = 'Fix the cart total';
const SECOND = 'Check the shipping rule';
const SHOT = (name) => path.join(os.tmpdir(), `conn-rail-activity-${name}.png`);

const INIT = { type: 'system', subtype: 'init', session_id: 's', model: 'claude-haiku-4-5' };
const RESULT = { type: 'result', subtype: 'success', duration_ms: 1200 };
const assistant = (content) => ({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content } });
const call = (id, name, input) => assistant([{ type: 'tool_use', id, name, input }]);
const back = (id, text) => ({
  type: 'user',
  parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] },
});

async function main() {
  const drive = await import(pathToFileURL(path.join(ROOT, '.claude/skills/verify/drive.mjs')).href);
  const { boot, stop, evaluate, click, key, type, shot, decided } = drive;
  const s = await boot({ xvfb: true });

  try {
    const until = async (fn, ms = 5000) => {
      const end = Date.now() + ms;
      let last;
      while (Date.now() < end) {
        last = await fn();
        if (last) return last;
        await sleep(100);
      }
      return last;
    };

    const emitTo = (n, event, payload) => evaluate(s, `globalThis.__agents[${n}].emit(${J(event)}, ${J(payload)})`, { main: true });

    const row = (title) => evaluate(s, `(() => {
      const row = document.querySelector('[data-sidebar="menu-button"][title=${J(title)}]');
      if (!row) return null;
      return {
        activity: row.dataset.activity || null,
        line: row.querySelector('[data-slot="activity-line"]')?.textContent.trim() ?? null,
        chips: [...row.querySelectorAll('[data-slot="badge"]')].map((b) => b.textContent.trim()),
        dot: !!row.querySelector('[data-slot="finished-dot"]'),
        spinner: !!row.querySelector('svg.animate-spin'),
        truncated: (() => { const l = row.querySelector('[data-slot="activity-line"]'); return l ? l.scrollWidth > l.clientWidth : null; })(),
      };
    })()`);

    const rowIs = (title, want, ms) => until(async () => {
      const got = await row(title);
      return got && Object.entries(want).every(([k, v]) => J(got[k]) === J(v)) ? got : null;
    }, ms);

    const toasts = async () => (await evaluate(s, `[...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent.trim())`))
      .filter((t) => /is done|ended with an error/.test(t));

    await evaluate(s, `(() => {
      const { AgentSession } = req('./agent');
      globalThis.__agents = [];
      AgentSession.prototype.start = async function start() {
        const n = globalThis.__agents.push(this);
        this.sessionId = '7a7a7a7a-0000-4000-8000-00000000000' + n;
        setTimeout(() => this.emit('ready', { sessionId: this.sessionId }), 0);
      };
      return true;
    })()`, { main: true });
    await evaluate(s, `(() => { const sync = window.connRail.sync; window.connRail.sync = (x) => { window.__rail = x; sync(x); }; return true; })()`);

    const send = async (text) => {
      await evaluate(s, `document.querySelector('#agent-root [contenteditable="true"]').focus()`);
      await type(s, text);
      await key(s, 'Enter');
    };

    await click(s, 'Later', { wait: 4000 }).catch(() => {});

    await send(FIRST);
    await until(async () => (await evaluate(s, 'globalThis.__agents.length', { main: true })) === 1);
    await emitTo(0, 'message', INIT);

    await click(s, 'New chat in shop');
    await send(SECOND);
    await until(async () => (await evaluate(s, 'globalThis.__agents.length', { main: true })) === 2);
    await emitTo(1, 'message', INIT);
    await emitTo(1, 'message', RESULT);
    await rowIs(SECOND, { activity: 'idle' });

    const payload = await evaluate(s, 'window.__rail');
    const OLD = ['key', 'project', 'session', 'title', 'renamed', 'busy', 'waiting', 'agents'];
    check(
      'sync-payload-keeps-every-field',
      payload?.chats?.length === 2 && payload.chats.every((c) => OLD.every((k) => k in c) && ['idle', 'working', 'waiting', 'finished'].includes(c.activity?.state)),
      J(payload?.chats?.map((c) => Object.keys(c))),
    );

    await emitTo(0, 'message', call('r1', 'Read', { file_path: `${s.project}/src/cart.js` }));
    const working = await rowIs(FIRST, { activity: 'working', line: 'Reading src/cart.js' });
    check('background-row-reads-the-call', !!working && working.spinner && !working.dot, J(await row(FIRST)));
    check('working-row-has-no-badge-to-share-the-line', !!working && working.chips.length === 0, J(await row(FIRST)));
    check('active-row-shows-no-line', !!(await rowIs(SECOND, { activity: 'idle', line: null, dot: false })), J(await row(SECOND)));
    await shot(s, SHOT('working'));

    await emitTo(0, 'message', call('r2', 'Read', { file_path: `${s.project}/index.html` }));
    const long = await rowIs(FIRST, { line: 'Reading shop/index.html' });
    check('long-file-name-fits-the-row', !!long && long.truncated === false, J(await row(FIRST)));
    await shot(s, SHOT('long'));
    await emitTo(0, 'message', back('r2', '40 lines'));
    await emitTo(0, 'message', back('r1', '12 lines'));
    await emitTo(0, 'message', call('s1', 'mcp__preview__browser_snapshot', {}));
    await emitTo(0, 'message', back('s1', '- textbox "Coupon code" [ref=e12]\n- button "Apply" [ref=e13]'));
    await emitTo(0, 'message', call('c1', 'mcp__preview__browser_click', { target: 'e13' }));
    check('click-names-the-element', !!(await rowIs(FIRST, { line: 'Clicking Apply' })), J(await row(FIRST)));
    await shot(s, SHOT('click'));
    await emitTo(0, 'message', back('c1', 'clicked'));
    await emitTo(0, 'message', call('n1', 'mcp__preview__browser_navigate', { url: 'http://localhost:5173/cart' }));
    await emitTo(0, 'message', back('n1', 'opened'));
    await emitTo(0, 'message', call('c3', 'mcp__preview__browser_click', { target: 'e13' }));
    check('click-after-navigation-reads-no-stale-name', !!(await rowIs(FIRST, { line: 'Clicking in the page' })), J(await row(FIRST)));
    await emitTo(0, 'message', back('c3', 'clicked'));
    await emitTo(0, 'message', call('c2', 'mcp__preview__browser_click', { target: 'e99' }));
    check('click-without-a-name-falls-back', !!(await rowIs(FIRST, { line: 'Clicking in the page' })), J(await row(FIRST)));
    await emitTo(0, 'message', back('c2', 'clicked'));

    const input = { file_path: `${s.project}/src/cart.js`, old_string: 'a', new_string: 'b' };
    await emitTo(0, 'message', call('e1', 'Edit', input));
    await emitTo(0, 'permission', { id: 'p1', tool: 'Edit', input, forId: 'e1' });
    const waiting = await rowIs(FIRST, { activity: 'waiting', line: 'Wants to edit src/cart.js', chips: ['Review'] });
    check('waiting-row-asks-for-review', !!waiting, J(await row(FIRST)));
    const clear = await evaluate(s, `(() => {
      const row = document.querySelector('[data-sidebar="menu-button"][title=${J(FIRST)}]');
      const fade = row.parentElement.querySelector('.pointer-events-none').getBoundingClientRect();
      const actions = [...row.parentElement.querySelectorAll('[data-sidebar="menu-action"]')].map((a) => a.querySelector('svg').getBoundingClientRect().bottom);
      const chip = [...row.querySelectorAll('[data-slot="badge"]')].find((b) => b.textContent.trim() === 'Review').getBoundingClientRect();
      return { fadeBottom: fade.bottom, actionsBottom: Math.max(...actions), chipTop: chip.top };
    })()`);
    check('review-chip-sits-clear-of-the-hover-fade-and-icons', clear.fadeBottom <= clear.chipTop + 1 && clear.actionsBottom <= clear.chipTop + 1, J(clear));
    await shot(s, SHOT('waiting'));

    await click(s, `css=[data-sidebar="menu-button"][title=${J(FIRST)}]`);
    const card = await until(() => evaluate(s, `(() => {
      const allow = [...document.querySelectorAll('#agent-root button')].find((b) => b.textContent.trim() === 'Allow');
      if (!allow) return null;
      const r = allow.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= innerHeight ? { top: r.top } : null;
    })()`));
    check('opening-a-waiting-chat-shows-the-card', !!card, 'the Allow button is not on screen after opening the chat');

    await click(s, 'Allow');
    check('allow-reaches-the-session', (await decided(s, 'p1')) === 'allow', 'no allow decision came back');
    await emitTo(0, 'message', back('e1', 'edited'));
    check('answered-row-stops-waiting', !!(await rowIs(FIRST, { activity: 'working', chips: [] })), J(await row(FIRST)));

    await click(s, `css=[data-sidebar="menu-button"][title=${J(SECOND)}]`);
    await emitTo(0, 'message', RESULT);
    const named = await until(async () => (await toasts()).find((t) => t.includes(`${FIRST} is done`)), 2500);
    check('finished-chat-raises-a-toast-naming-it', !!named, J(await toasts()));
    const finished = await rowIs(FIRST, { activity: 'finished', line: 'Finished', dot: true, chips: [], spinner: false });
    check('finished-row-takes-a-dot', !!finished, J(await row(FIRST)));
    check('other-row-stays-quiet', !!(await rowIs(SECOND, { activity: 'idle', dot: false })), J(await row(SECOND)));
    await sleep(500);
    await shot(s, SHOT('finished'));

    await click(s, 'Open');
    check('open-brings-the-chat-forward', !!(await rowIs(FIRST, { activity: 'idle', dot: false, line: null })), J(await row(FIRST)));
    check('toast-goes-with-the-click', await until(async () => !(await toasts()).length), J(await toasts()));
    await shot(s, SHOT('opened'));
    const shown = await evaluate(s, `document.querySelector('[data-sidebar="menu-button"][data-active="true"]')?.title`);
    check('the-opened-chat-is-the-one-on-screen', shown === FIRST, J(shown));

    await click(s, `css=[data-sidebar="menu-button"][title=${J(SECOND)}]`);
    await sleep(500);
    check('dot-does-not-come-back', !!(await rowIs(FIRST, { activity: 'idle', dot: false })), J(await row(FIRST)));

    await emitTo(0, 'message', INIT);
    await emitTo(0, 'message', call('b1', 'Bash', { command: 'npm run dev', run_in_background: true }));
    await emitTo(0, 'message', back('b1', 'Command running in background with ID: bg1'));
    await emitTo(0, 'message', { type: 'system', subtype: 'task_started', task_id: 'bg1', tool_use_id: 'b1', description: 'npm run dev' });
    await emitTo(0, 'message', RESULT);
    const background = await rowIs(FIRST, { activity: 'working', line: 'Running npm run dev', chips: ['1 running'], spinner: true });
    check('background-command-keeps-the-row-working', !!background, J(await row(FIRST)));
    const synced = await evaluate(s, `window.__rail.chats.find((c) => c.title === ${J(FIRST)})`);
    check('background-command-reaches-the-rail', synced?.shells === 1, J(synced));
    await shot(s, SHOT('background'));
    await sleep(500);
    check('turn-ending-under-a-background-command-raises-no-toast', (await toasts()).length === 0, J(await toasts()));
    await emitTo(0, 'message', { type: 'system', subtype: 'task_notification', task_id: 'bg1', tool_use_id: 'b1', status: 'completed' });
    check('finished-background-command-lets-the-row-rest', !!(await rowIs(FIRST, { activity: 'finished', spinner: false, chips: [] })), J(await row(FIRST)));
    const late = await until(async () => (await toasts()).find((t) => t.includes(`${FIRST} is done`)), 2500);
    check('last-background-command-finishing-raises-the-toast', !!late, J(await toasts()));
    await click(s, 'Open');
    await click(s, `css=[data-sidebar="menu-button"][title=${J(SECOND)}]`);

    await emitTo(0, 'message', INIT);
    await emitTo(0, 'error', 'agent crashed');
    const crashed = await until(async () => (await toasts()).find((t) => t.includes(`${FIRST} ended with an error`)), 2500);
    check('crash-ending-raises-a-toast', !!crashed, J(await toasts()));
    check('crash-ending-takes-a-dot', !!(await rowIs(FIRST, { activity: 'finished', line: 'Ended with an error', dot: true })), J(await row(FIRST)));
    await click(s, 'Open');

    await click(s, `css=[data-sidebar="menu-button"][title=${J(FIRST)}]`);
    await emitTo(0, 'message', INIT);
    await emitTo(0, 'message', RESULT);
    await sleep(800);
    check('finishing-on-screen-draws-no-dot', !!(await rowIs(FIRST, { activity: 'idle', dot: false })), J(await row(FIRST)));
    check('finishing-on-screen-raises-no-toast', (await toasts()).length === 0, J(await toasts()));

    const foot = await evaluate(s, `(() => {
      const foot = document.querySelector('[data-slot="rail-foot"]');
      const names = (el) => [...el.querySelectorAll('button')].map((b) => b.textContent.trim());
      return { foot: foot ? names(foot) : null, header: names(document.querySelector('[data-sidebar="header"]')) };
    })()`);
    check(
      'customize-and-usage-sit-at-the-foot',
      !!foot.foot && foot.foot.includes('Customize') && foot.foot.includes('Usage') && !foot.header.includes('Customize') && !foot.header.includes('Usage'),
      J(foot),
    );

    await click(s, 'Usage');
    const usage = await until(() => evaluate(s, `document.querySelector('[role="dialog"]')?.innerText.includes('Tokens per day') || null`));
    check('usage-opens-its-dialog', !!usage, 'no Usage dialog after clicking Usage');
    await key(s, 'Escape');
    await click(s, 'Customize');
    const customize = await until(() => evaluate(s, `/MCP servers/.test(document.querySelector('#agent-root')?.innerText || '') || null`));
    check('customize-opens-its-page', !!customize, 'no Customize page after clicking Customize');
  } finally {
    await stop(s).catch((e) => console.log(`stop: ${e.message}`));
  }
}

main().then(() => {
  if (failures.length) {
    console.log(`\n${failures.length} failure(s)`);
    process.exit(1);
  }
  console.log('\nall passed');
}, (e) => {
  console.log(`FAIL repro: ${e.stack || e.message}`);
  process.exit(1);
});
