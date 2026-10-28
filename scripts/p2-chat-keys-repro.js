'use strict';
/* Driving the chat from the keyboard, in the real app (CUX-08). Escape stops
   a running turn from the composer and from an idle window, never from a
   terminal or over a dialog. A permission card that arrives while focus is
   idle takes focus on its Allow button, y / a / n answer it, and focus moves
   on to the next card and then to the composer. Ctrl+Shift+A jumps to the
   waiting card from anywhere. Up and Down in the composer walk this chat's
   own prompts, but only from an empty or unedited box and only from the first
   or last line. A permission card is announced through a live region as it
   arrives, a streaming reply is marked busy and a turn error is an alert
   (CUX-10). Needs a built renderer: `npx vite build` first. */
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

const SHOT = (name) => path.join(os.tmpdir(), `conn-chat-keys-${name}.png`);

function checkBindings() {
  const kb = require(path.join(ROOT, 'src/shared/keybindings.js'));
  const stop = kb.BY_ID.stopTurn;
  check('stop-binding-is-escape-in-the-composer', stop?.command === 'stop' && stop.keys === 'Escape' && stop.scope === 'composer',
    J(stop));
  check('escape-can-be-recorded-for-the-composer', kb.chordError('Escape', 'composer') === '', kb.chordError('Escape', 'composer'));
  const jump = kb.BY_ID.jumpPermission;
  check('jump-binding-steals-the-chord-from-the-terminal',
    jump?.keys === 'CmdOrCtrl+Shift+A' && jump.owner === 'renderer' && jump.scope === 'app' && jump.steal === true, J(jump));
  const defaults = kb.defaultKeybindings();
  const clashes = kb.BINDINGS.filter((row) => row.keys && kb.conflictWith(defaults, row.id, row.keys)).map((row) => row.id);
  check('no-default-chord-clashes-with-another', clashes.length === 0, clashes.join(', '));
}

function checkStoredKeybindings() {
  const { Settings } = require(path.join(ROOT, 'src/main/settings.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-chat-keys-settings-'));
  const load = (keybindings) => {
    const file = path.join(dir, `${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(file, J({ keybindings }));
    return new Settings(file);
  };
  const stops = (keys) => J({ stop: keys.stop, stopTurn: keys.stopTurn });
  try {
    const old = load({ stop: '' }).get('keybindings');
    check('empty-stored-stop-boots-with-escape', old.stopTurn === 'Escape' && !('stop' in old), stops(old));

    const chosen = load({ stop: 'CmdOrCtrl+.' });
    check('stored-stop-chord-is-kept-under-stopTurn', chosen.get('keybindings').stopTurn === 'CmdOrCtrl+.', stops(chosen.get('keybindings')));
    const saved = JSON.parse((chosen.patch({}), fs.readFileSync(chosen.file, 'utf8'))).keybindings;
    check('migrated-file-is-written-under-the-new-id', saved.stopTurn === 'CmdOrCtrl+.' && !('stop' in saved), stops(saved));

    const both = load({ stop: 'CmdOrCtrl+.', stopTurn: 'Alt+S' }).get('keybindings');
    check('stopTurn-already-stored-wins-over-stop', both.stopTurn === 'Alt+S', stops(both));

    const cleared = load({ stopTurn: '' }).get('keybindings');
    check('stopTurn-cleared-on-purpose-stays-cleared', cleared.stopTurn === '', stops(cleared));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function checkScreenReaderCues(drive) {
  const { boot, stop, evaluate, click, say, perm, decided } = drive;
  const s = await boot({ root: ROOT, xvfb: true });
  try {
    const until = async (fn, ms = 4000) => {
      const end = Date.now() + ms;
      let got;
      while (Date.now() < end && !(got = await fn())) await sleep(100);
      return got;
    };
    const emit = (msg) => evaluate(s, `globalThis.__agent.emit('message', ${J(msg)})`, { main: true });
    const region = () => evaluate(s, `document.querySelector('[data-perm-announcer]')?.textContent ?? null`);
    const said = () => evaluate(s, `window.__said`);
    const card = (id) => evaluate(s, `(() => {
      const el = document.querySelector('[data-perm-card=${J(id)}]');
      const title = document.getElementById(el?.getAttribute('aria-labelledby') ?? '');
      return el && { role: el.getAttribute('role'), title: title?.textContent ?? null };
    })()`);
    const assistantBusy = () => evaluate(s, `[...document.querySelectorAll('#agent-root .is-assistant')].map((e) => e.getAttribute('aria-busy'))`);

    await click(s, 'Later').catch(() => {});

    const streaming = say(s, 'Reading the cart page. '.repeat(12), { stream: 150, size: 20, prompt: 'look at the cart' });
    const midStream = await until(async () => (await assistantBusy()).includes('true'));
    check('assistant-row-is-busy-while-it-streams', !!midStream, J(await assistantBusy()));
    await streaming;
    const afterStream = await until(async () => (await assistantBusy()).length && (await assistantBusy()).every((v) => v === null));
    check('assistant-row-drops-aria-busy-when-the-stream-ends', !!afterStream, J(await assistantBusy()));

    await evaluate(s, `(() => {
      window.__said = [];
      const el = document.querySelector('[data-perm-announcer]');
      if (el) new MutationObserver(() => window.__said.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
    })()`);
    await perm(s, { id: 'a1', tool: 'Bash' });
    const bash = await until(async () => (await region()) === 'Permission needed: Bash');
    check('announcer-reads-the-tool-after-a-card-arrives', !!bash, J(await region()));
    check('card-is-a-group', (await card('a1'))?.role === 'group', J(await card('a1')));
    check('card-is-named-by-its-title', /^Allow\s+Bash\?$/.test((await card('a1'))?.title ?? ''), J(await card('a1')));

    await perm(s, { id: 'a2', tool: 'Edit' });
    await until(async () => (await region()) === 'Permission needed: Edit');
    check('stacked-cards-announce-in-order', J((await said()).filter(Boolean)) === J(['Permission needed: Bash', 'Permission needed: Edit']), J(await said()));

    const box = await evaluate(s, `(() => {
      const el = document.querySelector('[data-perm-announcer]');
      const r = el?.getBoundingClientRect();
      const cs = el && getComputedStyle(el);
      return el && {
        w: r.width, h: r.height, overflow: cs.overflow, clip: cs.clip, clipPath: cs.clipPath,
        live: el.getAttribute('aria-live'), atomic: el.getAttribute('aria-atomic'), inLog: !!el.closest('[role="log"]'),
      };
    })()`);
    const clipped = box && (/rect\(0(px)?, 0(px)?, 0(px)?, 0(px)?\)/.test(box.clip) || (box.clipPath && box.clipPath !== 'none'));
    check('announcer-is-one-by-one-and-clipped', box?.w === 1 && box?.h === 1 && box.overflow === 'hidden' && clipped, J(box));
    check('announcer-is-assertive-and-atomic', box?.live === 'assertive' && box?.atomic === 'true', J(box));
    check('announcer-sits-outside-the-transcript', box && !box.inLog, J(box));
    const logs = await evaluate(s, `[...document.querySelectorAll('[role="log"]')].length`);
    check('transcript-keeps-role-log', logs === 1, `logs=${logs}`);

    await click(s, 'Allow');
    check('answering-a-card-clears-the-announcer', (await decided(s, 'a1')) === 'allow' && (await until(async () => (await region()) === '')) === true, J(await region()));
    await click(s, 'Allow');
    await decided(s, 'a2');

    await evaluate(s, `window.__said.length = 0`);
    await perm(s, { id: 'a3', tool: 'Bash' });
    await perm(s, { id: 'a4', tool: 'Bash' });
    await until(async () => (await said()).filter((t) => t.trim()).length >= 2, 2000);
    const repeats = (await said()).filter((t) => t.trim());
    check('a-second-card-of-the-same-tool-is-announced-again',
      repeats.length === 2 && repeats.every((t) => t.trim() === 'Permission needed: Bash'), J(repeats));
    await click(s, 'Allow');
    await decided(s, 'a3');
    await click(s, 'Allow');
    await decided(s, 'a4');

    const ask = { questions: [{ question: 'Which coupon?', header: 'Coupon', multiSelect: false, options: [{ label: 'SAVE10', description: 'ten off' }, { label: 'none', description: 'skip' }] }] };
    await perm(s, { id: 'q1', tool: 'AskUserQuestion', input: ask });
    const asked = await until(async () => (await region()) === 'Question from the agent');
    check('announcer-reads-a-question-as-one', !!asked, J(await region()));
    const q = await card('q1');
    check('question-card-is-named-by-its-heading', q?.role === 'group' && /asking/i.test(q.title ?? ''), J(q));
    await click(s, 'Skip');
    await until(async () => (await region()) === '');

    await perm(s, { id: 'a3', tool: 'Write' });
    await until(async () => (await region()) === 'Permission needed: Write');
    await evaluate(s, `window.connChat.newChat()`);
    check('leaving-a-chat-clears-the-announcer', !!(await until(async () => (await region()) === '')), J(await region()));
    await click(s, 'look at the cart');
    const waitingCard = await until(() => card('a3'));
    await sleep(300);
    check('returning-to-a-chat-announces-nothing-for-its-waiting-card', !!waitingCard && (await region()) === '', `${J(waitingCard)} ${J(await region())}`);
    await click(s, 'Allow');
    await decided(s, 'a3');

    await say(s, 'Trying again.', { prompt: 'try again', open: true });
    await emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 3600, rateLimitType: 'five_hour' } });
    await emit({ type: 'assistant', parent_tool_use_id: null, error: 'rate_limit', message: { role: 'assistant', content: [{ type: 'text', text: "You've hit your session limit · resets 8:30pm (Asia/Kolkata)" }] } });
    await emit({ type: 'result', subtype: 'error_during_execution', is_error: true, duration_ms: 2100, errors: [] });
    const alert = await until(() => evaluate(s, `document.querySelector('#agent-root [data-turn-error]')?.getAttribute('role') ?? null`));
    check('turn-error-row-is-an-alert', alert === 'alert', J(alert));
  } finally {
    await stop(s);
  }
}

async function main() {
  checkBindings();
  checkStoredKeybindings();

  const drive = await import(pathToFileURL(path.join(ROOT, '.claude/skills/verify/drive.mjs')).href);
  const { boot, stop, evaluate, click, say, perm, decided, key, type, shot } = drive;
  const s = await boot({ root: ROOT, xvfb: true });

  try {
    const inMain = (expr) => evaluate(s, expr, { main: true });
    const until = async (fn, ms = 4000) => {
      const end = Date.now() + ms;
      let got;
      while (Date.now() < end && !(got = await fn())) await sleep(100);
      return got;
    };
    const BOX = `document.querySelector('#agent-root [contenteditable="true"]')`;
    const busy = () => evaluate(s, `!!document.querySelector('#agent-root button[type="submit"] .lucide-square')`);
    const interrupts = () => inMain('globalThis.__interrupts.length');
    const boxText = () => evaluate(s, `${BOX}.textContent`);
    const caretBefore = () => evaluate(s, `(() => {
      const r = getSelection().getRangeAt(0);
      const upto = r.cloneRange();
      upto.selectNodeContents(${BOX});
      upto.setEnd(r.startContainer, r.startOffset);
      return upto.toString().length;
    })()`);
    const focusBox = () => evaluate(s, `${BOX}.focus()`);
    const focusTerminal = () => evaluate(s, `document.querySelector('#terms .xterm-helper-textarea').focus()`);
    const onCard = () => evaluate(s, `document.activeElement?.dataset?.permAllow || null`);
    const inComposer = () => evaluate(s, `document.activeElement === ${BOX}`);
    const dialogOpen = () => evaluate(s, `!!document.querySelector('[role="dialog"]')`);
    const sendPrompt = async (text) => {
      await focusBox();
      await type(s, text);
      await key(s, 'Enter');
      await until(() => busy());
    };

    await click(s, 'Later').catch(() => {});
    await inMain(`(() => {
      const { AgentSession } = req('./agent');
      globalThis.__interrupts = [];
      AgentSession.prototype.interrupt = async function interrupt() { globalThis.__interrupts.push(Date.now()); };
      return true;
    })()`);
    await say(s, 'On it.', { prompt: 'first prompt', open: true });
    check('turn-is-running-before-the-keys', await busy(), 'no stop square on the send button');

    const submitTitle = () => evaluate(s, `document.querySelector('#agent-root button[type="submit"]').title`);
    check('stop-button-tooltip-shows-the-key', (await submitTitle()) === 'Stop (Escape)', J(await submitTitle()));
    await evaluate(s, `window.conn.settings.set({ keybindings: { stopTurn: '' } })`, { awaitPromise: true });
    await until(async () => (await submitTitle()) === 'Stop');
    check('stop-button-tooltip-drops-the-key-when-unbound', (await submitTitle()) === 'Stop', J(await submitTitle()));
    await evaluate(s, `window.conn.settings.set({ keybindings: { stopTurn: 'Escape' } })`, { awaitPromise: true });
    await until(async () => (await submitTitle()) === 'Stop (Escape)');

    await focusBox();
    await key(s, 'Ctrl+K');
    const palette = await until(() => dialogOpen());
    await key(s, 'Escape');
    await until(async () => !(await dialogOpen()));
    await shot(s, SHOT('dialog-escape'));
    check('escape-over-a-dialog-closes-it', palette && !(await dialogOpen()), `palette=${palette} stillOpen=${await dialogOpen()}`);
    check('escape-over-a-dialog-does-not-interrupt', (await interrupts()) === 0 && (await busy()), `interrupts=${await interrupts()}`);

    await key(s, 'Ctrl+Shift+T');
    await until(() => evaluate(s, `!!document.querySelector('#terms .xterm-rows')`));
    await focusTerminal();
    await type(s, 'cat -v', { enter: true });
    await sleep(500);
    await key(s, 'Escape');
    await key(s, 'Enter');
    await sleep(500);
    const rows = await evaluate(s, `document.querySelector('#terms .xterm-rows').innerText`);
    await key(s, 'Ctrl+C');
    await shot(s, SHOT('terminal-escape'));
    check('escape-in-the-terminal-does-not-interrupt', (await interrupts()) === 0 && (await busy()), `interrupts=${await interrupts()}`);
    check('escape-in-the-terminal-reaches-the-shell', rows.includes('^['), J(rows.slice(-200)));

    await evaluate(s, `document.activeElement.blur()`);
    await perm(s, { id: 'p1', tool: 'Bash' });
    const first = await until(() => onCard());
    await shot(s, SHOT('perm-focus'));
    check('arriving-card-takes-focus-on-its-allow-button', first === 'p1', `focused=${first}`);
    await perm(s, { id: 'p2', tool: 'Edit' });
    check('second-card-does-not-take-focus-from-the-first', (await onCard()) === 'p1', `focused=${await onCard()}`);

    await focusTerminal();
    await key(s, 'Ctrl+Shift+A');
    const jumped = await until(() => onCard());
    await shot(s, SHOT('jump'));
    check('jump-from-the-terminal-focuses-the-waiting-card', jumped === 'p1', `focused=${jumped}`);
    await click(s, 'css=[role=log]');
    await key(s, 'Ctrl+Shift+A');
    const ring = await evaluate(s, `getComputedStyle(document.activeElement).boxShadow`);
    check('jump-after-a-mouse-click-draws-a-focus-ring', /\d+px/.test(ring) && !/^none$/.test(ring), `box-shadow=${ring}`);
    if (jumped !== 'p1') await evaluate(s, `document.querySelector('[data-perm-allow="p1"]')?.focus()`);

    await key(s, 'y');
    check('y-allows-the-card', (await decided(s, 'p1')) === 'allow', J(await decided(s)));
    const next = await until(() => onCard());
    check('focus-moves-to-the-next-card', next === 'p2', `focused=${next}`);
    await key(s, 'n');
    check('n-denies-the-next-card', (await decided(s, 'p2')) === 'deny', J(await decided(s)));
    const home = await until(() => inComposer());
    await shot(s, SHOT('perm-keys'));
    check('focus-lands-in-the-composer-after-the-last-card', !!home, `active=${await evaluate(s, 'document.activeElement?.tagName')}`);
    check('no-key-leaked-into-the-composer', (await boxText()) === '', J(await boxText()));

    await perm(s, { id: 'p3', tool: 'Write' });
    await until(async () => (await onCard()) === 'p3');
    await key(s, 'a');
    check('a-always-allows-the-card', (await decided(s, 'p3')) === 'always', J(await decided(s)));
    await until(() => inComposer());

    await focusBox();
    const ask = { questions: [{ question: 'Which coupon?', header: 'Coupon', multiSelect: false, options: [{ label: 'SAVE10', description: 'ten off' }, { label: 'none', description: 'skip' }] }] };
    await perm(s, { id: 'q1', tool: 'AskUserQuestion', input: ask });
    check('question-card-does-not-take-focus-on-arrival', await inComposer(), `active=${await evaluate(s, 'document.activeElement?.tagName')}`);
    await key(s, 'Ctrl+Shift+A');
    const inQuestion = await evaluate(s, `!!document.activeElement?.closest('[data-perm-card="q1"]')`);
    check('jump-focuses-the-first-control-of-a-question-card', inQuestion, `active=${await evaluate(s, 'document.activeElement?.outerHTML?.slice(0, 80)')}`);
    await key(s, 'y');
    check('y-on-a-question-card-is-not-an-answer', (await decided(s, 'q1')) === null, J(await decided(s)));
    await focusBox();
    await key(s, 'Escape');
    await until(async () => !(await busy()));
    await shot(s, SHOT('composer-escape'));
    check('escape-in-the-composer-interrupts-the-turn', !(await busy()) && (await interrupts()) === 1,
      `busy=${await busy()} interrupts=${await interrupts()}`);

    await sendPrompt('second prompt');
    await evaluate(s, `document.activeElement.blur()`);
    await key(s, 'Escape');
    await until(async () => !(await busy()));
    check('escape-with-nothing-focused-interrupts-the-turn', !(await busy()) && (await interrupts()) === 2,
      `busy=${await busy()} interrupts=${await interrupts()}`);

    await sendPrompt('third prompt');
    await say(s, 'Done.');
    await until(async () => !(await busy()));

    await focusBox();
    const seen = [];
    for (let i = 0; i < 3; i += 1) {
      await key(s, 'Up');
      seen.push(await boxText());
    }
    await shot(s, SHOT('history'));
    check('up-walks-back-to-the-first-prompt', J(seen) === J(['third prompt', 'second prompt', 'first prompt']), J(seen));
    await key(s, 'Up');
    check('up-stops-at-the-oldest-prompt', (await boxText()) === 'first prompt', J(await boxText()));
    check('history-puts-the-caret-at-the-end', (await caretBefore()) === 'first prompt'.length, `caret=${await caretBefore()}`);
    const back = [];
    for (let i = 0; i < 3; i += 1) {
      await key(s, 'Down');
      back.push(await boxText());
    }
    check('down-past-the-newest-restores-the-empty-box', J(back) === J(['second prompt', 'third prompt', '']), J(back));

    await key(s, 'Up');
    await type(s, '!');
    await key(s, 'Up');
    check('editing-a-recalled-prompt-ends-the-browsing', (await boxText()) === 'third prompt!', J(await boxText()));
    await key(s, 'Ctrl+A');
    await key(s, 'Backspace');

    await type(s, 'my draft');
    await key(s, 'Up');
    check('up-in-a-typed-draft-does-not-load-history', (await boxText()) === 'my draft', J(await boxText()));

    await key(s, 'Ctrl+A');
    await key(s, 'Backspace');
    await type(s, 'first');
    await key(s, 'Home');
    await type(s, 'second');
    await key(s, 'Shift+Enter');
    await key(s, 'End');
    const draft = await boxText();
    const before = await caretBefore();
    await key(s, 'Up');
    await shot(s, SHOT('multiline'));
    check('up-on-line-two-leaves-the-text-alone', (await boxText()) === draft, `${J(draft)} -> ${J(await boxText())}`);
    check('up-on-line-two-moves-the-caret-to-line-one', (await caretBefore()) < before && (await caretBefore()) <= 'second'.length,
      `caret ${before} -> ${await caretBefore()}`);

    await key(s, 'Ctrl+A');
    await key(s, 'Backspace');
    await type(s, '$');
    const menu = await until(() => evaluate(s, `!!document.getElementById('composer-mentions')`));
    const picked = () => evaluate(s, `${BOX}.getAttribute('aria-activedescendant')`);
    const at = await picked();
    await key(s, 'Up');
    await shot(s, SHOT('mention-menu'));
    check('up-in-the-mention-menu-moves-the-selection', menu && (await picked()) !== at, `menu=${menu} ${at} -> ${await picked()}`);
    check('up-in-the-mention-menu-does-not-load-history', (await boxText()) === '$', J(await boxText()));
  } finally {
    await stop(s);
  }

  await checkScreenReaderCues(drive);

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
