'use strict';
/* The chat box floating over a full-width page (issue #75), in the real app.
   The page keeps the column's full height, the box floats over its bottom
   centre as one row, and only the box takes clicks: a real click beside it
   reaches the page, one on it does not, and the agent still clicks and sees the
   whole page under it. Typing, the mode and model menus, the @ list, pasting a
   picture, sending, stopping, and the way back to the chat all work from it.

   Clicks marked native go through the X server (drive.mjs --native), so the
   window system decides which view takes them. Needs a built renderer
   (`npx vite build`), Xvfb and python3. Screenshots go to $CONN_FLOAT_SHOTS, or
   a folder in the temp dir. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = process.env.CONN_ROOT || path.join(__dirname, '..');
const OUT = process.env.CONN_FLOAT_SHOTS || path.join(os.tmpdir(), 'conn-composer-float');
const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
};

const DRAFT = 'Make the coupon field wider';
const LINES = ['1. match the Apply button height', '2. keep the label', '3. add a hint below', '4. check the mobile frame'];
const INPUT = '#composer [contenteditable="true"]';
const PANE_MENU = 'css=button:has(svg.lucide-ellipsis-vertical)';

async function main() {
  const drive = await import(pathToFileURL(path.join(ROOT, '.claude/skills/verify/drive.mjs')).href);
  const { boot, stop, evaluate, click, key, type, shot, say, perm, decided, invoke, bounds } = drive;
  const s = await boot({ root: ROOT, xvfb: true });
  const snap = (name) => shot(s, path.join(OUT, `${name}.png`));

  try {
    const inMain = (expr) => evaluate(s, expr, { main: true, awaitPromise: true });
    const inFloat = (expr) => evaluate(s, expr, { float: true });
    const until = async (fn, ms = 4000) => {
      const end = Date.now() + ms;
      let got;
      while (Date.now() < end && !(got = await fn().catch(() => null))) await sleep(100);
      return got;
    };
    const floatBox = () => inMain('globalThis.__floatBox()');
    const floatFocused = () => inMain('globalThis.__floatFocused()');
    const rect = (sel) => evaluate(s, `(() => { const r = document.querySelector(${J(sel)})?.getBoundingClientRect(); return r && { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom }; })()`);
    const PAGE = `electron.webContents.getAllWebContents().find((w) => /localhost/.test(w.getURL()))`;
    const inPage = (code) => inMain(`${PAGE}.executeJavaScript(${J(code)})`);
    const downs = async () => JSON.parse(await inPage('JSON.stringify(window.__downs || [])'));
    const transcript = () => evaluate(s, `document.querySelector('[role="log"]')?.innerText || ''`);
    const fullWidth = async (label) => { await click(s, PANE_MENU); await click(s, label); await sleep(600); };

    // The shop page, served from Conn's own terminal and opened by hand.
    await key(s, 'Ctrl+Shift+T');
    await type(s, 'node server.mjs', { enter: true });
    const url = await until(async () => /http:\/\/localhost:\d+\//.exec(await evaluate(s, `document.querySelector('#terms .xterm-rows')?.innerText || ''`))?.[0]);
    await say(s, 'Ready when you are.');
    await key(s, 'Ctrl+Shift+B');
    await click(s, 'css=input[placeholder="Search Google or enter URL"]');
    await type(s, url.replace('http://', ''), { enter: true });
    await until(() => inMain(`!!${PAGE} && !${PAGE}.isLoading()`));
    // "Local server detected" covers the pane's menu button.
    if (await until(() => evaluate(s, `!!document.querySelector('[data-sonner-toast]')`), 5000)) await click(s, 'Ignore');

    // A draft in the chat, carried into the float.
    await click(s, `css=#agent-root ${INPUT}`);
    await type(s, DRAFT);
    await snap('1-chat-draft');
    await fullWidth('Preview at full width');

    const box = await until(floatBox);
    const slot = await rect('#paneslot');
    const column = await rect('section#right');
    check('the float is up at full width', !!box, 'no floating view');
    check('the page keeps the column\'s full height', slot && Math.abs(slot.bottom - column.bottom) <= 1, J({ slot, column }));
    check('the native page matches #paneslot', (await bounds(s)).nativeViewMatch, 'bounds disagree');
    check('the box is one row high', box && box.height <= 60, J(box));
    check('the box sits at the bottom centre of the page', box && Math.abs(box.x + box.width / 2 - (slot.x + slot.width / 2)) <= 1 && slot.bottom - (box.y + box.height) <= 16, J({ box, slot }));
    check('the chat draft is in the float', (await inFloat(`document.querySelector(${J(INPUT)}).textContent`)) === DRAFT, 'draft missing');
    await snap('2-full-width-pill');

    // Only the box takes clicks: real ones beside it reach the page.
    await inPage('window.__downs = []; addEventListener("mousedown", (e) => window.__downs.push([e.clientX, e.clientY])); true');
    const beside = { x: box.x - 6, y: Math.round(box.y + box.height / 2) };
    await click(s, `xy=${beside.x},${beside.y}`, { native: true });
    const [down] = await downs();
    check('a real click beside the box reaches the page, where it was', down && down[0] === beside.x - Math.round(slot.x) && down[1] === beside.y - Math.round(slot.y), J({ down, beside, slot }));
    await click(s, `css=${INPUT}`, { native: true });
    check('a real click on the box does not reach the page', (await downs()).length === 1, J(await downs()));
    check('a real click on the box gives it the keyboard', await until(floatFocused), 'float not focused');
    check('the caret lands after the carried draft', (await inFloat('getSelection().anchorOffset')) === DRAFT.length, String(await inFloat('getSelection().anchorOffset')));

    // Several lines grow the box upward; the buttons stay on the last line.
    await key(s, 'End');
    await type(s, ', and:');
    for (const line of LINES) { await key(s, 'Shift+Enter'); await type(s, line); }
    const tall = await until(async () => { const b = await floatBox(); return b.height > box.height + 60 && b; });
    check('a five-line draft grows the box upward', tall && tall.y + tall.height === box.y + box.height, J({ tall, box }));
    await snap('3-multiline');

    // The mode menu opens out of the box. The view grows to the column while it is up.
    await click(s, 'Ask mode');
    const open = await until(async () => { const b = await floatBox(); return b.height > tall.height + 200 && b; });
    check('the mode menu has the column to open into', open && Math.abs(open.x - slot.x) <= 1 && Math.abs(open.width - slot.width) <= 1, J({ open, slot }));
    check('the mode menu is open', (await inFloat('document.querySelectorAll(\'[role="menu"]\').length')) === 1, 'no menu');
    await snap('4-mode-menu');
    const focused = () => inFloat('document.activeElement.textContent.slice(0, 4)');
    await key(s, 'Down');
    const first = await focused();
    await key(s, 'Down');
    check('arrow keys walk the menu one item at a time', first === 'Plan' && (await focused()) === 'AskA', `${first} then ${await focused()}`);
    await click(s, `xy=${Math.round(slot.x + 60)},${Math.round(slot.y + 200)}`, { native: true });
    check('a click outside the menu closes it', await until(async () => (await inFloat('document.querySelectorAll(\'[role="menu"]\').length')) === 0), 'menu still open');
    check('that click does not reach the page', (await downs()).length === 1, J(await downs()));
    check('the view is back to the box', await until(async () => (await floatBox()).height === tall.height), J(await floatBox()));
    await click(s, 'Ask mode');
    await click(s, 'Auto');
    check('picking Auto changes the mode', await until(async () => (await inFloat(`document.querySelector('[aria-label^="Auto mode"]') !== null`))), 'still Ask');

    // The model menu, and an effort picked from it.
    await click(s, 'css=button[aria-label^="Opus"]');
    await until(() => inFloat('document.querySelectorAll(\'[role="menu"]\').length === 1'));
    await snap('5-model-menu');
    await click(s, 'High');
    await key(s, 'Escape').catch(() => {});
    check('the effort picked in the box shows on it', await until(() => inFloat(`!!document.querySelector('[aria-label="Opus 5.5 · High"]')`)), 'label unchanged');

    // The @ list opens above the box over a live page.
    await click(s, `css=${INPUT}`);
    await key(s, 'Ctrl+End');
    await type(s, ' @ind');
    check('the @ list opens from the box', await until(() => inFloat(`!!document.querySelector('#composer-mentions [role="option"]')`)), 'no list');
    check('the page stays live under it', await inMain(`${PAGE} && electron.BrowserWindow.getAllWindows()[0].contentView.children.some((v) => v.webContents === ${PAGE} && v.__shown !== false)`), 'page hidden');
    await snap('6-mention-list');
    await key(s, 'Escape');
    for (let i = 0; i < 5; i++) await key(s, 'Backspace');

    // A picture pasted into the box.
    await inMain(`(electron.clipboard.writeImage(electron.nativeImage.createFromPath(${J(path.join(ROOT, 'build', 'icon.png'))})), true)`);
    await key(s, 'Ctrl+V');
    check('a pasted picture is attached', await until(() => inFloat('document.querySelector("#composer").innerText.includes("image.png")')), 'no chip');
    await snap('7-pasted-picture');

    // Send, then Stop, from the box.
    await key(s, 'Enter');
    check('Enter sends the draft', await until(async () => (await transcript()).includes(LINES[3])), 'not in the transcript');
    check('the send button is Stop while the turn runs', await until(() => inFloat(`!!document.querySelector('button[aria-label="Stop"]')`)), 'no Stop');
    check('the box is one row again', await until(async () => (await floatBox()).height === box.height), J(await floatBox()));
    await snap('8-turn-running');
    await click(s, 'Stop', { native: true });
    check('Stop interrupts the turn', await until(async () => (await transcript()).includes('interrupted')), 'no interrupted');
    check('the button is Submit again', await until(() => inFloat(`!!document.querySelector('button[aria-label="Submit"]')`)), 'still Stop');
    await snap('9-after-stop');

    // A long draft stops growing and scrolls.
    await click(s, `css=${INPUT}`);
    for (let i = 1; i <= 14; i++) { if (i > 1) await key(s, 'Shift+Enter'); await type(s, `line ${i}`); }
    const capped = await inFloat(`(() => { const b = document.querySelector(${J(INPUT)}); return { scroll: b.scrollHeight, client: b.clientHeight }; })()`);
    const most = await floatBox();
    check('a long draft is capped and scrolls', capped.scroll > capped.client && most.height < 260, J({ capped, most }));
    await key(s, 'Ctrl+A');
    await key(s, 'Backspace');

    // The agent clicks and sees the page under the box.
    await invoke(s, 'evaluate', { code: 'const b = document.createElement("button"); b.id = "under"; b.textContent = "Under the box"; b.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);width:600px;height:40px;background:#fde68a;border:0"; b.onclick = () => { b.textContent = "Clicked by the agent"; }; document.body.append(b); true' });
    await invoke(s, 'click', { target: '#under' });
    check('the agent clicks a button under the box', (await inPage('document.querySelector("#under").textContent')) === 'Clicked by the agent', 'not clicked');
    const pic = await invoke(s, 'screenshot', {});
    const file = pic?.path || pic?.file || (typeof pic === 'string' ? pic : null);
    const sharp = require(require.resolve('sharp', { paths: [ROOT] }));
    const px = file && await sharp(file).extract({ left: Math.round(slot.width / 2), top: Math.round(box.y + box.height / 2 - slot.y), width: 1, height: 1 }).raw().toBuffer();
    check('the agent\'s screenshot shows the page under the box, not the box', px && px[0] > 240 && px[1] > 215 && px[2] < 170, J({ file, px: px && [...px] }));
    if (file) fs.copyFileSync(file, path.join(OUT, '10b-what-the-agent-sees.png'));
    const top = await inMain('electron.BrowserWindow.getAllWindows()[0].contentView.children.at(-1).webContents.opener !== null');
    check('the box stays above the agent\'s overlay', top, 'float not on top');
    await snap('10-agent-under-the-box');

    // A card raised while the chat is away is answered back in the chat, with
    // the draft typed in the box carried there.
    await click(s, `css=${INPUT}`, { native: true });
    await type(s, 'Typed in the box');
    await perm(s, { tool: 'Edit', id: 'p-float' });
    await snap('11-waiting-for-answer');
    await fullWidth('Back to the chat');
    check('leaving full width opens the chat', await until(async () => !(await floatBox()) && !!(await evaluate(s, `!!document.querySelector('#agent-root ${INPUT}')`))), 'still floating');
    check('the draft typed in the box is in the chat', (await evaluate(s, `document.querySelector('#agent-root ${INPUT}').textContent`)) === 'Typed in the box', 'draft lost');
    await snap('12-back-in-chat');
    await click(s, 'Allow');
    check('the card is answered from the chat', (await decided(s, 'p-float')) === 'allow', 'no decision');

    // Ctrl+Shift+K from the shell moves the keyboard into the box.
    await fullWidth('Preview at full width');
    await until(floatBox);
    await click(s, 'css=input[placeholder="Search Google or enter URL"]', { native: true });
    check('the address bar has the keyboard', !(await floatFocused()), 'float focused');
    await key(s, 'Ctrl+Shift+K');
    check('Ctrl+Shift+K moves the keyboard into the box', await until(floatFocused), 'float not focused');
    check('with the caret after the draft', (await inFloat('getSelection().anchorOffset')) === 'Typed in the box'.length, String(await inFloat('getSelection().anchorOffset')));

    // The other theme, the app at 125%, then a small window: the box follows.
    await click(s, 'pin the other one');
    await click(s, 'Zoom in');
    await click(s, 'Zoom in');
    const zoomed = await until(async () => { const b = await floatBox(); return b.zoom > 1.2 && b; });
    check('the box follows the theme', (await inFloat('document.documentElement.dataset.theme')) === (await evaluate(s, 'document.documentElement.dataset.theme')), 'themes differ');
    check('the box follows the app zoom', zoomed && Math.abs(zoomed.width - box.width * 1.25) <= 2 && Math.abs(zoomed.height - box.height * 1.25) <= 2, J({ zoomed, box }));
    await inMain('(electron.BrowserWindow.getAllWindows()[0].setContentSize(800, 700), true)');
    const small = await until(async () => { const b = await floatBox(); return b.width < zoomed.width && b; });
    check('a small window keeps the box one row', small && small.height === zoomed.height, J({ small, zoomed }));
    await snap('13-dark-zoomed-small-window');
  } finally {
    await stop(s);
  }

  console.log(`\nscreenshots in ${OUT}`);
  if (failures.length) {
    console.log(`${failures.length} failed`);
    process.exit(1);
  }
}

fs.mkdirSync(OUT, { recursive: true });
main().catch((e) => { console.error(e); process.exit(1); });
