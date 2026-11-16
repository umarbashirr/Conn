'use strict';
/* browser_console cuts each message at 300 characters, which keeps a noisy
   page cheap to read, but a stack trace or a long error then had no way to
   be read whole. With full it comes back exactly as logged; without it the
   rows stay short. An action's report keeps the short rows, and its line for
   messages it left out says how to read them whole. Plain node. */
const path = require('path');
const { z } = require('zod');
const { browserTools, toolContent } = require(path.join(__dirname, '..', 'src/shared/browser-tools.js'));

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
};

const tools = new Map(browserTools(z).map((t) => [t.name, t]));
const consoleTool = tools.get('browser_console');
const long = `TypeError: boom\n${Array.from({ length: 30 }, (_, i) => `    at frame${i} (http://localhost:3000/assets/app-${i}.js:${i}:1)`).join('\n')}`;
const rows = [{ level: 'error', message: long, source: 'http://localhost:3000/app.js:9' }];
const text = (t, result, args, extra) => toolContent(t, result, null, { args, ...extra }).content[0].text;

const short = text(consoleTool, rows, {});
check('rows-are-short-by-default', short.length < 340 && short.includes('…'), `${short.length} chars`);
const parsed = z.object(consoleTool.schema).safeParse({ full: true });
check('console-takes-full', parsed.success && parsed.data.full === true, JSON.stringify(parsed.error?.issues));
const whole = text(consoleTool, rows, { full: true });
check('full-returns-the-message-as-logged', whole.includes(long), `${whole.length} chars`);

const caused = {
  since: 0,
  rows: Array.from({ length: 7 }, (_, i) => ({ kind: 'console', level: 'error', text: `${i} ${long}`, source: 'app.js:9', t: 1 })),
};
const report = text(tools.get('browser_click'), { clicked: '#go' }, { target: '#go' }, { caused });
check('report-rows-stay-short', report.split('\n').every((l) => l.length < 340), report.split('\n').map((l) => l.length).join(','));
check('report-overflow-says-how-to-read-them-whole', /2 more console messages: browser_console .*full/.test(report), report.split('\n').at(-1));

if (failures.length) {
  console.log(`\n${failures.length} FAIL(s): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\np3-console-full-repro: all passed');
