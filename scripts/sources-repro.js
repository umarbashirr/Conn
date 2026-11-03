'use strict';
/* A turn that searched or fetched from the web (CUX-9). A WebSearch row lists
   its results as links, and the reply that follows carries a closed
   "Used N sources" line listing each unique URL once. A plain click on a
   source loads it in the Browser pane. A turn with no web tools gets no line.
   Needs a built renderer: `npx vite build` first. Set SHOT_DIR to keep the
   screenshots. */
const fs = require('fs');
const http = require('http');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = process.env.CONN_ROOT || path.join(__dirname, '..');
const OUT = process.env.SHOT_DIR || require('os').tmpdir();
const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/web-tools.json'), 'utf8'));

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
};

const call = (id, name, input) => ({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const back = (id, text) => ({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });

async function main() {
  const page = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>Local docs page</title><h1 id="landed">Local docs page loaded</h1>');
  });
  await new Promise((r) => page.listen(0, '127.0.0.1', r));
  const local = `http://127.0.0.1:${page.address().port}/docs/trace`;

  const drive = await import(pathToFileURL(path.join(ROOT, '.claude/skills/verify/drive.mjs')).href);
  const { boot, stop, evaluate, click, say, shot, invoke } = drive;
  const s = await boot({ root: ROOT, xvfb: true });

  try {
    const emit = (msg) => evaluate(s, `globalThis.__agent.emit('message', ${J(msg)})`, { main: true });
    const until = async (fn, ms = 4000) => {
      const end = Date.now() + ms;
      let got;
      while (Date.now() < end && !(got = await fn())) await sleep(100);
      return got;
    };
    const read = (sel) => evaluate(s, `(() => {
      const el = document.querySelector(${J(sel)});
      return el && { text: el.innerText, links: [...el.querySelectorAll('a')].map((a) => a.href) };
    })()`);

    await click(s, 'Later').catch(() => {});

    const searched = fixture.WebSearch.content.replace('Links: [', `Links: [{"title":"Local docs page","url":${J(local)}},`);
    await say(s, 'Let me look that up.', { open: true });
    await emit(call('toolu_search', 'WebSearch', fixture.WebSearch.input));
    await emit(back('toolu_search', searched));
    await emit(call('toolu_fetch', 'WebFetch', { ...fixture.WebFetch.input, url: 'https://docs.example.com/guide' }));
    await emit(back('toolu_fetch', fixture.WebFetch.content));
    await say(s, 'Trace is a list of lines for the steps an agent takes.');

    await click(s, 'css=#row-toolu_search button');
    const body = await until(async () => (await read('#row-toolu_search [data-slot="source-list"]')));
    check('search-row-body-lists-ten-results-as-links', !!body && body.links.length === 10, J(body));
    check('search-row-body-shows-the-host-beside-a-title', !!body && body.text.includes('ui.shadcn.com'), J(body));
    const rowText = await evaluate(s, `document.querySelector('#row-toolu_search').innerText`);
    check('search-row-no-longer-prints-the-links-json', !rowText.includes('"url"') && !rowText.includes('Links: ['), rowText.slice(0, 200));
    await shot(s, path.join(OUT, 'search-row-expanded.png'));

    const line = await until(async () => (await read('[data-sources]')));
    check('sources-line-counts-unique-urls', !!line && line.text.trim() === 'Used 11 sources', J(line));
    const closed = await evaluate(s, `document.querySelector('[data-sources] button')?.getAttribute('aria-expanded')`);
    check('sources-line-is-closed-by-default', closed === 'false', closed);
    await shot(s, path.join(OUT, 'sources-line-closed.png'));

    await click(s, 'css=[data-sources] button');
    const open = await until(async () => (await read('[data-sources] [data-slot="source-list"]')));
    check('sources-line-opens-to-eleven-links', !!open && open.links.length === 11, J(open));
    check('sources-line-lists-the-fetch-by-host', !!open && open.text.includes('docs.example.com'), J(open));
    await shot(s, path.join(OUT, 'sources-line-expanded.png'));

    await click(s, 'css=[data-sources] a[href*="/docs/trace"]');
    const landed = await until(async () => {
      const t = await invoke(s, 'text').catch(() => null);
      return t && J(t).includes('Local docs page loaded');
    }, 6000);
    check('clicking-a-source-loads-it-in-the-browser-pane', !!landed, J(landed));
    await sleep(500);
    await shot(s, path.join(OUT, 'source-opened-in-browser-pane.png'));

    await say(s, 'Now something without the web.', { prompt: 'plain question' });
    await emit(call('toolu_ls', 'Bash', { command: 'ls' }));
    await emit(back('toolu_ls', 'a b c'));
    await say(s, 'Nothing from the web here.');
    const lines = await evaluate(s, `document.querySelectorAll('[data-sources]').length`);
    check('turn-without-web-tools-adds-no-line', lines === 1, lines);
  } finally {
    await stop(s);
    page.close();
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
