'use strict';
/* The chat overview floats in the gutter right of the chat column: the folder
   and branch, the panes to open, the PRs the chat opened, the files it changed
   and the work still running in the background. It folds to one button when it
   would not fit or the right column is open, and can be folded by choice. Needs
   a built renderer: `npx vite build` first. Screenshots go to OVERVIEW_SHOTS
   (default the temp dir), named with OVERVIEW_TAG. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = process.env.CONN_ROOT || path.join(__dirname, '..');
const SHOTS = process.env.OVERVIEW_SHOTS || os.tmpdir();
const TAG = process.env.OVERVIEW_TAG || 'overview';
const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
};

const SHOT = (name) => path.join(SHOTS, `${TAG}-${name}.png`);
const call = (id, name, input) => ({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const back = (id, text) => ({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });

async function main() {
  const drive = await import(pathToFileURL(path.join(ROOT, '.claude/skills/verify/drive.mjs')).href);
  const { boot, stop, evaluate, click, key, say, shot } = drive;
  const s = await boot({ root: ROOT, xvfb: true });

  try {
    const emit = (msg) => evaluate(s, `globalThis.__agent.emit('message', ${J(msg)})`, { main: true });
    const js = (code) => evaluate(s, code);
    const tap = (target) => click(s, target).catch((e) => console.log(`  could not click ${target}: ${e.message}`));
    const until = async (fn, ms = 5000) => {
      const end = Date.now() + ms;
      let got;
      while (Date.now() < end && !(got = await fn())) await sleep(150);
      return got;
    };
    const resize = (w, h) => evaluate(s, `electron.BrowserWindow.getAllWindows()[0].setContentSize(${w}, ${h})`, { main: true });
    const state = () => js(`(() => {
      const box = (el) => el && (({ left, right, top, bottom, width }) => ({ left, right, top, bottom, width }))(el.getBoundingClientRect());
      const panel = document.querySelector('[data-slot="overview-panel"]');
      const button = document.querySelector('[data-slot="overview-button"]');
      const pop = document.querySelector('[data-slot="popover-content"] [data-slot="overview-content"]');
      const content = pop || panel;
      const right = document.querySelector('section#right');
      return {
        panel: box(panel),
        button: box(button),
        popover: !!pop,
        column: box(document.querySelector('[data-chat-column]')),
        text: content?.innerText ?? '',
        places: [...(content?.querySelectorAll('[data-overview-place]') ?? [])].map((b) => ({ kind: b.dataset.overviewPlace, current: b.getAttribute('aria-current'), tag: b.tagName })),
        prs: [...(content?.querySelectorAll('[data-overview-pr]') ?? [])].map((a) => ({ id: a.dataset.overviewPr, href: a.getAttribute('href'), text: a.innerText, tag: a.tagName })),
        files: [...(content?.querySelectorAll('[data-overview-file]') ?? [])].map((b) => ({ path: b.dataset.overviewFile, text: b.innerText, tag: b.tagName })),
        tasks: [...(content?.querySelectorAll('[data-overview-task]') ?? [])].map((b) => ({ id: b.dataset.overviewTask, text: b.innerText, tag: b.tagName })),
        rightShown: !!right && right.getBoundingClientRect().width > 1 && right.getBoundingClientRect().left < innerWidth,
        rightText: right?.innerText ?? '',
        tab: right?.querySelector('[role="tab"][data-state="active"]')?.innerText.trim() ?? null,
        stored: localStorage.getItem('conn.overview.collapsed'),
      };
    })()`);

    await click(s, 'Later').catch(() => {});
    const blank = await state();
    check('empty-chat-has-no-overview', !blank.panel && !blank.button, J(blank));

    fs.writeFileSync(path.join(s.project, 'index.html'), fs.readFileSync(path.join(s.project, 'index.html'), 'utf8').replace('Your cart', 'Your basket'));
    fs.writeFileSync(path.join(s.project, 'notes.txt'), 'first line\nsecond line\n');

    await say(s, 'Renaming the heading.', { open: true });
    await emit(call('toolu_edit', 'Edit', { file_path: path.join(s.project, 'index.html'), old_string: '<h1>Your cart</h1>', new_string: '<h1>Your basket</h1>' }));
    await emit(back('toolu_edit', 'The file has been updated.'));
    await emit(call('toolu_write', 'Write', { file_path: path.join(s.project, 'notes.txt'), content: 'first line\nsecond line\n' }));
    await emit(back('toolu_write', 'File created.'));
    await emit(call('toolu_pr', 'Bash', { command: 'gh pr create --base main --title "$title" --body x' }));
    await emit(back('toolu_pr', 'https://github.com/o/r/pull/12'));
    await emit(call('toolu_pr2', 'Bash', { command: 'gh pr create --title "fix(cart): coupon rounding" --body x' }));
    await emit(back('toolu_pr2', 'https://github.com/o/r/pull/14'));
    await emit(call('toolu_dev', 'Bash', { command: 'npm run dev', run_in_background: true }));
    await emit({ type: 'system', subtype: 'task_started', task_id: 'bg1', tool_use_id: 'toolu_dev', is_backgrounded: true });
    await emit(back('toolu_dev', 'Command running in background with ID: bg1'));
    await say(s, 'Opened [fix(cart): coupon rounding](https://github.com/o/r/pull/14), after https://github.com/o/r/pull/12. The issue was https://github.com/o/r/issues/3.');

    const full = await until(async () => { const st = await state(); return st.panel && st.files.length === 2 && st.tasks.length && st; });
    const st = full || await state();
    check('panel-floats-at-1440-with-the-rail-open', !!st.panel && !st.button, J({ panel: st.panel, button: st.button }));
    check('panel-sits-beside-the-column-without-overlap', !!st.panel && !!st.column && st.panel.left >= st.column.right, J({ panel: st.panel, column: st.column }));
    check('header-names-folder-and-branch', /shop/.test(st.text) && /main/.test(st.text), J(st.text));
    check('places-are-changes-browser-terminal-files', J(st.places.map((p) => p.kind)) === J(['changes', 'browser', 'terminal', 'files']), J(st.places));
    check('prs-opened-by-the-chat-newest-first-with-title', J(st.prs.map((p) => p.id)) === J(['o/r#14', 'o/r#12']) && /coupon rounding/.test(st.prs[0]?.text) && /#14/.test(st.prs[0]?.text), J(st.prs));
    check('a-shell-variable-title-is-not-shown', !/\$title/.test(st.text), J(st.text));
    check('prs-are-real-links', st.prs.length > 0 && st.prs.every((p) => p.tag === 'A' && p.href?.startsWith('https://github.com/')), J(st.prs));
    check('files-with-counts', st.files.some((f) => f.path.endsWith('index.html') && /\+1/.test(f.text) && /-1/.test(f.text)) && st.files.some((f) => f.path.endsWith('notes.txt') && /\+2/.test(f.text)), J(st.files));
    check('background-shell-listed', st.tasks.length === 1 && /npm run dev/.test(st.tasks[0].text), J(st.tasks));
    const entries = [...st.places, ...st.files, ...st.tasks];
    check('entries-are-buttons', entries.length >= 7 && entries.every((b) => b.tag === 'BUTTON'), J(entries));
    await shot(s, SHOT('1440-panel-beside-the-chat'));

    const fixed = await js(`(() => {
      const panel = document.querySelector('[data-slot="overview-panel"]');
      return !!panel && !panel.closest('[role="log"]') && getComputedStyle(panel).position;
    })()`);
    check('panel-is-outside-the-scrolling-transcript', fixed === 'absolute', J(fixed));

    await tap('css=[data-slot="overview-panel"] [data-overview-place="changes"]');
    const opened = await until(async () => { const x = await state(); return x.rightShown && x.rightText.includes('index.html') && x; }, 10000);
    check('clicking-changes-opens-the-changes-pane', !!opened, J(await state()));
    const folded = await until(async () => { const x = await state(); return x.button && !x.panel && x; });
    check('right-column-open-folds-the-panel-to-a-button', !!folded, J(await state()));
    await shot(s, SHOT('changes-pane-open-panel-folded'));
    await tap('css=[data-slot="overview-button"]');
    const pop = await until(async () => { const x = await state(); return x.popover && x; });
    check('button-opens-the-same-content-as-a-popover', !!pop && pop.prs.length === 2 && pop.files.length === 2, J(pop));
    check('open-pane-is-marked-current', !!pop && pop.places.find((p) => p.kind === 'changes')?.current === 'true'
      && pop.places.filter((p) => p.current === 'true').length === 1, J(pop?.places));
    check('changes-carries-the-uncommitted-count', !!pop && /Changes\s*2/.test(pop.text), J(pop?.text));
    await shot(s, SHOT('right-column-open-popover'));
    await key(s, 'Escape');
    await key(s, 'Ctrl+Shift+G');
    const back2 = await until(async () => { const x = await state(); return x.panel && !x.rightShown && x; });
    check('closing-the-right-column-brings-the-panel-back', !!back2, J(await state()));

    await tap('css=[data-slot="overview-panel"] [data-overview-file$="index.html"]');
    const file = await until(async () => { const x = await state(); return x.rightShown && x.tab === 'Files' && x.rightText.includes('Your basket') && x; }, 10000);
    check('clicking-a-file-opens-it-in-files', !!file, J((await state()).rightText.slice(0, 300)));
    await key(s, 'Ctrl+Shift+D');
    await until(async () => !(await state()).rightShown);

    await tap('css=[aria-label="Collapse overview"]');
    const chosen = await until(async () => { const x = await state(); return x.button && !x.panel && x; });
    check('collapse-control-folds-to-the-button', !!chosen, J(await state()));
    check('collapse-choice-is-remembered', chosen?.stored === '1', J(chosen?.stored));
    await tap('css=[data-slot="overview-button"]');
    await until(async () => (await state()).popover);
    await tap('css=[aria-label="Show as panel"]');
    const unfolded = await until(async () => { const x = await state(); return x.panel && x.stored !== '1' && x; });
    check('show-as-panel-undoes-the-choice', !!unfolded, J(await state()));

    await resize(1000, 760);
    const narrow = await until(async () => { const x = await state(); return x.button && !x.panel && x; });
    check('narrow-window-folds-to-the-button', !!narrow, J(await state()));
    check('narrow-button-does-not-cover-the-column', !!narrow?.button && !!narrow.column && narrow.button.left >= narrow.column.right, J(narrow));
    await tap('css=[data-slot="overview-button"]');
    const narrowPop = await until(async () => { const x = await state(); return x.popover && x; });
    check('narrow-popover-shows-the-overview', !!narrowPop && narrowPop.prs.length === 2, J(narrowPop));
    await shot(s, SHOT('narrow-1000-popover'));
    await key(s, 'Escape');
    await resize(1440, 900);
    await until(async () => (await state()).panel);

    await tap("css=button[title^='Following the system']").catch(() => {});
    await sleep(400);
    check('light-theme-applies', await js(`!document.documentElement.classList.contains('dark')`), 'still dark');
    await shot(s, SHOT('1440-light-theme'));

    await tap('css=[data-slot="overview-panel"] [data-overview-pr="o/r#14"]');
    const browsed = await until(() => js(`(() => { const u = document.querySelector('#url'); return u && u.value.includes('github.com/o/r/pull/14') && u.value; })()`), 8000);
    check('clicking-a-pr-opens-it-in-the-browser-pane', !!browsed, J(browsed));
  } finally {
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
