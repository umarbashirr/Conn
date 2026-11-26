'use strict';
/* Stored transcripts back into the items a chat is drawn from.

   Shared by the window, which draws them, and by main, which answers
   conn_thread_read from them, so an item has the same id wherever it is read.
   That id names where its message sits in its session's transcript: `h12` for
   message 12, `h12.1` for its second block, a call by the id its CLI gave it,
   and in a chat that changed agent, `s2:h12` for message 12 of the third
   session it ran on, counted in the order the chat first used them. Reading a
   transcript again, after a reload, a reopen or a restart, gives the same ids,
   because a transcript only ever grows at its end. */
const { classify } = require('./turn-error');
const { planOf, withPlan } = require('./plan');
const { isInternalAnswerArtifact } = require('./assistant-output');
const { unwrapHandoff, itemsFromEntries } = require('./handoff');
const { stitch } = require('./chat-segments');

const strip = (t) => t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();

// A stored prompt that carried a handoff is drawn as the handoff row and then
// what was typed, never as the history that went with it. A fork's transcript
// has nothing before that prompt, so what it carried is drawn back above the
// row: that is what the fork was given.
function userRows(id, said, extra) {
  const u = unwrapHandoff(said);
  if (!u.handoff) return [{ id, kind: 'user', text: said, ...extra }];
  const { from, to, model, carried, total, scope, fork } = u;
  return [
    ...(fork ? itemsFromEntries(u.entries(), `${id}:c:`) : []),
    { id: `${id}:handoff`, kind: 'handoff', from, to, model, carried, total, scope, ...(fork && { fork }) },
    { id, kind: 'user', text: u.text.trim(), handoff: true, ...extra },
  ];
}


// Stored messages back into items. Used for a whole chat and again for one
// subagent's transcript, where `parent` is the Agent row they belong under.
// A row's id names the stored message it came from, counted from the start of
// the transcript (`first` is where these messages start), so a message read
// again in a wider window is the same row and keeps its place under the reader.
function replay(messages, parent, first = 0) {
  let out = [];
  const own = parent ? `${parent}:` : 'h';
  for (const [i, m] of messages.entries()) {
    const id = `${own}${first + i}`;
    const content = m.message?.content;
    const base = parent ? { parent } : {};
    const forkAt = m.uuid ? { forkAt: m.uuid } : {};
    if (typeof content === 'string') {
      if (m.type === 'user' && !parent) out.push(...userRows(id, strip(content), { ...forkAt, ...base }));
      continue;
    }
    if (!Array.isArray(content)) continue;

    if (m.type === 'assistant') {
      if (m.error && !parent) {
        const turnError = classify.claude({ error: m.error, text: content.map((b) => b.text || '').join('\n') });
        out.push({ id, kind: 'note', ended: true, error: true, text: turnError.message, turnError });
        continue;
      }
      for (const [k, b] of content.entries()) {
        const plan = b.type === 'tool_use' && b.name === 'TodoWrite' ? planOf(b.input) : null;
        if (plan) out = withPlan(out, { parent, ...plan });
        else if (b.type === 'tool_use') out.push({ id: b.id, kind: 'tool', name: b.name, input: b.input, state: 'output-available', ...base });
        else if (b.type === 'text' && b.text?.trim() && !isInternalAnswerArtifact(b.text)) {
          out.push({ id: `${id}.${k}`, kind: 'assistant', text: b.text, ...base });
        }
        else if (b.type === 'thinking' && b.thinking?.trim()) out.push({ id: `${id}.${k}`, kind: 'reasoning', text: b.thinking, ...base });
      }
      continue;
    }
    const said = strip(content.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n'));
    // A subagent's first user message is the prompt it was handed, which its
    // row already shows. Its later ones are tool results.
    if (said && !parent) out.push(...userRows(id, said, { ...forkAt, ...base }));
    for (const b of content) {
      if (b.type !== 'tool_result') continue;
      const i = out.findIndex((n) => n.id === b.tool_use_id);
      if (i < 0) continue;
      out[i] = {
        ...out[i],
        state: b.is_error ? 'output-error' : 'output-available',
        output: b.content,
        // What the Agent call recorded about itself: counts, timing, and the
        // report, all straight from the stored result.
        ...(m.agent ? {
          kind: 'agent',
          agentId: m.agent.id,
          agentType: m.agent.type,
          status: m.agent.status === 'completed' ? 'done' : m.agent.status,
          tools: m.agent.tools,
          ms: m.agent.ms,
          tokens: m.agent.tokens,
          stats: m.agent.stats,
        } : {}),
      };
    }
  }
  return out;
}

// A stored chat's window back into items. The agents it ran are named in their
// own meta files, which is how a replayed row knows its type and where to find
// its transcript. Their rows draw folded and read nothing until opened.
function replayStored(t, first) {
  const byToolUse = new Map((t.subagents || []).map((a) => [a.toolUseId, a]));
  return replay(t.messages, null, first).map((it) => {
    const meta = byToolUse.get(it.id);
    return meta ? {
      ...it,
      kind: 'agent',
      agentId: meta.id,
      agentType: meta.type,
      description: meta.description || it.input?.description || '',
      depth: meta.depth,
      status: 'done',
      loaded: false,
    } : it;
  });
}


/* Every session a chat ran on, read whole and put back in order. `read(session,
   provider)` answers one session's stored transcript. The chat's first session
   has to be readable; a later one that is not leaves its stretch out rather
   than the whole chat. Returns the items, each segment with where it starts,
   and what was read, by session. */
async function readThread(segs, read) {
  const ids = [...new Set(segs.map((x) => x.session))];
  const reads = await Promise.all(ids.map(async (session, n) => {
    const provider = segs.find((x) => x.session === session).provider;
    const t = await Promise.resolve()
      .then(() => read(session, provider))
      .catch((e) => { if (n) return { messages: [], total: 0 }; throw e; });
    const tag = (id) => (n && id ? `s${n}:${id}` : id);
    const first = Math.max(0, (t.total ?? t.messages.length) - t.messages.length);
    const items = replayStored(t, first).map((it) => ({
      ...it,
      id: tag(it.id),
      ...(it.parent && { parent: tag(it.parent) }),
      ...(it.kind === 'agent' && { session }),
    }));
    return [session, { t, items }];
  }));
  const bySession = Object.fromEntries(reads);
  if (segs.length < 2) return { items: reads[0][1].items, segments: [{ ...segs[0], from: 0 }], reads: bySession };
  const stitched = stitch(segs, Object.fromEntries(reads.map(([id, r]) => [id, r.items])));
  return { items: stitched.items, segments: stitched.segments, reads: bySession };
}

module.exports = { strip, userRows, replay, replayStored, readThread };
