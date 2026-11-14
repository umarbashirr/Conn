/* The follow-up chips under plain node: what a finished turn offers next. */
import assert from 'node:assert/strict';
import './renderer-esm.mjs';

const { nextSteps } = await import('../src/renderer/ui/lib/next-steps.js');
const texts = (items, opts) => nextSteps(items, opts).map((s) => s.text);
const user = (text = 'do it') => ({ id: `u${Math.random()}`, kind: 'user', text });
const say = (text) => ({ id: `a${Math.random()}`, kind: 'assistant', text });
const tool = (name, input = {}, extra = {}) => ({ id: `t${Math.random()}`, kind: 'tool', name, input, state: 'output-available', ...extra });

assert.deepEqual(nextSteps([]), [], 'an empty chat offers nothing here');
assert.deepEqual(texts([user(), say('Hello there.')]), [], 'a plain answer offers nothing');

const edited = texts([user(), tool('Edit', { file_path: 'a.js' }), say('Done.')]);
assert.deepEqual(edited, ['Review the changes for bugs', 'Run the tests and fix what fails', 'Commit these changes'], 'edits offer review, tests, commit');

const tested = texts([user(), tool('Edit'), tool('Bash', { command: 'npm test' }), say('Done.')]);
assert.ok(!tested.includes('Run the tests and fix what fails'), 'tests that already ran are not offered again');

const failed = texts([user(), tool('Bash', { command: 'make' }, { state: 'output-error' }), say('It failed.')]);
assert.equal(failed[0], 'Fix the failing command', 'a failed command comes first');

assert.equal(texts([user(), { id: 'n', kind: 'note', error: true, text: 'x' }])[0], 'Try that again', 'a turn error offers a retry');

const menu = texts([user(), say('Two ways:\n\nWhich do you prefer?\n1. **Keep it** — simple\n2. **Drop it** — cleaner')]);
assert.deepEqual(menu.slice(0, 2), ['Go with option 1: Keep it', 'Go with option 2: Drop it'], 'a closing menu becomes one chip per option');

const walkthrough = texts([user(), say('Steps:\n1. Install\n2. Run\n\nThat is all.')]);
assert.ok(!walkthrough.some((t) => t.startsWith('Go with')), 'a numbered list without a question is not a menu');

assert.deepEqual(texts([user(), say('Fixed the bug. Want me to commit this?')]), ['Yes, go ahead'], 'a yes or no question offers yes');

const plan = nextSteps([user(), say('Here is the plan:\n1. Add the route\n2. Wire the form')], { mode: 'plan' });
assert.deepEqual(plan[0], { text: 'Implement this plan', mode: 'auto' }, 'a plan in Plan mode offers to switch and build it');
assert.deepEqual(texts([user(), say('The router lives in src/app.js.')], { mode: 'plan' }), [], 'a plain answer in Plan mode is not a plan');

const url = texts([user(), tool('Bash', { command: 'npm run dev' }, { output: 'Local: http://localhost:5173/' }), say('Server is up.')]);
assert.ok(url.includes('Open http://localhost:5173/ in the preview and check it works'), 'a dev server URL offers the preview');

const old = texts([user(), tool('Edit'), say('Done.'), user('thanks'), say('You are welcome.')]);
assert.deepEqual(old, [], 'only the last turn counts');

const many = nextSteps([user(), tool('Bash', {}, { state: 'output-error' }), tool('Edit'), say('Which?\n1. A\n2. B\n3. C')]);
assert.ok(many.length <= 3, 'never more than three');

assert.ok(!texts([user(), tool('Edit', {}, { state: 'output-error' }), say('Could not.')]).includes('Commit these changes'), 'a failed edit offers no commit');

console.log('next-steps-check ok');
