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
    // The overlay is a native view of its own, so it is read from main.
    const overlay = (code) => evaluate(s, `(async () => {
      const v = electron.BrowserWindow.getAllWindows().flatMap((w) => w.contentView.children)
        .find((x) => x.webContents && /overlay\\.html$/.test(x.webContents.getURL()));
      if (!v || v.__shown === false) return null;
      return { box: v.getBounds(), page: await v.webContents.executeJavaScript(${J(`(${code})`)}) };
    })()`, { main: true, awaitPromise: true });
    const pill = () => overlay(`({ mode: document.body.dataset.mode, opacity: getComputedStyle(document.getElementById('bar')).opacity,
      veil: getComputedStyle(document.body).backgroundColor, give: !document.getElementById('give').hidden,
      bar: document.getElementById('bar').getBoundingClientRect().toJSON() })`);
    const chip = () => js(`[...document.querySelectorAll('button')].some((b) => b.innerText.includes('You have control'))`);
    const strip = () => js(`!!document.querySelector('[data-slot="hand-back-strip"]')`);
    const centre = (o) => `xy=${Math.round(o.box.x + o.page.bar.x + o.page.bar.width - 60)},${Math.round(o.box.y + o.page.bar.y + o.page.bar.height / 2)}`;

    await click(s, 'Later').catch(() => {});
    await key(s, 'Ctrl+Shift+T');
    await sleep(800);
    await type(s, 'node server.mjs', { enter: true });
    const url = await until(async () => (await js(`document.querySelector('#terms .xterm-rows')?.innerText || ''`)).match(/http:\/\/localhost:\d+\//)?.[0]);
    check('the-shop-serves', !!url, 'no url');

    // The agent drives the page: the page shows as it is, and Take control
    // waits until you reach for it.
    await say(s, 'Opening the page.', { open: true });
    await invoke(s, 'navigate', { url });
    const driving = await until(async () => { const o = await pill(); return o?.page.mode === 'agent' && o; });
    check('the-agent-has-the-page', !!driving, J(driving));
    check('no-veil-over-the-page', driving?.page.veil === 'rgba(0, 0, 0, 0)', J(driving?.page.veil));
    check('take-control-is-hidden-until-you-reach-for-it', driving?.page.opacity === '0', J(driving?.page.opacity));
    await shot(s, path.join(SHOTS, 'hand-back-agent-driving.png'));
    // A click on the page goes nowhere, and shows the pill.
    await click(s, `xy=${Math.round(driving.box.x + driving.box.width / 2)},${Math.round(driving.box.y + driving.box.height / 3)}`, { native: true });
    const reached = await until(async () => { const o = await pill(); return o?.page.opacity === '1' && o; });
    check('reaching-for-the-page-shows-take-control', !!reached, J(await pill()));
    await shot(s, path.join(SHOTS, 'hand-back-take-control.png'));

    await click(s, centre(reached), { native: true });
    const yours = await until(async () => { const o = await pill(); return o?.page.mode === 'human' && o; });
    check('take-control-floats-hand-back-at-the-bottom', !!yours && yours.page.give && yours.box.height <= 60
      && yours.box.y + yours.box.height >= driving.box.y + driving.box.height - 30, J(yours));
    check('the-rest-of-the-page-is-yours-to-click', !!yours && yours.box.width < driving.box.width && yours.box.height < driving.box.height, J(yours?.box));
    check('and-the-title-bar-chip-says-so-too', await until(chip), 'no chip');
    await shot(s, path.join(SHOTS, 'hand-back-floating.png'));

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
    check('hand-back-frees-the-page', !!(await until(async () => !(await pill()) && !(await chip()))), 'still held');
    check('and-the-strip-goes', !!(await until(async () => !(await strip()))), 'strip stayed');
    const told = await until(() => js(`document.querySelector('[role="log"]')?.innerText.includes('I handed the browser back to you')`));
    check('and-the-agent-is-told-to-carry-on', !!told, 'no message sent');
    const free = await invoke(s, 'click', { target: '#apply' }).catch((e) => String(e.message || e));
    check('the-agent-can-drive-again', !/took control/.test(J(free)), J(free).slice(0, 200));

    // The floating pill alone, without telling the agent anything.
    await js(`window.conn.browser.seize()`);
    const again = await until(async () => { const o = await pill(); return o?.page.mode === 'human' && o; });
    await click(s, centre(again), { native: true });
    check('the-floating-pill-hands-it-back', !!(await until(async () => !(await pill()) && !(await chip()))), J(await pill()));
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
