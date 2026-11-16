'use strict';
// One definition of the browser tool surface, used three ways: over the bridge
// by the conn CLI, over stdio by the MCP server, and in-process by the agent
// panel. Only the transport differs.

/* Results are written for the model to read, once per call and again on
   every later turn, so each says what happened in a line rather than as
   pretty-printed JSON with every field the shell uses. */
const ROW_CHARS = 300;          // one console message or request URL
const EVALUATE_CHARS = 10000;   // what a script hands back
// How much a read hands an agent that names no amount: a page's worth rather
// than all of it, with a cut that says how much there was. The pane's own
// defaults are larger, and are what the conn CLI prints.
const READ = { text: 8000, html: 20000, snapshot: 400, rows: 20 };

// The first n characters, one fewer when the nth is the first half of an
// emoji or other pair: half a pair is not text, and encoders mangle it.
const cut = (t, n) => t.slice(0, /[\uD800-\uDBFF]/.test(t[n - 1] || '') ? n - 1 : n);
const clip = (v, n) => { const t = String(v ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${cut(t, n)}…` : t; };
const quote = (v) => JSON.stringify(clip(v, 80));
const capped = (t, n) => (t.length > n ? `${cut(t, n)}\n… truncated at ${n} of ${t.length} characters` : t);
// A console source is usually a long URL; its file and line say enough, and
// an inline script has no file to name.
const where = (src) => { const w = String(src || '').replace(/^.*\//, ''); return w.startsWith(':') ? '' : ` (${w})`; };
// Electron's own notices reach the page's console from its bundled scripts.
// They are about the app, never the page.
const electronOwn = (r) => /^(?:node:)?electron\//.test(String(r.source || ''));

// Where the tab is now. The rest of state() is for the shell's own toolbar.
const page = (r) => [
  `${r.url || 'about:blank'}${r.title ? ` "${r.title}"` : ''}`,
  r.loading && 'still loading',
  r.viewport && `viewport ${r.viewport}`,
  r.recording && 'recording',
  r.error && `error: ${r.error}`,
  r.warning,
  r.note,
].filter(Boolean).join('; ');

const tabLine = (r) => `tab ${r.tab}: ${r.url || 'about:blank'}${r.title ? ` "${r.title}"` : ''}`;

const requestLine = (r) => (r.kind === 'navigation-failed'
  ? `page failed to load: ${r.desc} (${r.code}) ${clip(r.url, ROW_CHARS)}`
  : `${r.status || r.error || 'failed'} ${r.method || ''} ${clip(r.url, ROW_CHARS)}`.replace(/\s+/g, ' '));

/**
 * `label` is what the transcript calls the tool. `routes` lists every bridge
 * route `route()` can pick.
 * @param {typeof import('zod').z} z
 * @returns {Array<{name: string, bridgeTool: string, label: string, title: string, description: string,
 *                  schema: object, format?: 'image', map?: (a: object) => object,
 *                  route?: (a: object) => string, routes?: string[]}>}
 */
function browserTools(z) {
  return [
    {
      name: 'browser_navigate', bridgeTool: 'navigate', label: 'Open page', title: 'Open a URL',
      description: 'Load a URL in the tab you drive. Bare ports work: "3000" is http://localhost:3000.',
      schema: { url: z.string() },
      render: page,
    },
    {
      name: 'browser_snapshot', bridgeTool: 'snapshot', label: 'Read page', title: 'Snapshot the page',
      description: 'Outline of the page, same-origin iframes included, with [ref=eN] handles the other tools take. Refs reset on navigation.',
      schema: { max: z.number().optional() },
      map: (a) => ({ ...a, max: a.max ?? READ.snapshot }),
    },
    {
      name: 'browser_text', bridgeTool: 'text', label: 'Read text', title: 'Read page text',
      description: `Visible text of the page, up to max characters (${READ.text} by default).`,
      schema: { max: z.number().optional() },
      map: (a) => ({ ...a, max: a.max ?? READ.text }),
    },
    {
      name: 'browser_html', bridgeTool: 'html', label: 'Read HTML', title: 'Read page HTML',
      description: `Outer HTML of the page, up to max characters (${READ.html} by default).`,
      schema: { max: z.number().optional() },
      map: (a) => ({ ...a, max: a.max ?? READ.html }),
    },
    {
      name: 'browser_click', bridgeTool: 'click', label: 'Click', title: 'Click',
      description: 'Click an element by ref or CSS selector, with a real mouse event.',
      schema: { target: z.string(), button: z.enum(['left', 'right', 'middle']).optional(), clickCount: z.number().optional() },
      render: (r) => `clicked ${r.clicked}`,
    },
    {
      name: 'browser_fill', bridgeTool: 'fill', label: 'Fill', title: 'Fill a field',
      description: 'Set the value of an input, textarea or contenteditable and fire input and change.',
      schema: { target: z.string(), value: z.string() },
      render: (r, a) => `filled ${a.target} = ${quote(r.value)}`,
    },
    {
      name: 'browser_type', bridgeTool: 'type', label: 'Type', title: 'Type',
      description: 'Send real keystrokes, into target if given. Use it when the page listens for keydown.',
      schema: { text: z.string(), target: z.string().optional(), delay: z.number().optional() },
      render: (r) => `typed ${r.typed} characters`,
    },
    {
      name: 'browser_press', bridgeTool: 'press', label: 'Press key', title: 'Press a key',
      description: 'Press a key or chord: "Enter", "Escape", "ctrl+a".',
      schema: { key: z.string() },
      render: (r) => `pressed ${r.key}`,
    },
    {
      name: 'browser_select', bridgeTool: 'select', label: 'Select', title: 'Select an option',
      description: 'Choose an option in a select element.',
      schema: { target: z.string(), value: z.string() },
      render: (r, a) => `selected ${quote(r.value)} in ${a.target}`,
    },
    {
      name: 'browser_hover', bridgeTool: 'hover', label: 'Hover', title: 'Hover',
      description: 'Move the mouse over an element, for menus and tooltips.',
      schema: { target: z.string() },
      render: (_r, a) => `hovered ${a.target}`,
    },
    {
      name: 'browser_scroll', bridgeTool: 'scroll', label: 'Scroll', title: 'Scroll',
      description: 'Scroll by dy pixels, or bring target into view.',
      schema: { dy: z.number().optional(), target: z.string().optional() },
      route: (a) => (a.target ? 'scrollTo' : 'scroll'),
      routes: ['scroll', 'scrollTo'],
      render: (r) => `scrolled to y=${Math.round(r.y)}`,
    },
    {
      name: 'browser_screenshot', bridgeTool: 'screenshot', label: 'Screenshot', title: 'Screenshot',
      description: 'Capture the page as an image, for visual checks. It is sent small; detail "high" sends more pixels.',
      schema: { fullPage: z.boolean().optional(), target: z.string().optional(), detail: z.enum(['high']).optional() },
      format: 'image',
    },
    {
      name: 'browser_record', bridgeTool: 'record', label: 'Record', title: 'Record the page',
      description: 'Video of the page, no sound. "start" begins it (it stops by itself after maxSeconds, 60 by default, 120 at most, and keeps the file); "stop" returns its path, length and three stills to look at. Act in between to record it. name is a file name.',
      schema: { action: z.enum(['start', 'stop']), name: z.string().optional(), maxSeconds: z.number().optional() },
      format: 'recording',
    },
    {
      name: 'browser_console', bridgeTool: 'console', label: 'Console', title: 'Read the console',
      description: `Console messages since the last navigation, the last ${READ.rows} unless limit says; full keeps long ones whole.`,
      schema: { level: z.enum(['debug', 'info', 'warning', 'error']).optional(), limit: z.number().optional(), full: z.boolean().optional() },
      map: (a) => ({ ...a, limit: a.limit ?? READ.rows }),
      render: (rows, a) => rows.filter((r) => !electronOwn(r))
        .map((r) => `[${r.level}] ${a.full ? r.message : clip(r.message, ROW_CHARS)}${where(r.source)}`).join('\n') || '(console is empty)',
    },
    {
      name: 'browser_network', bridgeTool: 'network', label: 'Network', title: 'Read failed requests',
      description: 'Requests that failed or returned 4xx/5xx since the last navigation.',
      schema: { limit: z.number().optional() },
      map: (a) => ({ ...a, limit: a.limit ?? READ.rows }),
      render: (rows) => (rows.length ? rows.map(requestLine).join('\n') : '(no failed requests)'),
    },
    {
      name: 'browser_evaluate', bridgeTool: 'evaluate', label: 'Run script', title: 'Run JavaScript',
      description: 'Run JavaScript in the page and return the result.',
      schema: { code: z.string() },
      render: (v) => capped(typeof v === 'string' ? v : JSON.stringify(v) ?? 'undefined', EVALUATE_CHARS),
    },
    {
      name: 'browser_wait', bridgeTool: 'waitFor', label: 'Wait', title: 'Wait',
      description: 'Wait for a selector to appear, ms to pass, or the network to go quiet.',
      schema: { selector: z.string().optional(), ms: z.number().optional(), timeout: z.number().optional() },
      map: (a) => ({ networkIdle: !a.selector && !a.ms, ...a }),
      render: (r) => (r.waited ? `waited ${r.waited} ms` : r.selector ? `${r.selector} is there`
        : r.idle ? 'the network is quiet' : r.note || 'done'),
    },
    {
      name: 'browser_viewport', bridgeTool: 'setViewport', label: 'Viewport', title: 'Set viewport',
      description: 'Emulate a viewport size for responsive checks. Omit both to clear it.',
      schema: { width: z.number().optional(), height: z.number().optional() },
      route: (a) => (a.width && a.height ? 'setViewport' : 'clearViewport'),
      routes: ['setViewport', 'clearViewport'],
      render: (r) => (r.error ? `error: ${r.error}` : r.width ? `viewport ${r.width}x${r.height}` : 'viewport cleared'),
    },
    { name: 'browser_back', bridgeTool: 'back', label: 'Back', title: 'Back', description: 'Go back one history entry.', schema: {}, render: page },
    { name: 'browser_forward', bridgeTool: 'forward', label: 'Forward', title: 'Forward', description: 'Go forward one history entry.', schema: {}, render: page },
    { name: 'browser_reload', bridgeTool: 'reload', label: 'Reload', title: 'Reload', description: 'Reload the current page.', schema: {}, render: page },
    { name: 'browser_state', bridgeTool: 'state', label: 'Page state', title: 'Page state', description: 'Current url, title and loading state.', schema: {}, render: page },
    {
      name: 'browser_show', bridgeTool: 'preview', label: 'Show preview', title: 'Show the preview',
      description: 'Open or close the preview pane, for when the person should look.',
      schema: { open: z.boolean().optional() },
      render: (r) => `preview ${r.preview}`,
    },
    {
      name: 'browser_highlight', bridgeTool: 'highlight', label: 'Highlight', title: 'Highlight',
      description: 'Flash a box around an element for the person watching.',
      schema: { target: z.string() },
      render: (_r, a) => `highlighted ${a.target}`,
    },
    {
      name: 'browser_tabs', bridgeTool: 'tabs', label: 'Tabs', title: 'List tabs',
      description: 'This chat\'s tabs: id, url, title, which you drive and which the person sees.',
      schema: {},
      render: (r) => r.tabs.map((t) => [
        `${t.id}: ${t.url || 'about:blank'}${t.title ? ` "${t.title}"` : ''}`,
        t.driver === 'you' ? 'you drive it' : t.driver && `${t.driver} drives it`,
        t.onScreen && 'on screen',
      ].filter(Boolean).join(', ')).join('\n') || '(no tabs)',
    },
    {
      name: 'browser_tab_new', bridgeTool: 'tabNew', label: 'New tab', title: 'Open a new tab',
      description: 'Open a tab in this chat and drive it, loading url if given. Use one for anything unrelated to the open page.',
      schema: { url: z.string().optional() },
      render: tabLine,
    },
    {
      name: 'browser_tab_select', bridgeTool: 'tabSelect', label: 'Switch tab', title: 'Switch tabs',
      description: 'Drive another of this chat\'s tabs. Ids come from browser_tabs.',
      schema: { tab: z.string() },
      render: tabLine,
    },
    {
      name: 'browser_tab_close', bridgeTool: 'tabClose', label: 'Close tab', title: 'Close a tab',
      description: 'Close one of this chat\'s tabs, by default the one you drive. A tab another agent drives is refused.',
      schema: { tab: z.string().optional() },
      render: (r) => `closed ${r.closed}${r.current ? `, now driving ${r.current}` : ''}`,
    },
    {
      name: 'browser_batch', bridgeTool: 'batch', label: 'Browser steps', title: 'Browser steps',
      description: 'Run up to 15 browser steps in one call, in order. Each action is {tool, ...args}: a browser tool without browser_ (navigate, click, fill, press, wait, text, screenshot...) and its args. Stops at the first step that fails.',
      schema: { actions: z.array(z.object({ tool: z.string() }).passthrough()).max(BATCH_MAX) },
      format: 'batch',
    },
  ];
}

// A batch is one model call doing what took one call per step, so a check of a
// form (fill, click, wait, read) costs one round trip instead of five. Fifteen
// covers any such check; past that the agent should look at what it has.
const BATCH_MAX = 15;

const keyframeBlocks = (result, read) => (result.keyframes || []).map((file) => ({
  type: 'image', data: read(file).toString('base64'), mimeType: 'image/jpeg',
}));

/* The size of the picture the model is sent, which is not the file a person
   keeps. A model reads an image as roughly w*h/750 tokens and reads it again on
   every later turn, so a full-size pane cost three times what the same look
   costs through Claude's own browser. 800 wide keeps text legible; `high` is
   for when the detail matters, up to the 1568 px the model reads at most. A
   full page keeps its width and loses its bottom instead, since shrinking a
   tall page to fit makes all of it unreadable. Never scaled up. */
const SHOT_WIDTH = 800;
const SHOT_LONG = 1568;

function modelFit(width, height, { high = false, fullPage = false } = {}) {
  const across = high ? SHOT_LONG : SHOT_WIDTH;
  const scale = fullPage
    ? Math.min(1, across / width)
    : Math.min(1, across / width, SHOT_LONG / Math.max(width, height));
  const keep = Math.min(height, Math.floor(SHOT_LONG / scale));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(keep * scale)),
    cropHeight: keep,
    cropped: keep < height,
  };
}

// How a screenshot result announces itself: what was sent, and where the full
// file landed. index.js reads the path back to show the picture in the
// transcript without carrying its bytes over IPC, so the two have to agree.
// The older "WxH saved to path" form still matches, for transcripts made
// before the model copy existed.
const shotNote = (r) => {
  const m = r.model || r;
  const note = `${m.width}x${m.height} sent, ${r.width}x${r.height} saved to ${r.path}`;
  return m.cropped ? `${note}\nThe picture is the top of the page; the file has all of it.` : note;
};
const SHOT_NOTE = /(?:(\d+)x(\d+) sent, )?(\d+)x(\d+) saved to (.+)$/gm;

const shotImage = (r, read) => {
  const m = r.model || { path: r.path, mime: 'image/png' };
  return { type: 'image', data: read(m.path).toString('base64'), mimeType: m.mime };
};

function textOf(t, result, args) {
  if (t.render && result != null) {
    try { return t.render(result, args || {}); } catch { /* an unexpected shape reads as itself below */ }
  }
  if (typeof result === 'string') return result;
  return JSON.stringify(result) ?? 'undefined';
}

/* A page-changing action's report, as the pane made it (BrowserPane.caused),
   one line per row: errors before warnings, at most REPORT_ROWS of each kind,
   and a row that came before the action began marked as such. An empty
   report adds nothing. */
const REPORT_ROWS = 5;

function reportLine(r, since) {
  const what = r.kind === 'console' ? `console ${r.level}` : r.page ? 'page failed to load' : 'request failed';
  const when = r.t < since ? ' (after the previous step)' : '';
  const body = r.kind === 'console' ? `${clip(r.text, ROW_CHARS)}${where(r.source)}`
    : r.page ? r.status : `${r.status} ${r.method || ''} ${clip(r.text, ROW_CHARS)}`.replace(/\s+/g, ' ');
  return `${what}${when}: ${body}`;
}

function causedText(report, indent = '') {
  const rows = report?.rows || [];
  if (!rows.length) return '';
  const logged = rows.filter((r) => r.kind === 'console');
  const shown = [...logged.filter((r) => r.level === 'error'), ...logged.filter((r) => r.level !== 'error')].slice(0, REPORT_ROWS);
  const failed = rows.filter((r) => r.kind === 'request');
  const lines = [...shown, ...failed.slice(0, REPORT_ROWS)].map((r) => reportLine(r, report.since));
  if (logged.length > shown.length) lines.push(`${logged.length - shown.length} more console messages: browser_console {"full":true}`);
  if (failed.length > REPORT_ROWS) lines.push(`${failed.length - REPORT_ROWS} more failed requests: a network step`);
  return `\n${lines.map((l) => indent + l).join('\n')}`;
}

/**
 * What the model is handed for one call, the same over every transport.
 * `read` loads a file the result names; both callers pass fs.readFileSync.
 */
function toolContent(t, result, read, { args, caused } = {}) {
  if (t.format === 'image' && result?.path) {
    return { content: [{ type: 'text', text: shotNote(result) }, shotImage(result, read)] };
  }
  const stills = t.format === 'recording' && result?.keyframes ? keyframeBlocks(result, read) : [];
  return { content: [{ type: 'text', text: textOf(t, result, args) + causedText(caused) }, ...stills] };
}

/* The tools whose definitions ride along in every Claude request. The rest
   are deferred: the CLI lists their names, and calling one costs a ToolSearch
   round trip to load it first, while browser_batch runs any of them as a
   step without loading it. These are the most called in real transcripts
   (evaluate 1,197, navigate 711, screenshot 631, wait 291, console 133,
   tab_select 121, click 91, snapshot 57, text 15), plus the batch, and
   together cost no more than the ten that were here before it. The prose
   names a tool as browser_<name> only if it is here (browser-cost-check). */
const ALWAYS_LOADED = new Set(['browser_batch', 'browser_evaluate', 'browser_navigate', 'browser_screenshot', 'browser_wait',
  'browser_console', 'browser_tab_select', 'browser_click', 'browser_snapshot', 'browser_text']);

/* Appended to every request of a chat that has the pane, so it is kept as
   short as the facts allow. It asks for fewer calls, not more: steps go in a
   batch, and an action's own result already says what went wrong. A tool
   that is not always loaded is named as a batch step, bare. */
const INSTRUCTIONS = [
  'You are working next to a live preview browser, a real Chromium view the human can see.',
  'browser_navigate loads a URL (bare ports work: "3000" becomes http://localhost:3000).',
  'browser_snapshot returns [ref=eN] handles that browser_click and other steps take; refs reset on navigation.',
  'Check behaviour with browser_snapshot or browser_text; use browser_screenshot only for visual checks.',
  'Put steps you can plan ahead in one browser_batch call, not a call each; any browser tool is a step there, named bare: fill, type, press.',
  'The pane starts hidden and the page works while closed; a show step puts it in front of the human.',
  'Action results list console errors and failed requests seen by the time they return; later ones show in browser_console or a network step.',
  'A tabs step lists this chat\'s tabs: which you drive, which the human sees.',
  'The tab you start on may hold the person\'s own app, so use a tab_new step for anything unrelated, like docs.',
  'browser_tab_select changes which tab your tools act on. A subagent\'s first browser_navigate opens a tab of its own.',
].join(' ');

// Enough of zod's surface to build the table above without loading zod, which
// the policy code in main has no other use for.
const zStub = (() => {
  const any = { optional: () => any, max: () => any, passthrough: () => any };
  return { string: () => any, number: () => any, boolean: () => any, enum: () => any, array: () => any, object: () => any };
})();

const TABLE = browserTools(zStub);
const BY_NAME = new Map(TABLE.map((t) => [t.name, t]));

// The name a batch step goes by, which is the tool's own name without the
// prefix every one of them shares.
const shortName = (name) => name.replace(/^browser_/, '');

/* A batch runs other tools, never itself, and never a recording: one that
   starts inside a batch outlives it, and stopping one is its own decision. */
const NOT_IN_BATCH = new Set(['browser_batch', 'browser_record']);

/**
 * Checks a batch before any of it runs, so a typo in step six does not leave
 * five steps done and the agent unsure where it stands. `table` is built with
 * real zod where the caller has it, and then each step's args are checked
 * against its tool's own schema, the way a single call's are.
 * @returns {Array<{name: string, args: object, route: string, mapped: object}>}
 */
function planBatch(actions, { table = TABLE, z = null } = {}) {
  if (!Array.isArray(actions) || !actions.length) throw new Error('actions must be a list of at least one step');
  if (actions.length > BATCH_MAX) throw new Error(`a batch runs at most ${BATCH_MAX} steps; this one has ${actions.length}`);
  const tools = new Map(table.map((t) => [t.name, t]));
  return actions.map((action, i) => {
    const { tool, ...given } = action && typeof action === 'object' ? action : {};
    const t = tools.get(`browser_${shortName(String(tool ?? ''))}`);
    if (!t || NOT_IN_BATCH.has(t.name)) {
      const can = table.filter((x) => !NOT_IN_BATCH.has(x.name)).map((x) => shortName(x.name));
      throw new Error(`step ${i + 1}: ${JSON.stringify(tool ?? null)} is not a step a batch can run. Nothing ran. Steps: ${can.join(', ')}`);
    }
    let args = given;
    if (z) {
      const parsed = z.object(t.schema).safeParse(given);
      if (!parsed.success) {
        const why = parsed.error.issues.map((e) => `${e.path.join('.') || 'args'}: ${e.message}`).join('; ');
        throw new Error(`step ${i + 1} (${shortName(t.name)}): ${why}. Nothing ran.`);
      }
      args = parsed.data;
    }
    return { name: t.name, args, route: t.route ? t.route(args) : t.bridgeTool, mapped: t.map ? t.map(args) : args };
  });
}

/**
 * Runs planned steps in order through `run`, which is whatever a single call
 * of that step goes through on this transport: its permission check, its
 * lease, its actor. The first step that throws ends the batch; what ran
 * before it is kept. A refusal is told apart from a failure by its code.
 */
async function runBatch(steps, run) {
  const done = [];
  for (const [i, step] of steps.entries()) {
    try {
      done.push({ name: step.name, args: step.args, ...(await run(step, i)) });
    } catch (e) {
      done.push({ name: step.name, args: step.args, error: e?.message || String(e), refused: e?.code === 'PERMISSION_DENIED' });
      break;
    }
  }
  return { steps: done, total: steps.length };
}

/**
 * One result for the whole batch: a numbered line per step, a block under the
 * number for a step that returns a page of text, then the screenshots in
 * order. `out` is what runBatch returned, possibly after a trip over the bridge.
 */
function batchContent(out, read) {
  const lines = [];
  const images = [];
  for (const [i, s] of out.steps.entries()) {
    const t = BY_NAME.get(s.name);
    const n = `${i + 1}.`;
    if (s.error) {
      lines.push(`${n} ${shortName(s.name)} ${s.refused ? 'was refused' : 'failed'}: ${s.error}`);
      continue;
    }
    let text;
    if (t.format === 'image') {
      text = shotNote(s.result);
      images.push(shotImage(s.result, read));
    } else text = textOf(t, s.result, s.args);
    lines.push((text.includes('\n') ? `${n} ${shortName(s.name)}:\n${text}` : `${n} ${text}`) + causedText(s.caused, '   '));
  }
  const left = out.total - out.steps.length;
  if (left > 0) {
    const from = out.steps.length + 1;
    lines.push(`Stopped there. ${left === 1 ? `Step ${from} did` : `Steps ${from}-${out.total} did`} not run.`);
  }
  const failed = !!out.steps.at(-1)?.error;
  return { content: [{ type: 'text', text: lines.join('\n') }, ...images], ...(failed ? { isError: true } : {}) };
}

/** browser_* MCP name -> bare TOOLS key, for policy without loading zod. Derived from the table, so a tool added there is known here. */
const BRIDGE_TOOL = new Map(TABLE.map((t) => [t.name, t.bridgeTool]));

/** browser_* MCP name -> the name the transcript shows. */
const BROWSER_LABEL = new Map(TABLE.map((t) => [t.name, t.label]));

/** Bridge route -> browser_* MCP name. The bridge asks permission under the
    route it runs (browser_waitFor, browser_tabNew), not the tool's own name. */
const BROWSER_BY_ROUTE = new Map(TABLE.flatMap((t) => [t.bridgeTool, ...(t.routes || [])].map((r) => [r, t.name])));

/* What each agent calls these tools. Claude gets them from the in-process SDK
   server named `preview`, which it namespaces; codex and the ACP agents get
   them from the `conn` MCP server, which codex namespaces and the ACP agents
   list under their bare names. */
const TOOL_PREFIX = { claude: 'mcp__preview__', codex: 'mcp__conn__', cursor: '', grok: '', opencode: '', copilot: '' };

module.exports = {
  browserTools, keyframeBlocks, toolContent, modelFit, shotNote, SHOT_NOTE, cut,
  planBatch, runBatch, batchContent, BATCH_MAX,
  INSTRUCTIONS, ALWAYS_LOADED, BRIDGE_TOOL, BROWSER_LABEL, BROWSER_BY_ROUTE, TOOL_PREFIX,
};
