'use strict';
/* A cap that lands between the two halves of an emoji leaves half of it, a
   lone surrogate, which is not valid Unicode: JSON encoders replace or reject
   it and the model reads garbage at the end of its result. Every cap on what
   the browser tools hand the model is checked here with the emoji astride the
   cut, under plain node. */
const path = require('path');
const { browserTools, toolContent } = require(path.join(__dirname, '..', 'src/shared/browser-tools.js'));

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
};
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const tail = (s) => JSON.stringify(s.slice(-60));

const zStub = new Proxy({}, { get: () => () => new Proxy({}, { get: (_t, k, r) => (k === 'then' ? undefined : () => r) }) });
const tools = new Map(browserTools(zStub).map((t) => [t.name, t]));
const text = (name, result, args) => toolContent(tools.get(name), result, null, { args }).content[0].text;

const emojiAt = (n) => `${'a'.repeat(n - 1)}\u{1F600}b`;

const evaluated = text('browser_evaluate', emojiAt(10000), { code: 'x' });
check('evaluate-cap-keeps-the-emoji-whole', !LONE.test(evaluated), tail(evaluated));

const logged = text('browser_console', [{ level: 'error', message: emojiAt(300), source: 'app.js:1' }], {});
check('console-row-cap-keeps-the-emoji-whole', !LONE.test(logged), tail(logged));

const failed = text('browser_network', [{ kind: 'http', status: 500, method: 'GET', url: `http://x/${emojiAt(300 - 9)}` }], {});
check('request-row-cap-keeps-the-emoji-whole', !LONE.test(failed), tail(failed));

const filled = text('browser_fill', { ok: true, value: emojiAt(80) }, { target: '#q', value: emojiAt(80) });
check('quoted-value-cap-keeps-the-emoji-whole', !LONE.test(JSON.parse(`"${filled.replace(/^filled #q = "/, '').replace(/"$/, '')}"`)), tail(filled));

if (failures.length) {
  console.log(`\n${failures.length} FAIL(s): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\np3-surrogate-cut-repro: all passed');
