'use strict';
/* Taking the browser off the agent, and giving it back. Take control is
   pressed on the page, so Hand back has to be offered there too, not only by
   the chip at the top of the window. And the agent that stopped because you
   had the page is waiting, so the chat offers to hand it back and tell the
   agent to carry on in one press.

   Needs a built renderer: `npx vite build` first. Screenshots go to
   HAND_BACK_SHOTS (default the temp dir). */
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = process.env.CONN_ROOT || path.join(__dirname, '..');
const SHOTS = process.env.HAND_BACK_SHOTS || os.tmpdir();
const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
};

async function main() {
  const drive = await import(pathToFileURL(path.join(ROOT, '.claude/skills/verify/drive.mjs')).href);
  const { boot, stop, evaluate, click, key, type, say, invoke, shot } = drive;
  const s = await boot({ root: ROOT, xvfb: true });
  try {
    const js = (code) => evaluate(s, code);
    const until = async (fn, ms = 8000) => {
      const end = Date.now() + ms;
      let got;
      while (Date.now() < end && !(got = await fn())) await sleep(150);
      return got;
    };
    const paneButton = () => js(`!!document.querySelector('[data-slot="hand-back"]')`);
    const chip = () => js(`[...document.querySelectorAll('button')].some((b) => b.innerText.includes('You have control'))`);
    const strip = () => js(`!!document.querySelector('[data-slot="hand-back-strip"]')`);

    await click(s, 'Later').catch(() => {});
    await key(s, 'Ctrl+Shift+T');
    await sleep(800);
    await type(s, 'node server.mjs', { enter: true });
    const url = await until(async () => (await js(`document.querySelector('#terms .xterm-rows')?.innerText || ''`)).match(/http:\/\/localhost:\d+\//)?.[0]);
    check('the-shop-serves', !!url, 'no url');

    // The agent drives the page, and you take it.
    await say(s, 'Opening the page.', { open: true });
    await invoke(s, 'navigate', { url });
    check('no-hand-back-while-the-agent-has-it', !(await paneButton()), 'button showed early');
    const bounds = await evaluate(s, `(() => { const b = globalThis.__bounds?.at(-1); return b && b.bounds || b; })()`, { main: true });
    const box = bounds && (bounds.bounds || bounds);
    await click(s, `xy=${Math.round(box.x + box.width / 2)},${Math.round(box.y + box.height / 2)}`, { native: true });
    await sleep(300);
    // The overlay's own button sits in the middle of the page.
    const took = await until(paneButton, 4000) || await (async () => {
      await js(`window.conn.browser.seize()`);
      return until(paneButton);
    })();
    check('take-control-shows-hand-back-on-the-page', !!took, 'no Hand back in the pane');
    check('and-the-title-bar-chip-says-so-too', await until(chip), 'no chip');
    await shot(s, path.join(SHOTS, 'hand-back-in-the-pane.png'));

    // The agent is refused, stops, and its chat offers the page back.
    const refused = await invoke(s, 'click', { target: 'button' }).catch((e) => String(e.message || e));
    check('the-agent-is-refused-while-you-hold-it', /took control/.test(J(refused)), J(refused).slice(0, 200));
    // The refusal as the chat sees it: the call, and what came back.
    const emit = (msg) => evaluate(s, `globalThis.__agent.emit('message', ${J(msg)})`, { main: true });
    await emit({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_click', name: 'mcp__preview__browser_click', input: { target: 'button' } }] } });
    await emit({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_click', is_error: true, content: typeof refused === 'string' ? refused : J(refused) }] } });
    await say(s, 'You have the page, so I stopped. Hand it back when you are done.');
    check('the-chat-offers-to-hand-it-back', !!(await until(strip)), 'no strip');
    await shot(s, path.join(SHOTS, 'hand-back-in-the-chat.png'));

    await click(s, 'Hand back and continue');
    check('hand-back-frees-the-page', !!(await until(async () => !(await paneButton()) && !(await chip()))), 'still held');
    check('and-the-strip-goes', !!(await until(async () => !(await strip()))), 'strip stayed');
    const told = await until(() => js(`document.querySelector('[role="log"]')?.innerText.includes('I handed the browser back to you')`));
    check('and-the-agent-is-told-to-carry-on', !!told, 'no message sent');
    const free = await invoke(s, 'click', { target: '#apply' }).catch((e) => String(e.message || e));
    check('the-agent-can-drive-again', !/took control/.test(J(free)), J(free).slice(0, 200));

    // The pane's own button alone, without telling the agent anything.
    await js(`window.conn.browser.seize()`);
    await until(paneButton);
    await click(s, 'css=[data-slot="hand-back"]');
    check('the-pane-button-hands-it-back', !!(await until(async () => !(await paneButton()) && !(await chip()))), 'still held');
  } finally {
    await stop(s);
  }
  if (failures.length) {
    console.log(`\n${failures.length} failure(s)`);
    process.exit(1);
  }
  console.log('\nall passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
