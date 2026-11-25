'use strict';
/* Pipelines: a saved list of steps, so a workflow you repeat (plan, build,
   review, fix) is one launch rather than four prompts typed by hand.

   Two halves, both pure. checkPipeline() turns what a YAML file said into a
   pipeline or a reason it is not one, and refuses the whole file rather than
   running half of it. The run functions move a run from stage to stage; the
   renderer does the talking to chats and asks these what happens next, so
   every rule about order, gates and failure lives here where a check under
   plain node can hold it. */

const MODES = ['plan', 'ask', 'auto', 'bypass'];
const PROVIDERS = ['claude', 'cursor', 'grok', 'opencode', 'codex', 'copilot'];
const STAGE_ID = /^[a-z][a-z0-9_-]{0,31}$/;
const TOKEN = /\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g;
const MAX_STAGES = 20;
const MAX_PROMPT = 20000;
const MAX_NAME = 80;
// What a stage's reply may grow a later prompt by. A reply longer than this is
// cut, with a note, so one long report cannot push a prompt past what the CLI
// will take.
const MAX_OUTPUT = 40000;

const str = (v) => typeof v === 'string';
const titleOf = (id) => id.replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase());

/**
 * A pipeline from what a file said, or why not.
 *
 * @param {unknown} raw What the YAML parsed to.
 * @returns {{ ok: true, pipeline: object } | { ok: false, error: string }}
 */
function checkPipeline(raw) {
  const fail = (error) => ({ ok: false, error });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('The file is not a pipeline: it needs a name and a list of stages.');
  if (!str(raw.name) || !raw.name.trim()) return fail('The pipeline needs a name.');
  if (raw.name.trim().length > MAX_NAME) return fail(`The name is longer than ${MAX_NAME} characters.`);
  if (raw.description !== undefined && !str(raw.description)) return fail('description has to be text.');
  if (raw.input !== undefined && (!str(raw.input) || !raw.input.trim())) return fail('input has to be the question asked at launch, as text.');
  if (raw.worktree !== undefined && typeof raw.worktree !== 'boolean') return fail('worktree has to be true or false.');
  if (!Array.isArray(raw.stages) || !raw.stages.length) return fail('The pipeline needs at least one stage.');
  if (raw.stages.length > MAX_STAGES) return fail(`A pipeline has at most ${MAX_STAGES} stages.`);

  const stages = [];
  const seen = new Map(); // id -> stage
  for (const [at, s] of raw.stages.entries()) {
    const where = `Stage ${at + 1}`;
    if (!s || typeof s !== 'object' || Array.isArray(s)) return fail(`${where} is not a stage.`);
    if (!str(s.id) || !STAGE_ID.test(s.id)) return fail(`${where} needs an id: lowercase letters, digits, - or _, starting with a letter.`);
    const name = `Stage "${s.id}"`;
    if (s.id === 'input') return fail(`${name}: "input" is taken by what you type at launch.`);
    if (seen.has(s.id)) return fail(`${name} appears twice.`);
    if (!str(s.prompt) || !s.prompt.trim()) return fail(`${name} needs a prompt.`);
    if (s.prompt.length > MAX_PROMPT) return fail(`${name}: the prompt is longer than ${MAX_PROMPT} characters.`);
    if (s.title !== undefined && (!str(s.title) || !s.title.trim())) return fail(`${name}: title has to be text.`);
    if (s.mode !== undefined && !MODES.includes(s.mode)) return fail(`${name}: mode is one of ${MODES.join(', ')}.`);
    if (s.provider !== undefined && !PROVIDERS.includes(s.provider)) return fail(`${name}: provider is one of ${PROVIDERS.join(', ')}.`);
    if (s.model !== undefined && (!str(s.model) || !s.model.trim())) return fail(`${name}: model has to be a model name.`);
    if (s.gate !== undefined && typeof s.gate !== 'boolean') return fail(`${name}: gate has to be true or false.`);

    let same = null;
    if (s.same !== undefined) {
      if (!str(s.same) || !seen.has(s.same)) return fail(`${name}: same has to name an earlier stage.`);
      same = s.same;
      const into = seen.get(same);
      // A chat runs on one CLI for life. A stage continuing it cannot be on another.
      if (s.provider && into.provider && s.provider !== into.provider) {
        return fail(`${name} continues "${same}", which runs on ${into.provider}, so it cannot run on ${s.provider}.`);
      }
    }

    for (const m of s.prompt.matchAll(TOKEN)) {
      const ref = m[1];
      if (ref === 'input') {
        if (raw.input === undefined) return fail(`${name} uses {{input}}, but the pipeline does not ask for one. Add an input question.`);
        continue;
      }
      if (!seen.has(ref)) return fail(`${name} uses {{${ref}}}, which is not an earlier stage.`);
    }

    const stage = {
      id: s.id,
      title: str(s.title) ? s.title.trim() : titleOf(s.id),
      prompt: s.prompt,
      ...(s.mode && { mode: s.mode }),
      ...(s.provider && { provider: s.provider }),
      ...(s.model && { model: s.model.trim() }),
      gate: s.gate === true,
      ...(same && { same }),
    };
    // A stage that continues another chat runs on that chat's CLI.
    if (same && !stage.provider && seen.get(same).provider) stage.provider = seen.get(same).provider;
    seen.set(s.id, stage);
    stages.push(stage);
  }

  return {
    ok: true,
    pipeline: {
      name: raw.name.trim(),
      ...(str(raw.description) && raw.description.trim() && { description: raw.description.trim() }),
      ...(str(raw.input) && { input: raw.input.trim() }),
      worktree: raw.worktree === true,
      stages,
    },
  };
}

const clip = (text) => (text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n\n[… cut: the rest of this reply is in its chat]` : text);

/**
 * A stage's prompt with {{input}} and {{<stage>}} filled in. checkPipeline has
 * already refused a name that is neither, so anything unknown here is left as
 * it was written.
 */
function render(prompt, values) {
  return String(prompt).replace(TOKEN, (whole, ref) => (Object.hasOwn(values, ref) ? clip(String(values[ref] ?? '')) : whole));
}

/* What a chat said at the end of its last turn: the main thread's replies
   after the newest message from the person, in order. Subagent text and tool
   output are not the reply. */
function finalReply(items) {
  const list = items || [];
  let from = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].kind === 'user') { from = i + 1; break; }
  }
  return list.slice(from)
    .filter((it) => it.kind === 'assistant' && !it.parent && str(it.text) && it.text.trim())
    .map((it) => it.text.trim())
    .join('\n\n');
}

// ------------------------------------------------------------------ runs

/* A run is plain data, written to disk after every step:
     { id, name, pipeline, input, base, project, status, at, startedAt, endedAt,
       stages: [{ id, title, status, chat, session, output, error, startedAt, endedAt }] }
   status is running, waiting (a gate), done, failed or stopped. A stage is
   pending, running, gated, done or failed. */

function newRun({ id, pipeline, input = '', base, project, now = Date.now() }) {
  return {
    id,
    name: pipeline.name,
    pipeline,
    input: String(input || ''),
    base,
    project: project || base,
    status: 'running',
    startedAt: now,
    at: now,
    endedAt: null,
    stages: pipeline.stages.map((s) => ({ id: s.id, title: s.title, status: 'pending', chat: null, session: null, output: null, error: null })),
  };
}

const values = (run) => Object.fromEntries([
  ['input', run.input],
  ...run.stages.filter((s) => s.output !== null).map((s) => [s.id, s.output]),
]);

const current = (run) => run.stages.findIndex((s) => s.status !== 'done');

/**
 * What the runner does next.
 *   { type: 'send', index, stage, prompt, chatOf, reuse }  start this stage.
 *     reuse is the stage's own chat when it has one already; otherwise chatOf
 *     names the stage whose chat it continues, or null for a new chat
 *   { type: 'wait' }   a turn is running or a gate is waiting on you
 *   { type: 'idle' }   the run is over
 */
function nextStep(run) {
  if (run.status !== 'running') return run.status === 'waiting' ? { type: 'wait' } : { type: 'idle' };
  const index = current(run);
  if (index < 0) return { type: 'idle' };
  const st = run.stages[index];
  if (st.status !== 'pending') return { type: 'wait' };
  const stage = run.pipeline.stages[index];
  // A stage sent again after a failure or a stop already has a chat. It goes
  // back there, so the work it did before is still in front of it.
  return { type: 'send', index, stage, prompt: render(stage.prompt, values(run)), chatOf: stage.same || null, reuse: st.chat || null };
}

const touch = (run, now, patch) => ({ ...run, at: now, ...patch });
const withStage = (run, index, patch) => run.stages.map((s, i) => (i === index ? { ...s, ...patch } : s));

function stageStarted(run, index, { chat, now = Date.now() }) {
  return touch(run, now, { stages: withStage(run, index, { status: 'running', chat, error: null, startedAt: now, endedAt: null }) });
}

// The chat's session id arrives a beat after its first message.
function stageSession(run, index, session) {
  if (!session || run.stages[index]?.session === session) return run;
  return { ...run, stages: withStage(run, index, { session }) };
}

/**
 * A stage's turn ended. A failed turn stops the run where it is; Retry sends
 * the stage again. A gate holds the run until approve(). The last stage done
 * is the run done.
 */
function stageEnded(run, index, { failed = false, error = null, output = '', now = Date.now() }) {
  const st = run.stages[index];
  if (!st || st.status !== 'running') return run;
  if (failed) {
    return touch(run, now, {
      status: 'failed',
      endedAt: now,
      stages: withStage(run, index, { status: 'failed', error: error || 'The turn ended with an error.', endedAt: now }),
    });
  }
  const gate = run.pipeline.stages[index].gate;
  const last = index === run.stages.length - 1;
  if (gate && !last) {
    return touch(run, now, { status: 'waiting', stages: withStage(run, index, { status: 'gated', output, endedAt: now }) });
  }
  const next = touch(run, now, { stages: withStage(run, index, { status: 'done', output, endedAt: now }) });
  return last ? { ...next, status: 'done', endedAt: now } : next;
}

/* Continue past a gate. `output` is the stage chat's latest reply, which is
   the plan as it stands after any back and forth you had with it. */
function approve(run, { output, now = Date.now() } = {}) {
  if (run.status !== 'waiting') return run;
  const index = run.stages.findIndex((s) => s.status === 'gated');
  if (index < 0) return run;
  const keep = output === undefined || output === null ? run.stages[index].output : output;
  return touch(run, now, { status: 'running', stages: withStage(run, index, { status: 'done', output: keep }) });
}

function stop(run, { now = Date.now() } = {}) {
  if (run.status === 'done' || run.status === 'stopped') return run;
  const index = current(run);
  const stages = index >= 0 && ['running', 'gated'].includes(run.stages[index].status)
    ? withStage(run, index, { status: 'pending', endedAt: now })
    : run.stages;
  return touch(run, now, { status: 'stopped', endedAt: now, stages });
}

/* Send the stage it stopped at again: a failed one, or one that was running
   when the run was stopped or the window closed. A stage with a chat already
   continues in that chat, so what it did is not lost. */
function retry(run, { now = Date.now() } = {}) {
  if (run.status !== 'failed' && run.status !== 'stopped') return run;
  const index = current(run);
  if (index < 0) return touch(run, now, { status: 'done', endedAt: now });
  return touch(run, now, { status: 'running', endedAt: null, stages: withStage(run, index, { status: 'pending', error: null }) });
}

/* A run read back from disk after the window that drove it went away. A stage
   mid-turn then is not running any more: its CLI went with the window. */
function revive(run, { now = Date.now() } = {}) {
  if (run.status !== 'running') return run;
  return stop(run, { now });
}

// The run's stage on screen, for its card: the one running, waiting or failed.
function focusStage(run) {
  const index = current(run);
  return index < 0 ? run.stages.length - 1 : index;
}

module.exports = {
  MODES,
  PROVIDERS,
  MAX_OUTPUT,
  checkPipeline,
  render,
  finalReply,
  newRun,
  nextStep,
  stageStarted,
  stageSession,
  stageEnded,
  approve,
  stop,
  retry,
  revive,
  focusStage,
};
