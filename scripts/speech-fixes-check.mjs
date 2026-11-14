/* Respelling dictated words under plain node. */
import assert from 'node:assert/strict';
import './renderer-esm.mjs';

const { fixWords, vocabulary } = await import('../src/renderer/ui/lib/speech-fixes.js');
const v = vocabulary(['simplify-it', 'review-it', 'trackmyshuttle', 'shop']);
const fix = (s) => fixWords(s, v);

assert.equal(fix('open the type script file'), 'open the TypeScript file');
assert.equal(fix('ask cloud code to check it'), 'ask Claude Code to check it');
assert.equal(fix('push it to get hub.'), 'push it to GitHub.');
assert.equal(fix('run the simplify it skill'), 'run the simplify-it skill');
assert.equal(fix('update the read me, then commit'), 'update the README, then commit');
assert.equal(fix('open local host 3000'), 'open localhost 3000');
assert.equal(fix('is node js installed?'), 'is Node.js installed?');
assert.equal(fix('the github repo'), 'the GitHub repo', 'casing a brand that has inner capitals');
assert.equal(fix('the track my shuttle app'), 'the trackmyshuttle app', 'a project name from the extras');
assert.equal(fix('I want to react to it quickly'), 'I want to react to it quickly', 'an everyday word stays as spoken');
assert.equal(fix('ui looks fine'), 'ui looks fine', 'short words are never matched');
assert.equal(fix('type. Script it'), 'type. Script it', 'a sentence break is not one word');
assert.equal(fix('go to the shop folder'), 'go to the shop folder', 'already right, untouched');
assert.equal(fix('  spaced   out  '), '  spaced   out  ', 'spacing survives');
assert.equal(fixWords('get hub', new Map()), 'GitHub', 'known mishearings work with no vocabulary');
assert.equal(fix(''), '');

console.log('speech-fixes-check ok');
