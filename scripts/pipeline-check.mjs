/* Pipelines in plain node: what a file may say, how prompts are filled in,
   and every move a run makes (stages in order, gates, failure, Stop, Retry,
   a window that went away), then the files main reads and writes. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-pipeline-check-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

const require = createRequire(import.meta.url);
const P = require('../src/shared/pipeline.js');
const files = require('../src/main/pipelines.js');
const yaml = require('js-yaml');

const ok = (raw) => {
  const r = P.checkPipeline(raw);
  assert.equal(r.ok, true, `expected a pipeline, got: ${r.error}`);
  return r.pipeline;
};
const refused = (raw, match) => {
  const r = P.checkPipeline(raw);
  assert.equal(r.ok, false, `expected a refusal for ${JSON.stringify(raw)}`);
  assert.match(r.error, match);
};
const stage = (id, extra) => ({ id, prompt: `do ${id}`, ...extra });

// ------------------------------------------------------------------ the file

{
  const p = ok({ name: ' Feature ', input: 'What?', stages: [stage('plan', { gate: true, mode: 'plan' }), stage('build', { prompt: 'Build {{ plan }} for {{input}}' })] });
  assert.equal(p.name, 'Feature', 'the name is trimmed');
  assert.equal(p.worktree, false, 'no worktree unless asked');
  assert.deepEqual(p.stages.map((s) => s.title), ['Plan', 'Build'], 'a stage with no title is named from its id');
  assert.equal(p.stages[0].gate, true, 'a gate is kept');
  assert.equal(p.stages[1].gate, false, 'no gate unless asked');
}
{
  const p = ok({ name: 'x', stages: [stage('build', { provider: 'codex' }), stage('fix', { same: 'build' })] });
  assert.equal(p.stages[1].provider, 'codex', 'a stage that continues a chat takes its CLI');
}
refused(null, /not a pipeline/);
refused([], /not a pipeline/);
refused({ stages: [stage('a')] }, /needs a name/);
refused({ name: 123, stages: [stage('a')] }, /name has to be text/);
refused({ name: 'x'.repeat(81), stages: [stage('a')] }, /longer than 80/);
refused({ name: 'x', stages: [] }, /at least one stage/);
refused({ name: 'x', stages: Array.from({ length: 21 }, (_, i) => stage(`s${i}`)) }, /at most 20/);
refused({ name: 'x', stages: [stage('Plan')] }, /needs an id/);
refused({ name: 'x', stages: [stage('input')] }, /"input" is taken/);
refused({ name: 'x', stages: [stage('a'), stage('a')] }, /appears twice/);
refused({ name: 'x', stages: [{ id: 'a' }] }, /needs a prompt/);
refused({ name: 'x', stages: [stage('a', { mode: 'yolo' })] }, /mode is one of plan, ask, auto, bypass/);
refused({ name: 'x', stages: [stage('a', { provider: 'gpt' })] }, /provider is one of/);
refused({ name: 'x', stages: [stage('a', { gate: 'yes' })] }, /gate has to be true or false/);
refused({ name: 'x', worktree: 'yes', stages: [stage('a')] }, /worktree has to be true or false/);
refused({ name: 'x', stages: [stage('a', { same: 'b' }), stage('b')] }, /same has to name an earlier stage/);
refused({ name: 'x', stages: [stage('a', { provider: 'claude' }), stage('b', { same: 'a', provider: 'codex' })] }, /cannot run on codex/);
refused({ name: 'x', stages: [stage('a', { prompt: 'Use {{input}}' })] }, /does not ask for one/);
refused({ name: 'x', stages: [stage('a', { prompt: 'Use {{b}}' }), stage('b')] }, /\{\{b\}\}, which is not an earlier stage/);
refused({ name: 'x', stages: [stage('a', { prompt: 'Use {{a}}' })] }, /\{\{a\}\}, which is not an earlier stage/);
refused({ name: 'x', stages: [stage('a', { prompt: 'x'.repeat(20001) })] }, /longer than 20000/);

assert.equal(P.render('A {{input}} B {{ plan }} C {{other}}', { input: 'in', plan: 'P' }), 'A in B P C {{other}}', 'known names are filled, others left');
assert.match(P.render('{{plan}}', { plan: 'x'.repeat(P.MAX_OUTPUT + 10) }), /\[… cut: the rest of this reply is in its chat\]$/, 'a huge reply is cut with a note');
assert.equal(P.render('{{input}}', { input: '$& $1 {{plan}}' }), '$& $1 {{plan}}', 'replacement text is taken literally');

assert.equal(P.finalReply([
  { kind: 'user', text: 'old' }, { kind: 'assistant', text: 'old reply' },
  { kind: 'user', text: 'go' }, { kind: 'assistant', text: 'One.' }, { kind: 'tool', name: 'Read' },
  { kind: 'assistant', text: 'sub', parent: 'toolu_1' }, { kind: 'assistant', text: ' Two. ' }, { kind: 'note', ended: true },
]), 'One.\n\nTwo.', 'the reply is the main thread after the last message, subagents left out');
assert.equal(P.finalReply([]), '', 'no items, no reply');

// ------------------------------------------------------------------ a run, start to finish

const pipeline = ok({
  name: 'Feature',
  input: 'What?',
  stages: [stage('plan', { gate: true }), stage('build', { prompt: 'Build: {{plan}}' }), stage('fix', { prompt: 'Fix {{build}}', same: 'build' })],
});
let run = P.newRun({ id: 'run-abc123', pipeline, input: 'coupons', base: '/w', now: 1 });
assert.equal(run.project, '/w', 'with no worktree the run works in the folder it was started from');
assert.deepEqual(run.stages.map((s) => s.status), ['pending', 'pending', 'pending']);

let step = P.nextStep(run);
assert.equal(step.type, 'send');
assert.equal(step.index, 0);
assert.equal(step.prompt, 'do plan', 'the first stage is sent as written');
assert.equal(step.chatOf, null, 'in a new chat');

run = P.stageStarted(run, 0, { chat: 'k1', now: 2 });
assert.equal(P.nextStep(run).type, 'wait', 'a running stage is waited on');
run = P.stageSession(run, 0, 'sess-1');
assert.equal(run.stages[0].session, 'sess-1');
assert.equal(P.stageEnded(run, 1, { output: 'x' }), run, 'a stage that is not running cannot end');

run = P.stageEnded(run, 0, { output: '1. do it', now: 3 });
assert.equal(run.status, 'waiting', 'a gate holds the run');
assert.equal(run.stages[0].status, 'gated');
assert.equal(P.nextStep(run).type, 'wait', 'a gate is waited on');
{
  const fresh = P.newRun({ id: 'run-zzz999', pipeline, base: '/w' });
  assert.equal(P.approve(fresh), fresh, 'Continue only moves a run that is waiting');
}

run = P.approve(run, { output: '1. do it\n2. and this', now: 4 });
assert.equal(run.status, 'running', 'Continue moves it on');
assert.equal(run.stages[0].status, 'done');
step = P.nextStep(run);
assert.equal(step.index, 1);
assert.equal(step.prompt, 'Build: 1. do it\n2. and this', 'the next prompt has the plan as it stood at Continue');

run = P.stageEnded(P.stageStarted(run, 1, { chat: 'k2' }), 1, { output: 'built' });
step = P.nextStep(run);
assert.equal(step.index, 2);
assert.equal(step.chatOf, 'build', 'a same: stage names the chat it continues');
assert.equal(step.prompt, 'Fix built');

run = P.stageEnded(P.stageStarted(run, 2, { chat: 'k2' }), 2, { output: 'fixed', now: 9 });
assert.equal(run.status, 'done', 'the last stage done is the run done');
assert.equal(run.endedAt, 9);
assert.equal(P.nextStep(run).type, 'idle', 'a finished run does nothing');
assert.equal(P.focusStage(run), 2, 'a finished run shows its last stage');

// A gate on the last stage would wait for nothing, so it does not.
{
  const p = ok({ name: 'x', stages: [stage('only', { gate: true })] });
  const r = P.stageEnded(P.stageStarted(P.newRun({ id: 'run-last01', pipeline: p, base: '/w' }), 0, { chat: 'k' }), 0, { output: 'y' });
  assert.equal(r.status, 'done', 'a gate on the last stage finishes the run');
}

// ------------------------------------------------------------------ failure, stop, retry, revive

{
  let r = P.stageStarted(P.newRun({ id: 'run-fail01', pipeline, input: 'x', base: '/w' }), 0, { chat: 'k1' });
  r = P.stageEnded(r, 0, { failed: true, error: 'rate limited' });
  assert.equal(r.status, 'failed', 'a failed turn fails the run');
  assert.equal(r.stages[0].error, 'rate limited');
  assert.equal(P.nextStep(r).type, 'idle', 'a failed run does nothing on its own');
  r = P.retry(r);
  assert.equal(r.status, 'running');
  const st = P.nextStep(r);
  assert.equal(st.index, 0, 'Retry sends the failed stage again');
  assert.equal(st.reuse, 'k1', 'in the chat it already had');
  assert.equal(r.stages[0].error, null, 'the old error goes');

  let s = P.stageStarted(P.newRun({ id: 'run-stop01', pipeline, input: 'x', base: '/w' }), 0, { chat: 'k1' });
  s = P.stop(s, { now: 5 });
  assert.equal(s.status, 'stopped');
  assert.equal(s.stages[0].status, 'pending', 'a stage stopped mid-turn goes back to pending');
  assert.equal(P.stop(s), s, 'stopping twice is the same');
  s = P.retry(s);
  assert.equal(P.nextStep(s).reuse, 'k1', 'Retry after Stop picks the stage up in its chat');

  let w = P.stageEnded(P.stageStarted(P.newRun({ id: 'run-gate01', pipeline, input: 'x', base: '/w' }), 0, { chat: 'k1' }), 0, { output: 'p' });
  w = P.stop(w);
  assert.equal(w.status, 'stopped');
  assert.equal(w.stages[0].status, 'gated', 'a stage stopped at its gate keeps its finished turn');
  const back = P.retry(w);
  assert.equal(back.status, 'waiting', 'Retry after a stop at a gate goes back to the gate');
  assert.equal(P.nextStep(back).type, 'wait', 'and does not ask the stage again');
  assert.equal(P.approve(back).stages[0].output, 'p', 'Continue from there hands on the reply it had');

  const gone = P.revive(P.stageStarted(P.newRun({ id: 'run-gone01', pipeline, input: 'x', base: '/w' }), 0, { chat: 'k1' }));
  assert.equal(gone.status, 'stopped', 'a run mid-stage when its window went away is stopped');
  const waiting = P.stageEnded(P.stageStarted(P.newRun({ id: 'run-wait01', pipeline, input: 'x', base: '/w' }), 0, { chat: 'k1' }), 0, { output: 'p' });
  assert.equal(P.revive(waiting), waiting, 'a run at a gate is still at its gate');
  assert.equal(P.retry(run), run, 'a finished run cannot be retried');
}

// ------------------------------------------------------------------ names of repeat runs

{
  const r1 = P.newRun({ id: 'run-name01', pipeline, base: '/w' });
  assert.equal(r1.label, 'Feature', 'the first run takes the pipeline\'s name');
  assert.equal(P.labelFor('Feature', [r1]), 'Feature #2', 'a second run is numbered');
  const r2 = { ...r1, label: 'Feature #2' };
  assert.equal(P.labelFor('Feature', [r1, r2]), 'Feature #3', 'one past the highest');
  assert.equal(P.labelFor('Feature', [r2]), 'Feature #3', 'even once the first is put away');
  assert.equal(P.labelFor('Other', [r1, r2]), 'Other', 'another pipeline counts on its own');
  assert.equal(P.labelFor('Feature', [{ name: 'Feature' }]), 'Feature #2', 'a run from before labels counts as the first');
}

// ------------------------------------------------------------------ what a run file has to be

{
  const good = P.stageStarted(P.newRun({ id: 'run-shape1', pipeline, input: 'x', base: '/w' }), 0, { chat: 'k1' });
  assert.equal(P.isRun(good), true, 'a run is a run');
  assert.equal(P.isRun(JSON.parse(JSON.stringify(good))), true, 'and still is after a trip through JSON');
  const bad = [
    null, 5, {},
    { ...good, stages: [null, 5] },
    { ...good, pipeline: {} },
    { ...good, at: undefined },
    { ...good, startedAt: 'yesterday' },
    { ...good, status: 'paused' },
    { ...good, name: { evil: true } },
    { ...good, stages: good.stages.slice(1) },
    { ...good, stages: good.stages.map((s, i) => (i ? s : { ...s, status: 'weird' })) },
    { ...good, stages: good.stages.map((s, i) => (i ? s : { ...s, id: 'other' })) },
    { ...good, stages: good.stages.map((s, i) => (i ? s : { ...s, output: 7 })) },
    { ...good, label: 42 },
  ];
  bad.forEach((b, i) => assert.equal(P.isRun(b), false, `malformed run ${i} is not a run`));
}

// ------------------------------------------------------------------ files on disk

{
  const project = path.join(home, 'shop');
  fs.mkdirSync(path.join(project, '.conn', 'pipelines'), { recursive: true });
  fs.writeFileSync(path.join(project, '.conn', 'pipelines', 'review.yml'), 'name: Review\nstages:\n  - id: look\n    prompt: Review it\n');
  fs.writeFileSync(path.join(project, '.conn', 'pipelines', 'broken.yaml'), 'name: [unclosed\n');
  fs.writeFileSync(path.join(project, '.conn', 'pipelines', 'bad.yml'), 'name: Bad\nstages:\n  - id: a\n    prompt: "{{nope}}"\n');
  fs.writeFileSync(path.join(project, '.conn', 'pipelines', 'notes.txt'), 'not yaml');
  fs.writeFileSync(path.join(project, '.conn', 'pipelines', 'huge.yml'), `name: x\n#${'x'.repeat(210_000)}\n`);
  const made = files.writeExample();
  assert.equal(made.file, path.join(home, '.conn', 'pipelines', 'feature.yml'), 'the example goes in ~/.conn/pipelines');
  fs.writeFileSync(made.file, `${fs.readFileSync(made.file, 'utf8')}\n# mine\n`);
  files.writeExample();
  assert.match(fs.readFileSync(made.file, 'utf8'), /# mine/, 'an example already there is left alone');

  const list = files.list(project);
  const byName = Object.fromEntries(list.map((p) => [p.name, p]));
  assert.deepEqual(list.map((p) => `${p.scope}:${p.name}`), ['project:bad', 'project:broken', 'project:huge', 'project:review', 'user:feature'], 'the project\'s first, then yours, YAML files only');
  assert.equal(byName.review.ok, true);
  assert.equal(byName.feature.ok, true, 'the example is a valid pipeline');
  assert.equal(byName.feature.pipeline.stages.length, 4);
  assert.match(byName.broken.error, /does not parse.*line/, 'a YAML error says where');
  assert.match(byName.bad.error, /\{\{nope\}\}/, 'a pipeline error says what');
  assert.match(byName.huge.error, /200 KB/, 'a huge file is refused');
  assert.deepEqual(files.list(null).map((p) => p.name), ['feature'], 'with no folder, only yours');

  // The example's own text survives a round trip through the checker, and so
  // does the one in the guide, so the docs cannot drift into a file that fails.
  assert.equal(P.checkPipeline(yaml.load(files.EXAMPLE)).ok, true, 'the example is valid');
  const guide = fs.readFileSync(new URL('../docs/guide.md', import.meta.url), 'utf8').match(/## Pipelines[\s\S]*?```yaml\n([\s\S]*?)```/);
  assert.ok(guide, 'the guide has a pipeline example');
  const fromGuide = P.checkPipeline(yaml.load(guide[1]));
  assert.equal(fromGuide.ok, true, `the guide's example is valid: ${fromGuide.error}`);
  assert.ok(!/#/.test(fromGuide.pipeline.stages.map((x) => x.prompt).join('')), 'no comment in the guide example ended up inside a prompt');
}

{
  const r = { ...P.newRun({ id: 'run-disk01', pipeline, input: 'x', base: '/w' }) };
  assert.deepEqual(files.saveRun(r), { ok: true });
  assert.deepEqual(files.listRuns().map((x) => x.id), ['run-disk01'], 'a saved run is listed');
  assert.equal(files.listRuns()[0].owner, process.pid, 'and marked as this window\'s');
  assert.equal(files.saveRun({ id: '../evil', stages: [] }).error, 'not a run', 'an id that is not a file name is refused');
  assert.equal(files.saveRun({ ...r, id: 'run-other1' }, { pid: process.ppid }).ok, true);
  assert.deepEqual(files.listRuns().map((x) => x.id), ['run-disk01'], 'a run another live window drives is not this window\'s');
  assert.equal(files.saveRun({ ...r, id: 'run-other1' }).error, 'another window is running that pipeline', 'and this window cannot write over it');
  assert.equal(files.removeRun('run-other1').error, 'another window is running that pipeline', 'or delete it');
  fs.writeFileSync(path.join(files.runsDir(), 'run-dead01.json'), JSON.stringify({ ...r, id: 'run-dead01', owner: 999999999 }));
  assert.ok(files.listRuns().some((x) => x.id === 'run-dead01'), 'a run whose window has gone is this window\'s to pick up');
  fs.writeFileSync(path.join(files.runsDir(), 'junk.json'), '{');
  fs.writeFileSync(path.join(files.runsDir(), 'run-garbage2.json'), JSON.stringify({ id: 'run-garbage2', stages: [null, 5], pipeline: {}, status: 'running' }));
  fs.writeFileSync(path.join(files.runsDir(), 'run-notime1.json'), JSON.stringify({ ...r, id: 'run-notime1', at: undefined, startedAt: undefined }));
  assert.equal(files.listRuns().length, 2, 'a file that is not a run, or a run cut short, is skipped and the rest are kept');
  assert.deepEqual(files.removeRun('run-disk01'), { ok: true });
  assert.ok(!files.listRuns().some((x) => x.id === 'run-disk01'), 'a removed run is gone');
  for (let i = 0; i < 55; i++) files.saveRun({ ...r, id: `run-many${String(i).padStart(2, '0')}` });
  assert.ok(fs.readdirSync(files.runsDir()).filter((n) => n.endsWith('.json')).length <= 50, 'at most 50 runs are kept');
}

fs.rmSync(home, { recursive: true, force: true });
console.log('pipeline-check: all passed');
