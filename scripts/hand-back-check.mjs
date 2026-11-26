/* When the chat offers to hand the browser back: only when the last turn
   was stopped by the note main sends while you hold the page. The note is
   matched by its opening sentence, so it is checked against main's own text
   here: rewording one without the other would quietly hide the offer. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import './renderer-esm.mjs';

const { stoppedForYou, TAKEN_NOTE } = await import('../src/renderer/ui/lib/control.js');

const lease = fs.readFileSync(new URL('../src/main/pane-lease.js', import.meta.url), 'utf8');
assert.ok(lease.includes(`'${TAKEN_NOTE} `), 'main still opens its refusal with the sentence the chat looks for');

const refused = (output) => ({ kind: 'tool', name: 'mcp__preview__browser_click', output });
assert.equal(stoppedForYou([{ kind: 'user' }, refused(`Error: ${TAKEN_NOTE} Do not use the browser`), { kind: 'assistant', text: 'waiting' }]), true, 'a refused call in the last turn');
assert.equal(stoppedForYou([{ kind: 'user' }, refused([{ type: 'text', text: `${TAKEN_NOTE} Stop here.` }])]), true, 'in a result made of blocks too');
assert.equal(stoppedForYou([refused(TAKEN_NOTE), { kind: 'user' }, { kind: 'assistant', text: 'ok' }]), false, 'a new message is a new turn');
assert.equal(stoppedForYou([{ kind: 'user' }, refused('clicked')]), false, 'a call that went through');
assert.equal(stoppedForYou([]), false, 'nothing');
console.log('hand-back-check: all passed');
