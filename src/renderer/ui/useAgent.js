import { chatTitle, TITLE_MAX, RENAME_MAX } from '../../shared/chat-title';
import { classify } from '../../shared/turn-error';
import { newCanvasId } from '../../shared/canvas';
import { followsWindowProvider, shownModel } from '../../shared/run-choice';
import { isInternalAnswerArtifact } from '../../shared/assistant-output.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { chatActivity } from '@/lib/activity';
import { moveDraft, ownedStorageKey } from '@/lib/drafts';
import { planOf, withPlan } from '@/lib/plan';
import { settle } from '@/lib/reasoning';
import { rewindow, storedOf, storedWindow, widerLimit } from '@/lib/stored';
import { bucketOf } from '@/lib/tools';
import { account, blankUsage, byModel, storedContext, totals, withStop } from '@/lib/usage';
import { hasUndecidedPerm } from './shell/chat-attention.js';
import { toast } from './shell/toast';
import { buildHandoff, labelOf, windowFor, wrapMessage } from '../../shared/handoff';
import { readThread, replay, replayStored } from '../../shared/replay';
import { cutFor, headOf, persistable, providerAt, switchChat, withSession } from '../../shared/chat-segments';
import { createSerial, modelEntry } from '../../shared/model-pick';
import { deleteNote } from '../../shared/delete-note';

const conn = () => window.conn;

const LONG_TURN_MS = 5000;
// Enough messages to read any one transcript whole.
const WHOLE = 1000000;

// A model as the picker names it, for the handoff row.
const modelName = (models, value, provider) => (modelEntry(models, value, provider)?.displayName || value)
  .replace(/\s*\((recommended|default|1M context)\)\s*$/i, '');

const uid = (p) => `${p}${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
// An agent or background shell that has not reported back.
const isRunning = (it) => (it.kind === 'agent' || it.taskId) && it.status === 'running';
// What keeps going once the turn that started it has ended.
const outlivesTurn = (it) => isRunning(it) && it.background;

const openChat = (chat) => window.connChat?.open({ key: chat.key, id: chat.session, project: chat.project, title: chat.title });

const toastEnd = (chat, failed) => toast(`${chat.title} ${failed ? 'ended with an error' : 'is done'}`, null, [{
  label: 'Open',
  primary: true,
  run: () => openChat(chat),
}], { duration: 10000 });

const OPEN_CALL = new Set(['input-streaming', 'input-available']);

function outlivingIds(items) {
  const out = new Set();
  for (const it of items) if (outlivesTurn(it) || out.has(it.parent)) out.add(it.id);
  return out;
}

// A blocking agent ends with the turn that was waiting on it, as `agentEnd`.
function endTurn(items, agentEnd) {
  const outlives = outlivingIds(items);
  const now = Date.now();
  return items.map((it) => {
    if (outlives.has(it.id)) return it;
    if (it.kind === 'agent' && it.status === 'running') return { ...it, status: agentEnd, waiting: false };
    if (it.kind === 'tool' && OPEN_CALL.has(it.state)) return { ...it, state: 'output-error', output: 'interrupted' };
    return settle(it, now);
  });
}

// A stopped turn's transcript. Its open permission cards are a deny and the
// agents that were waiting on them are not waiting any more.
function interrupted(items) {
  const waitingIds = new Set(
    items
      .filter((it) => it.kind === 'perm' && !it.decided && it.agent?.toolUseId)
      .map((it) => it.agent.toolUseId),
  );
  return [...endTurn(items, 'stopped').map((it) => {
    if (it.kind === 'perm' && !it.decided) return { ...it, decided: 'deny' };
    if (waitingIds.has(it.id)) return { ...it, waiting: false };
    return it;
  }), { id: uid('i'), kind: 'note', text: 'interrupted' }];
}

const editedAfter = (items, at) =>
  items.slice(at + 1).some((it) => it.kind === 'agent' || (it.kind === 'tool' && bucketOf(it) === 'edit'));

// The chat as it stood before item `id`, for a fork cut there. A kept Agent row
// keeps the rows under it, even ones written after the cut. The fork renamed
// every message, so each kept one takes its new id from `uuids`.
function before(items, id, uuids) {
  const cut = items.findIndex((it) => it.id === id);
  if (cut < 0) return items;
  const kept = new Set();
  return items.filter((it, i) => {
    if (i >= cut && !kept.has(it.parent)) return false;
    kept.add(it.id);
    return true;
  }).map((it) => (it.forkAt ? { ...it, forkAt: uuids[it.forkAt] } : it));
}

// The segments with the newest one's start counted off the chat's items.
const recut = (c) => c.segments.map((x, i) => (i === c.segments.length - 1 ? { ...x, cut: cutFor(c.items, c.segments) } : x));

// The chat with a wider stretch of its stored transcript read in. Rows read in
// ahead push every later one along, so a switch made since opening, which
// counts where it starts from the front, moves with them.
function widened(c, fresh, span, session) {
  if (!c.stored) return c;
  const more = fresh.length - c.stored.count;
  return {
    ...c,
    items: rewindow(c.items, c.stored.count, fresh),
    stored: storedOf(session, span, fresh.length),
    segments: (c.segments || []).map((x, i) => (i ? { ...x, from: x.from + more } : x)),
    handoff: c.handoff?.since ? { ...c.handoff, since: c.handoff.since + more } : c.handoff,
  };
}

// The handoff a chat's next message carries, sized against the model it is
// going to. A fork names the segments of the chat it was copied from, so the
// items it carries still say which agent did them.
function handoffFor(chat, text, images = []) {
  const h = chat.handoff;
  const by = h.segments || chat.segments;
  // The row's own name for the model goes in the header, so the row reads the
  // same after a reopen as it does now.
  const row = chat.items.find((it) => it.id === h.marker);
  return buildHandoff({
    items: chat.items,
    since: h.since,
    from: h.from,
    to: chat.provider,
    model: row?.model || chat.usage?.model || undefined,
    fork: !!row?.fork,
    providerAt: by?.length ? (i) => providerAt(by, i) : undefined,
    window: windowFor(chat.usage?.model),
    used: h.used || 0,
    message: text,
    images: images.length,
  });
}

// One conversation. `key` is ours and outlives the session under it: a chat
// parked while idle keeps its transcript here and is resumed on the next
// message, so switching chats never interrupts one that is working.
// Items stay one flat list even though subagents nest. An item spawned inside
// an agent carries that agent's Agent-call id as `parent`, and the tree is put
// back together at render time. Patching a tool result by id then works the
// same whoever ran it.
const blankChat = (project = null, provider = 'claude', mode = 'ask') => ({
  key: uid('c'),
  // The Canvas board this chat draws on, for life. It is minted here because
  // the first $canvas brief has to name the folder before any session exists;
  // main writes it down against the session id once there is one, and the rail
  // hands it back when the chat is reopened.
  canvas: newCanvasId(),
  // Which CLI this chat runs on now. A thread belongs to the binary that made
  // it, so changing CLI starts or resumes another session under the same chat
  // and the turns it missed go across as a handoff. See changeModel.
  provider,
  // The folder this chat runs in. A chat keeps it for life: you can open a
  // second project, read it, come back, and this one is still working where it
  // started. Null only until the window has told us which folders are open.
  project,
  session: null,
  // One per stretch on one CLI, once the chat has changed CLI. Empty for a
  // chat that never has. See shared/chat-segments.
  segments: [],
  // The handoff the next message carries, from a switch or a fork.
  handoff: null,
  title: 'New chat',
  items: [],
  // A chat opened off disk with more stored than was replayed: where on disk
  // its first items came from. See lib/stored.
  stored: null,
  busy: false,
  endedUnseen: false,
  // A turn that ended away from the screen, as 'done' or 'error'. Its toast
  // waits until no background work it started is still running.
  toastDue: null,
  // When the turn on this chat started, so the header can count it. Per chat,
  // because the fleet runs several at once and switching chats mid-turn must
  // not hand the other one's clock to this one.
  startedAt: 0,
  queued: [],
  mode,
  effort: '',
  // task id -> Agent tool_use id. The live-task feed talks in task ids and
  // everything else talks in tool_use ids.
  tasks: {},
  // What this chat has spent, kept per chat because the fleet runs several at
  // once and one shared counter would blend them.
  usage: blankUsage(),
});

// Everything the panel shows is derived from the SDK message stream. This hook
// turns that stream into a flat list of items per chat, and hands back the
// actions the composer needs for whichever chat is on screen.
export function useAgent() {
  // Which folder a chat started now would belong to. Read through a ref because
  // the IPC listeners are registered once and would otherwise close over the
  // project that was focused on the first render.
  const focusedProject = useRef(null);
  // The mode a new chat starts on: the one chosen in Settings, not whatever the
  // last chat was switched to. Read up front so the composer shows it before a
  // session has started and said which mode it is in.
  const startMode = useRef(conn().settings.snapshot()?.agent?.mode || 'ask');
  useEffect(() => conn().settings.onChanged((next) => {
    if (next?.agent?.mode) startMode.current = next.agent.mode;
  }), []);
  // The folder main runs chats with no project in. It is never one of the open
  // projects, so it has to be named to survive the sweep below.
  const chatsDir = useRef(null);
  useEffect(() => {
    const apply = (info) => {
      const dir = info?.focused || info?.dir || null;
      focusedProject.current = dir;
      chatsDir.current = info?.chats || null;
      // The window opens with a chat in it before it knows which folders it
      // has, so that first chat is rooted by the first answer and not by
      // whichever folder happens to be focused when it is finally used.
      if (dir) setChats((all) => (all.some((c) => !c.project)
        ? all.map((c) => (c.project ? c : { ...c, project: dir }))
        : all));

      // A folder that has been closed takes its chats with it. Main has already
      // stopped their sessions; what is left is the copies here, and a chat
      // pointing at a folder the window no longer holds has nowhere to send.
      const dirs = new Set((info?.projects || []).map((p) => p.dir));
      if (dirs.size) dropChatsOutside(dirs.add(info.chats), dir);
    };
    conn().project.info().then(apply).catch(() => {});
    return conn().project.onChanged(apply);
  }, []);

  // Declared before the effect above runs, and reading its state through the
  // refs, so it does not have to be a dependency of anything.
  const dropChatsOutside = (dirs, fallback) => {
    const all = chatsRef.current;
    const keep = all.filter((c) => !c.project || dirs.has(c.project));
    if (keep.length === all.length) return;

    const gone = new Set(all.filter((c) => !keep.includes(c)).map((c) => c.key));
    for (const [k, st] of streams.current) {
      if (!gone.has(k.split('\0')[0])) continue;
      if (st.raf) cancelAnimationFrame(st.raf);
      streams.current.delete(k);
    }

    const next = keep.length ? keep : [blankChat(fallback, undefined, startMode.current)];
    chatsRef.current = next;
    setChats(next);
    if (!next.some((c) => c.key === activeRef.current)) {
      activeRef.current = next[0].key;
      setActiveKey(next[0].key);
    }
  };

  const first = useRef(null);
  if (!first.current) first.current = blankChat(null, undefined, startMode.current);
  const [chats, setChats] = useState(() => [first.current]);
  const [activeKey, setActiveKey] = useState(first.current.key);
  const [models, setModels] = useState([]);
  const [model, setModel] = useState('');
  const [driver, setDriver] = useState(null);
  // The Settings re-check button's spinner. The result itself arrives on
  // 'agent:driver' like every other refresh; this only tracks the round trip.
  const [checking, setChecking] = useState(false);
  // Which CLI the panel is driving. Kept beside the model list because the two
  // move together: switching provider replaces the list under the picker.
  const [provider, setProvider] = useState('claude');
  // Both CLIs and whether each is installed, so the picker can draw a locked
  // row for one that is missing instead of leaving it off the list.
  const [providers, setProviders] = useState([]);
  // How hard the model thinks, and which levels this build of the CLI takes.
  // Empty means the CLI's own default rather than a level we picked for it.
  const [effort, setEffort] = useState('');
  const [efforts, setEfforts] = useState([]);
  // Whether the chosen model is the long-context half of a pair, and whether it
  // has one at all. Haiku does not.
  const [longContext, setLongContext] = useState({ on: false, capable: false });

  // Read inside the IPC listeners, which are registered once and would
  // otherwise close over the first render's chats.
  const chatsRef = useRef(chats);
  const activeRef = useRef(activeKey);
  useEffect(() => { chatsRef.current = chats; }, [chats]);

  // Chats being moved to another CLI right now, and the CLI each chat's last
  // pick put it on. Both are read before state has caught up, which is the
  // point: a message or a second pick in that gap must see the switch.
  // `switching` holds each chat mid-switch until the switched chat has been
  // committed; `reading` each chat whose stored transcript is being read in
  // ahead of a handoff; `carried` the handoff rows whose handoff has gone, so
  // two quick sends cannot both carry it.
  const switching = useRef(new Map());
  const reading = useRef(new Set());
  const carried = useRef(new Set());
  const intended = useRef(new Map());
  // For listeners registered once, which would otherwise close over the first
  // render's sendTo.
  const sendToRef = useRef(null);
  const serial = useRef(null);
  if (!serial.current) serial.current = createSerial();

  /* What a chat's sessions mean outside this window, written from committed
     state so no update still pending can hide one: the run of sessions a
     switched chat is made of, which keeps it one row in the rail; a name given
     before the first session existed; and the board, which belongs to the
     chat's first session only. Each is sent again only when it changes. */
  const written = useRef({ segments: new Map(), titles: new Map(), boards: new Map(), started: new Set() });
  // Which chats have a handoff waiting on their next message, by the session
  // the phone knows them by. Main hands a phone message for one of these to
  // this window rather than to the session the chat is leaving.
  const pendingSent = useRef(null);
  useEffect(() => {
    const pending = chats.filter((c) => c.handoff && headOf(c)).map((c) => ({ head: headOf(c), key: c.key }));
    const json = JSON.stringify(pending);
    if (pendingSent.current === json) return;
    pendingSent.current = json;
    conn().agent.pendingHandoffs?.(pending);
  }, [chats]);

  useEffect(() => {
    const { segments, titles, boards, started } = written.current;
    for (const c of chats) {
      const head = headOf(c);
      if (!head) continue;
      const segs = persistable(c.segments);
      const json = segs && JSON.stringify(segs);
      if (json && segments.get(c.key) !== json) {
        segments.set(c.key, json);
        conn().agent.setSegments(head, segs)
          .then((res) => (res?.error ? segments.delete(c.key) : window.connRail?.refresh()))
          .catch(() => segments.delete(c.key));
      }
      const title = c.renamed && c.title ? `${head}\0${c.title}` : null;
      if (title && titles.get(c.key) !== title) {
        titles.set(c.key, title);
        conn().agent.rename(head, c.title).catch(() => titles.delete(c.key));
      }
      // Only once a session has started here: a chat merely opened off disk
      // keeps whatever board it had on record, or none.
      if (c.canvas && started.has(c.key) && boards.get(c.key) !== `${head}\0${c.canvas}`) {
        boards.set(c.key, `${head}\0${c.canvas}`);
        conn().canvas.bind(head, c.canvas);
      }
    }
  }, [chats]);

  // Each chat's totals go to the ledger behind the Usage page whenever the
  // counted part changes, which is once per result or Stop, not per request.
  const recorded = useRef(new Map());
  useEffect(() => {
    for (const c of chats) {
      const { banked, live } = c.usage;
      const seen = recorded.current.get(c.key);
      if (seen?.banked === banked && seen?.live === live) continue;
      recorded.current.set(c.key, { banked, live });
      const models = byModel(c.usage);
      if (Object.keys(models).length) conn().agent.recordUsage?.(c.key, c.provider, models)?.catch?.(() => {});
    }
  }, [chats]);
  // Same reason: the callbacks that open a new chat are memoised on other
  // things and would otherwise hand it the CLI that was picked on first render.
  const providerRef = useRef(provider);
  useEffect(() => { providerRef.current = provider; }, [provider]);
  useEffect(() => { activeRef.current = activeKey; }, [activeKey]);

  // Text deltas arrive per token, and two chats can be streaming at once, so
  // each keeps its own buffer: the block being written to, the chunk waiting
  // for the next frame, and the text already rendered from a non-streamed
  // block. A subagent streams alongside the thread that spawned it, so the
  // buffer is per chat and per agent, not per chat.
  const streams = useRef(new Map());
  const streamKey = (chat, parent) => `${chat}\0${parent || ''}`;
  const streamOf = useCallback((chat, parent) => {
    const k = streamKey(chat, parent);
    let st = streams.current.get(k);
    if (!st) { st = { chat, parent: parent || null, open: null, pending: '', raf: 0, seen: new Set() }; streams.current.set(k, st); }
    return st;
  }, []);

  const edit = useCallback((key, fn) => {
    setChats((cur) => cur.map((c) => (c.key === key ? fn(c) : c)));
  }, []);

  const push = useCallback((key, item) => {
    edit(key, (c) => ({ ...c, items: [...c.items, item] }));
  }, [edit]);

  const patch = useCallback((key, id, changes) => {
    edit(key, (c) => ({ ...c, items: c.items.map((it) => (it.id === id ? { ...it, ...changes } : it)) }));
  }, [edit]);

  const flushStream = useCallback((key, parent) => {
    const st = streamOf(key, parent);
    st.raf = 0;
    const chunk = st.pending;
    const id = st.open?.id;
    st.pending = '';
    if (!chunk || !id) return;
    edit(key, (c) => ({
      ...c,
      items: c.items.map((it) => (it.id === id ? { ...it, text: it.text + chunk } : it)),
    }));
  }, [edit, streamOf]);

  const appendStream = useCallback((key, parent, text) => {
    const st = streamOf(key, parent);
    st.pending += text;
    if (!st.raf) st.raf = requestAnimationFrame(() => flushStream(key, parent));
  }, [flushStream, streamOf]);

  // A thought is over once anything else takes its slot, whether or not its
  // stop ever arrives.
  const endThought = useCallback((key, parent) => {
    const st = streamOf(key, parent);
    const open = st.open;
    if (open?.kind !== 'reasoning') return;
    flushStream(key, parent);
    st.open = null;
    if (!open.pushed) return;
    const now = Date.now();
    edit(key, (c) => ({ ...c, items: c.items.map((it) => (it.id === open.id ? settle(it, now) : it)) }));
  }, [edit, flushStream, streamOf]);

  // Ends the chat's thoughts with its turn, so a delta that lands late cannot
  // grow a row that already folded. A background agent outlives the turn, and
  // so does its thought.
  const dropThoughts = useCallback((key) => {
    const live = outlivingIds(chatsRef.current.find((c) => c.key === key)?.items || []);
    for (const st of streams.current.values()) {
      if (st.chat === key && !live.has(st.parent)) endThought(key, st.parent);
    }
  }, [endThought]);

  useEffect(() => {
    const offs = [];

    const notify = (key, body) => {
      const title = chatsRef.current.find((c) => c.key === key)?.title || 'Conn';
      conn().agent.notify({ chat: key, title, body });
    };

    offs.push(conn().agent.onMessage(({ chat, msg }) => {
      if (!chat || !msg) return;
      // Everything a subagent does carries the Agent call that started it.
      const parent = msg.parent_tool_use_id || null;
      const st = streamOf(chat, parent);

      if (msg.type === 'stream_event') {
        const ev = msg.event;
        if (ev?.type?.startsWith('message_')) edit(chat, (c) => ({ ...c, usage: account(c.usage, msg) }));
        const block = ev?.content_block?.type;
        if (ev?.type === 'content_block_start' && block === 'text') {
          endThought(chat, parent);
          flushStream(chat, parent);
          st.open = { id: uid('a'), kind: 'assistant' };
          push(chat, { id: st.open.id, kind: 'assistant', text: '', streaming: true, parent });
        } else if (ev?.type === 'content_block_start' && block === 'thinking') {
          endThought(chat, parent);
          flushStream(chat, parent);
          st.open = { id: uid('r'), kind: 'reasoning', at: Date.now(), pushed: false };
        } else if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && st.open?.kind === 'assistant') {
          appendStream(chat, parent, ev.delta.text);
        } else if (ev?.type === 'content_block_delta' && ev.delta?.type === 'thinking_delta' && st.open?.kind === 'reasoning' && ev.delta.thinking
          && (st.open.pushed || ev.delta.thinking.trim())) {
          if (!st.open.pushed) {
            st.open.pushed = true;
            push(chat, { id: st.open.id, kind: 'reasoning', parent, text: '', streaming: true, at: st.open.at });
          }
          appendStream(chat, parent, ev.delta.thinking);
        } else if (ev?.type === 'content_block_stop' && st.open) {
          // Land the tail before the block closes, or the last few tokens of
          // every message go missing.
          flushStream(chat, parent);
          if (st.open.kind === 'assistant') {
            patch(chat, st.open.id, { streaming: false });
            st.open = null;
          } else endThought(chat, parent);
        }
        return;
      }

      // A turn the SDK starts on its own has no send behind it, only this.
      if (msg.type === 'system' && msg.subtype === 'init' && !parent) {
        edit(chat, (c) => ({ ...c, busy: true, startedAt: c.busy ? c.startedAt : Date.now() }));
        return;
      }

      // The live set of background work, sent whole every time it changes. Swap
      // for it rather than pairing start and stop events, so a missed edge
      // cannot leave a spinner running forever.
      if (msg.type === 'system' && msg.subtype === 'background_tasks_changed') {
        const live = new Set((msg.tasks || []).map((t) => t.task_id));
        edit(chat, (c) => ({
          ...c,
          items: c.items.map((it) => (it.kind === 'agent' && it.background && it.status === 'running' && it.taskId && !live.has(it.taskId)
            ? { ...it, status: 'done' }
            : it)),
        }));
        return;
      }

      // Compaction is the one moment the window empties out. Say so in the
      // transcript and drop the meter now rather than leaving it pinned until
      // the next reply arrives with a smaller request behind it.
      if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
        const { pre_tokens: pre, post_tokens: post, trigger } = msg.compact_metadata || {};
        edit(chat, (c) => ({
          ...c,
          usage: post ? { ...c.usage, context: post } : c.usage,
          items: [...c.items, {
            id: uid('k'),
            kind: 'note',
            text: pre && post
              ? `context compacted, ${Math.round(pre / 1000)}k down to ${Math.round(post / 1000)}k`
              : `context compacted${trigger === 'manual' ? '' : ' automatically'}`,
          }],
        }));
        return;
      }

      if (msg.type === 'system' && (msg.subtype === 'task_started' || msg.subtype === 'task_progress')) {
        const id = msg.tool_use_id;
        if (!id) return;
        edit(chat, (c) => ({
          ...c,
          tasks: { ...c.tasks, [msg.task_id]: id },
          items: c.items.map((it) => {
            if (it.id !== id) return it;
            // A shell started with run_in_background reports as a task too.
            // It is still a command, so it keeps its Bash row and gets the
            // task id it can be stopped by.
            if (it.kind !== 'agent') return { ...it, taskId: msg.task_id, status: 'running', background: true };
            return {
              ...it,
              taskId: msg.task_id,
              agentType: msg.subagent_type || it.agentType || 'agent',
              // Only what it was asked to do, which does not change. Progress
              // messages carry a live "Running <whatever>" line instead, and
              // letting that win makes the row rename itself every few seconds.
              description: msg.subtype === 'task_started'
                ? (msg.description || it.description)
                : it.description,
              status: 'running',
              background: msg.subtype === 'task_started' ? !!msg.is_backgrounded : it.background,
              depth: msg.spawn_depth || it.depth || 1,
              tools: msg.usage?.tool_uses ?? it.tools ?? 0,
              ms: msg.usage?.duration_ms ?? it.ms ?? 0,
              lastTool: msg.last_tool_name || it.lastTool || null,
            };
          }),
        }));
        return;
      }

      if (msg.type === 'system' && msg.subtype === 'task_notification') {
        const chatNow = chatsRef.current.find((c) => c.key === chat);
        const id = msg.tool_use_id || chatNow?.tasks[msg.task_id];
        if (!id) return;
        patch(chat, id, {
          status: msg.status === 'completed' ? 'done' : msg.status,
          summary: msg.summary || null,
          tools: msg.usage?.tool_uses ?? undefined,
          ms: msg.usage?.duration_ms ?? undefined,
        });
        return;
      }

      if (msg.type === 'tool_input' && msg.tool_use_id && msg.input && typeof msg.input === 'object') {
        // A path that shows up a beat after the row does. Merge it in so the
        // line can name the file instead of staying a bare "Edit".
        edit(chat, (c) => ({
          ...c,
          items: c.items.map((it) => (it.id === msg.tool_use_id
            ? { ...it, input: { ...(it.input || {}), ...msg.input } }
            : it)),
        }));
        return;
      }

      if (msg.type === 'rate_limit_event' && !parent) {
        edit(chat, (c) => ({ ...c, failure: { ...c.failure, limit: msg.rate_limit_info } }));
        return;
      }

      if (msg.type === 'assistant' && msg.error && !parent) {
        const text = (msg.message?.content || []).map((b) => b.text || '').join('\n');
        edit(chat, (c) => ({ ...c, failure: { ...c.failure, error: msg.error, text } }));
        return;
      }

      if (msg.type === 'assistant') {
        // How full the window is, which is the size of the request this reply
        // came back from. A subagent has a window of its own, so only the main
        // thread says anything about this conversation.
        if (!parent && msg.message?.usage) edit(chat, (c) => ({ ...c, usage: account(c.usage, msg) }));
        if ((msg.message?.content || []).some((b) => b.type === 'tool_use' || b.type === 'text')) endThought(chat, parent);
        for (const b of msg.message?.content || []) {
          const plan = b.type === 'tool_use' && b.name === 'TodoWrite' ? planOf(b.input) : null;
          if (plan) {
            edit(chat, (c) => ({ ...c, items: withPlan(c.items, { parent, ...plan }) }));
          } else if (b.type === 'tool_use') {
            // An Agent call is a container, not a step: its own rows arrive
            // later carrying its id as their parent.
            const agent = b.name === 'Agent' || b.name === 'Task';
            push(chat, {
              id: b.id,
              kind: agent ? 'agent' : 'tool',
              name: b.name,
              input: b.input,
              state: 'input-available',
              parent,
              // When the call went out. An agent needed this for its elapsed
              // line; a plain tool row needs it too, because a Bash step that
              // takes a minute is the most common reason the screen looks
              // frozen and the row had no way to say how long it had been out.
              at: Date.now(),
              ...(agent ? {
                agentType: b.input?.subagent_type || 'agent',
                description: b.input?.description || '',
                status: 'running',
                tools: 0,
                ms: 0,
              } : {}),
            });
          } else if (b.type === 'text' && st.open?.kind !== 'assistant' && !isInternalAnswerArtifact(b.text)) {
            // Only render text that did not already arrive as deltas.
            const key = (b.text || '').slice(0, 80);
            if (!st.seen.has(key)) {
              // Guards one turn against a duplicate, so it does not need to
              // remember the whole conversation.
              if (st.seen.size >= 200) st.seen.clear();
              st.seen.add(key);
              push(chat, { id: uid('t'), kind: 'assistant', text: b.text, parent });
            }
          }
        }
        return;
      }

      if (msg.type === 'user') {
        // The structured result of an Agent call: what it did, in numbers, plus
        // the report itself. Better than parsing it back out of the text.
        const done = msg.tool_use_result;
        for (const b of msg.message?.content || []) {
          if (b.type !== 'tool_result') continue;
          const extra = done?.agentId && done.status === 'completed' ? {
            kind: 'agent',
            status: 'done',
            tools: done.totalToolUseCount ?? undefined,
            ms: done.totalDurationMs ?? undefined,
            tokens: done.totalTokens ?? undefined,
            stats: done.toolStats || null,
            report: (done.content || []).map((p) => p.text || '').join('\n').trim() || null,
          } : done?.status === 'async_launched' ? { kind: 'agent', background: true, status: 'running' } : null;
          patch(chat, b.tool_use_id, {
            state: b.is_error ? 'output-error' : 'output-available',
            output: b.content,
            end: Date.now(),
            ...(extra || {}),
          });
        }
        return;
      }

      if (msg.type === 'result') {
        const secs = msg.duration_ms ? `${(msg.duration_ms / 1000).toFixed(1)}s` : '';
        const failed = msg.is_error === true || (msg.subtype && msg.subtype !== 'success');
        const away = chat !== activeRef.current;
        edit(chat, (c) => {
          const turnError = failed && !c.stopped
            ? msg.turnError ?? classify.claude({ ...c.failure, result: msg })
            : null;
          return {
            ...c,
            failure: null,
            stopped: false,
            busy: false,
            endedUnseen: away,
            toastDue: away ? (failed ? 'error' : 'done') : null,
            usage: account(c.usage, msg),
            // A blocking agent cannot outlive the turn that was waiting on it. If
            // its notification went missing, the turn ending says the same thing,
            // and a row that spins forever is worse than one that stops early.
            items: [...endTurn(c.items, 'done'), {
              id: uid('r'),
              kind: 'note',
              ended: true,
              error: !!failed,
              text: turnError ? turnError.message : failed ? `turn ended: ${msg.subtype} ${secs}` : `done in ${secs}`,
              ...(turnError && { turnError }),
            }],
          };
        });
        window.connRail?.refresh();
        if (msg.duration_ms >= LONG_TURN_MS) notify(chat, failed ? 'Ended with an error' : `Done in ${secs}`);
      }
    }));

    offs.push(conn().agent.onReady(({ chat, sessionId, model: m, mode: sessionMode, provider: on }) => {
      if (!chat) return;
      const unsent = chatsRef.current.find((c) => c.key === chat && !headOf(c) && (!on || c.provider === on));
      if (sessionId && unsent) moveDraft(ownedStorageKey(chatsRef.current, unsent), sessionId);
      // What the session id means for the rail, the board and the name is
      // written down by the effect that watches committed chats, below. Read
      // here, inside or after this update, it would be whatever React had
      // applied so far, which under a pending update is not this one.
      if (sessionId) written.current.started.add(chat);
      edit(chat, (c) => ({
        ...withSession(c, sessionId, on),
        // One of ours, not one of the SDK's four: the session is the one
        // holding the answer after a resume.
        mode: sessionMode || c.mode,
        // Which model the window size and the prices are read against.
        usage: m ? { ...c.usage, model: m } : c.usage,
      }));
      if (m) setModel((cur) => shownModel(cur, m, chat === activeRef.current));
      window.connRail?.refresh();
    }));

    // A permission card stays at the bottom of the transcript, because it is
    // blocking the whole chat wherever it came from. `agent` says who asked, so
    // it does not read as the main thread when it was a subagent.
    offs.push(conn().agent.onPermission(({ chat, ...p }) => {
      push(chat, { ...p, id: p.id, kind: 'perm' });
      if (p.agent?.toolUseId) patch(chat, p.agent.toolUseId, { waiting: true });
      notify(chat, `${p.tool} needs your permission`);
    }));

    offs.push(conn().agent.onReveal(({ chat }) => {
      const found = chatsRef.current.find((c) => c.key === chat);
      if (found) openChat(found);
    }));

    // The session can move the mode on its own: approving a plan leaves plan
    // mode whether or not anyone touched the picker.
    offs.push(conn().agent.onMode?.(({ chat, mode: m }) => edit(chat, (c) => ({ ...c, mode: m }))) ?? (() => {}));

    offs.push(conn().agent.onDecided?.(({ chat, id, decision }) =>
      patch(chat || activeRef.current, id, { decided: decision })) ?? (() => {}));

    offs.push(conn().agent.onError(({ chat, error }) => {
      const key = chat || activeRef.current;
      const away = key !== activeRef.current;
      const now = Date.now();
      dropThoughts(key);
      edit(key, (c) => {
        const turnError = classify.text(c.provider, error);
        return {
          ...c,
          busy: false,
          endedUnseen: away,
          items: [...c.items.map((it) => settle(it, now)), { id: uid('e'), kind: 'note', ended: true, error: true, text: turnError.message, turnError }],
        };
      });
      const finished = away && chatsRef.current.find((c) => c.key === key);
      if (finished) toastEnd(finished, true);
    }));

    // A session ending is not the chat ending: a parked chat is stopped on
    // purpose and its transcript stays on screen.
    // The process is gone, and every agent and background shell it was running
    // went with it. A row left saying running would count up forever.
    offs.push(conn().agent.onClosed(({ chat } = {}) => {
      if (!chat) return;
      const now = Date.now();
      edit(chat, (c) => {
        const cut = c.items.some(isRunning);
        const items = c.items.map((it) => settle(it, now));
        return {
          ...c,
          busy: false,
          items: cut
            ? [...items.map((it) => (isRunning(it) ? { ...it, status: 'stopped', waiting: false } : it)),
              { id: uid('i'), kind: 'note', text: 'the session ended, so its background work stopped' }]
            : items,
        };
      });
    }));

    // A message from the phone for a chat switched here but not yet sent on:
    // only this window holds the handoff it has to carry, so it goes from here.
    offs.push(conn().agent.onPhoneTurn?.(({ id, chat, text, images }) => {
      if (!chat || !chatsRef.current.some((c) => c.key === chat)) {
        conn().agent.phoneTurnTaken?.(id, { ok: false, error: 'That chat is not open in Conn any more.' });
        return;
      }
      // Answered once the message is in the chat, as a bubble or queued.
      let answered = false;
      const answer = (result) => {
        if (answered) return;
        answered = true;
        conn().agent.phoneTurnTaken?.(id, result);
      };
      Promise.resolve(sendToRef.current?.(chat, text, images || [], { taken: () => answer({ ok: true }) }))
        .then(() => answer({ ok: false, error: 'Conn could not take the message.' }))
        .catch((e) => answer({ ok: false, error: e.message }));
    }) ?? (() => {}));

    // `conn ask` from the terminal can open a chat too.
    offs.push(conn().agent.onEcho?.(({ chat, text, forkAt }) => {
      const key = chat || activeRef.current;
      edit(key, (c) => ({
        ...c,
        busy: true,
        startedAt: c.busy ? c.startedAt : Date.now(),
        // Same as a message typed here: the first one names the chat, which is
        // what the rail shows until claude has written a transcript to read.
        title: c.title === 'New chat' ? chatTitle(text).slice(0, TITLE_MAX) : c.title,
        items: [...c.items, { id: uid('u'), kind: 'user', text, ...(forkAt && { forkAt }) }],
      }));
    }) ?? (() => {}));

    return () => {
      offs.forEach((off) => { try { off?.(); } catch {} });
      for (const st of streams.current.values()) if (st.raf) cancelAnimationFrame(st.raf);
    };
  }, [push, patch, edit, appendStream, flushStream, streamOf, endThought, dropThoughts]);

  // The model list comes from the driver cache, not from a live session: asking
  // the SDK would spawn the agent binary just to draw a dropdown.
  useEffect(() => {
    const apply = (d) => {
      if (!d) return;
      setDriver({
        installed: d.installed, version: d.version, message: d.message,
        endpoint: d.endpoint, binaryPath: d.binaryPath || null,
      });
      if (d.providers?.length) setProviders(d.providers);
      if (d.provider) {
        setProvider(d.provider);
        // The chat on screen at first paint was built before main had said which
        // CLI it prefers. One that has said nothing yet still belongs to nobody,
        // so it follows; one with a transcript keeps what it has.
        setChats((cur) => cur.map((c) => (followsWindowProvider(c)
          ? { ...c, provider: d.provider }
          : c)));
      }
      if (d.efforts?.length) setEfforts(d.efforts);
      if (typeof d.effort === 'string') setEffort(d.effort);
      if (typeof d.long === 'boolean') setLongContext({ on: d.long, capable: !!d.longCapable });
      if (!d.models?.length) return setModels([]);
      setModels(d.models);
      // Left empty when nothing has been chosen, so the picker says "Pick a
      // model" instead of naming one the main process never received.
      setModel((cur) => cur || d.current || '');
    };
    conn().agent.models(activeRef.current).then(apply).catch(() => {});
    // The probe finishes after the first paint on a cold cache, and on that
    // first run it carries the choice main settled on once it had a list.
    return conn().agent.onDriver?.(apply) ?? undefined;
  }, []);

  const active = useMemo(
    () => chats.find((c) => c.key === activeKey) || chats[0],
    [chats, activeKey],
  );

  // The terminal, files, changes and browser belong to the chat on screen. Focus
  // used to move only when a chat was opened from the rail, so a chat started
  // from a folder's plus, or switched to any other way, left the panes on the
  // folder before. The chat's folder is the one answer, whichever way it came.
  // The folderless chats dir is not an open project, so it moves nothing.
  const activeProject = active?.project || null;
  useEffect(() => {
    if (!activeProject || activeProject === focusedProject.current || activeProject === chatsDir.current) return;
    focusedProject.current = activeProject;
    conn().project.focus(activeProject).catch(() => {});
  }, [activeProject]);

  // Back into a tree for drawing. Items keep their arrival order inside each
  // agent, so a nested run reads top to bottom the way it happened, and an
  // agent that spawned its own agents nests again.
  const tree = useMemo(() => {
    const kids = new Map();
    for (const it of active.items) {
      if (!it.parent) continue;
      const list = kids.get(it.parent) || [];
      list.push(it);
      kids.set(it.parent, list);
    }
    const build = (item) => (item.kind === 'agent'
      ? { ...item, children: (kids.get(item.id) || []).map(build) }
      : item);
    return active.items.filter((it) => !it.parent).map(build);
  }, [active.items]);

  const usage = useMemo(() => totals(active.usage), [active.usage]);

  // Every agent still going, at any depth. The strip above the composer is the
  // only thing that says a background agent exists once the transcript has
  // scrolled past the row that started it.
  // Background shells count: a dev server left running is still going.
  const running = useMemo(
    () => active.items.filter(isRunning),
    [active.items],
  );

  // The main process routes `conn ask` at whatever is on screen.
  useEffect(() => {
    conn().agent.active?.(activeKey, active?.session || null);
  }, [activeKey, active?.session]);

  useEffect(() => {
    window.connRail?.sync?.({
      active: activeKey,
      // Said apart from the list, which leaves out a chat nobody has typed in,
      // because the welcome screen stands aside for a blank chat with no folder.
      activeProject: active?.project || null,
      // A chat nobody has typed in is not a chat yet.
      chats: chats.filter((c) => c.session || c.items.length).map((c) => ({
        key: c.key,
        project: c.project || focusedProject.current,
        session: headOf(c),
        title: c.title,
        renamed: !!c.renamed,
        busy: c.busy,
        waiting: hasUndecidedPerm(c.items),
        agents: c.items.filter((it) => it.kind === 'agent' && it.status === 'running').length,
        shells: c.items.filter((it) => it.kind !== 'agent' && isRunning(it)).length,
        activity: chatActivity(c.items, c.busy, !c.endedUnseen),
      })),
    });
  }, [chats, activeKey]);

  useEffect(() => {
    const due = chats.filter((c) => c.toastDue && !c.busy && (c.toastDue === 'error' || !c.items.some(outlivesTurn)));
    if (!due.length) return;
    for (const c of due) if (c.key !== activeKey) toastEnd(c, c.toastDue === 'error');
    const keys = new Set(due.map((c) => c.key));
    setChats((cur) => cur.map((c) => (keys.has(c.key) ? { ...c, toastDue: null } : c)));
  }, [chats, activeKey]);

  useEffect(() => {
    if (!chats.some((c) => c.key === activeKey && c.endedUnseen)) return;
    setChats((cur) => cur.map((c) => (c.key === activeKey && c.endedUnseen ? { ...c, endedUnseen: false, toastDue: null } : c)));
  }, [activeKey, chats]);

  // The rest of a chat opened with only its end read in, before a handoff is
  // built from it. Returns the chat as it is once that is in, or as it was if
  // the read failed: a handoff of the end is still better than none.
  const readWhole = useCallback(async (key, chat) => {
    const at = chat.stored;
    try {
      const t = await conn().agent.transcript(at.session, chat.project, { limit: at.to, end: at.to });
      const span = storedWindow(t, at.to);
      const fresh = replayStored(t, span.from);
      edit(key, (c) => widened(c, fresh, span, at.session));
      return widened(chat, fresh, span, at.session);
    } catch {
      return chat;
    }
  }, [edit]);

  // `session` stands in for the chat's own when a rewind has just moved it and
  // chatsRef has not caught up. `resent` marks a message sent again at the end.
  // `committed` is the chat as React last committed it, from the queue's flush;
  // anything else reads the ref.
  // `taken` is told once the message is in the chat, as a bubble or queued.
  const sendTo = useCallback(async (key, text, images = [], { session, resent, committed, taken } = {}) => {
    if (!text.trim() && !(images || []).length) return;
    // Mid-switch, the session this would go to is the one being left; while
    // the rest of a transcript is read in, the handoff is about to go with the
    // message ahead of this one. Either way it waits in the queue.
    if (switching.current.has(key) || reading.current.has(key)) {
      edit(key, (c) => ({ ...c, queued: [...c.queued, { id: uid('q'), text, images }] }));
      taken?.();
      return;
    }
    let chat = committed || chatsRef.current.find((c) => c.key === key);
    // A handoff picks from the whole chat, so one opened with only its end
    // read in reads the rest first: the first ask is usually in what is not.
    if (chat?.handoff && !carried.current.has(chat.handoff.marker) && chat.stored) {
      reading.current.add(key);
      try {
        chat = await readWhole(key, chat);
      } finally {
        reading.current.delete(key);
      }
    }
    const id = uid('u');
    // The turns this agent missed ride ahead of the message, once. The bubble
    // shows only what was typed; the handoff row above it says what went.
    const owed = chat?.handoff && !carried.current.has(chat.handoff.marker) ? chat.handoff : null;
    if (owed) carried.current.add(owed.marker);
    const carry = owed ? handoffFor(chat, text, images) : null;
    // The bubble parses the attachment preamble into badges, so it keeps the
    // whole text. A note typed against an element lives in that preamble.
    edit(key, (c) => ({
      ...c,
      // A message handed to a turn already running joins that turn's clock.
      // Only a turn starting from idle resets it.
      startedAt: c.busy ? c.startedAt : Date.now(),
      busy: true,
      failure: null,
      stopped: false,
      title: c.title === 'New chat' ? chatTitle(text).slice(0, TITLE_MAX) : c.title,
      handoff: carry ? null : c.handoff,
      // Where this stretch starts in its session, counted now that the whole
      // chat is read in. See cutFor.
      ...(carry && c.segments?.length > 1 && { segments: recut(c) }),
      items: [
        ...(carry ? c.items.map((it) => (it.id === owed.marker
          ? { ...it, pending: false, carried: carry.carried, total: carry.total, scope: carry.scope }
          : it)) : c.items),
        { id, kind: 'user', text, images, ...(resent && { resent }) },
      ],
    }));
    taken?.();
    try {
      const res = await conn().agent.send(
        key, session === undefined ? chat?.session || null : session, carry ? wrapMessage(carry.text, text) : text, images,
        chat?.project || focusedProject.current, chat?.provider || providerRef.current,
      );
      // A session that could not start says why. Worth printing as it stands:
      // it names the missing CLI, and prefixing it would only muddy that.
      if (res?.error) throw new Error(res.error, { cause: 'said' });
      if (res?.forkAt) patch(key, id, { forkAt: res.forkAt });
    } catch (e) {
      const said = e.cause === 'said';
      if (owed) carried.current.delete(owed.marker);
      edit(key, (c) => ({
        ...c,
        busy: false,
        // Nothing reached the agent, so the next message carries it instead,
        // and the row says so again rather than counting what never went.
        handoff: carry && !c.handoff ? owed : c.handoff,
        items: [...(carry ? c.items.map((it) => (it.id === owed.marker
          ? { ...it, pending: true, carried: undefined, total: undefined, scope: undefined }
          : it)) : c.items), {
          id: uid('e'), kind: 'note', error: true,
          text: said ? e.message : `could not reach the agent: ${e.message}`,
        }],
      }));
    }
  }, [edit, patch, readWhole]);

  sendToRef.current = sendTo;
  const send = useCallback((text, images = []) => sendTo(activeRef.current, text, images), [sendTo]);

  // The other CLIs cannot go back to a message, so for them it is sent again
  // at the end.
  const redo = useCallback(async (id, how, text, images = []) => {
    const key = activeRef.current;
    const chat = chatsRef.current.find((c) => c.key === key);
    const item = chat?.items.find((it) => it.id === id);
    if (!item || chat.busy) return;
    // A switched chat runs on several sessions, and going back would cut
    // only one of them, so it sends the message again at the end instead.
    if (chat.provider !== 'claude' || !item.forkAt || !chat.session || chat.segments?.length > 1) {
      sendTo(key, text, images, { resent: how });
      return;
    }
    edit(key, (c) => ({ ...c, busy: true, startedAt: Date.now() }));
    const res = await conn().agent.rewind(key, chat.session, item.forkAt, chat.project || focusedProject.current)
      .catch((e) => ({ error: e.message }));
    if (res?.error) {
      edit(key, (c) => ({
        ...c,
        busy: false,
        items: [...c.items, { id: uid('e'), kind: 'note', error: true, text: `could not go back to that message: ${res.error}` }],
      }));
      return;
    }
    // The fork renamed every message, so earlier ones read off the old
    // transcript could not be gone back to. Reopening the fork from the rail
    // reads its own.
    edit(key, (c) => ({ ...c, session: res.sessionId, items: before(c.items, id, res.uuids), stored: null }));
    sendTo(key, text, images, { session: res.sessionId });
  }, [edit, sendTo]);

  const retryTurn = useCallback((noteId) => {
    const items = chatsRef.current.find((c) => c.key === activeRef.current)?.items || [];
    const at = items.findIndex((it) => it.id === noteId);
    const user = at < 0 ? null : items.slice(0, at).reverse().find((it) => it.kind === 'user' && !it.parent);
    if (user) redo(user.id, 'retry', user.text, user.images || []);
  }, [redo]);

  const editsSince = useCallback(async (id) => {
    const key = activeRef.current;
    const chat = chatsRef.current.find((c) => c.key === key);
    const at = chat ? chat.items.findIndex((it) => it.id === id) : -1;
    const item = at < 0 ? null : chat.items[at];
    if (!item?.forkAt || chat.provider !== 'claude' || chat.busy || chat.segments?.length > 1) return null;
    if (!editedAfter(chat.items, at)) return null;
    const res = await conn().agent.editsSince(key, chat.session, item.forkAt,
      chat.project || focusedProject.current, chat.provider).catch(() => null);
    return res?.files?.length ? res : null;
  }, []);

  const undoEdits = useCallback(async (id) => {
    const key = activeRef.current;
    const chat = chatsRef.current.find((c) => c.key === key);
    const item = chat?.items.find((it) => it.id === id);
    if (!item?.forkAt || chat.provider !== 'claude') return { error: 'only Claude chats can undo edits' };
    if (chat.segments?.length > 1) return { error: 'a chat that changed agent cannot undo edits' };
    if (chat.busy) return { error: 'this chat is still working' };
    const res = await conn().agent.undoEdits(key, chat.session, item.forkAt,
      chat.project || focusedProject.current, chat.provider).catch((e) => ({ error: e.message }));
    if (!res || res.error) return res || { error: 'no answer' };
    if (!res.files?.length) return { error: 'nothing left to undo' };
    patch(key, id, { undone: { files: res.files.length, skipped: res.skipped || 0 } });
    return res;
  }, [patch]);

  const enqueue = useCallback((text, images = []) => {
    if (!text.trim()) return;
    edit(activeRef.current, (c) => ({ ...c, queued: [...c.queued, { id: uid('q'), text, images }] }));
  }, [edit]);

  const unqueue = useCallback((id) => {
    edit(activeRef.current, (c) => ({ ...c, queued: c.queued.filter((m) => m.id !== id) }));
  }, [edit]);

  const sendNext = useCallback((id) => {
    edit(activeRef.current, (c) => {
      const m = c.queued.find((q) => q.id === id);
      return m ? { ...c, queued: [{ ...m, held: false }, ...c.queued.filter((q) => q.id !== id)] } : c;
    });
  }, [edit]);

  // The id is looked up across chats, because leaving the chat unmounts the
  // editor and that release has to land on the chat the message belongs to.
  const editQueued = useCallback((id, patch) => {
    setChats((cur) => cur.map((c) => {
      if (!c.queued.some((m) => m.id === id)) return c;
      return {
        ...c,
        queued: c.queued.flatMap((m) => {
          if (m.id !== id) return [m];
          const next = { ...m, ...patch };
          if (patch.text !== undefined) {
            const text = String(patch.text ?? '').trim();
            if (!text && !(m.images || []).length) return [];
            next.text = text;
          }
          return [next];
        }),
      };
    }));
  }, []);

  // One parked message leaves per idle turn, and only the one at the front.
  // Handing the rest over in the same breath would land them inside the turn
  // that just started. A message being edited stays at the front until the
  // edit is saved, so the ones behind it keep their order. The set stops a
  // second pass sending the next message before this one has been marked busy.
  const flushing = useRef(new Set());
  // `committed` is the chat as the effect below saw it committed. The ref can
  // still hold the chat from before a switch that has just landed, and a
  // message sent from that would go to the CLI being left, without a handoff.
  const flushChat = useCallback(async (key, committed) => {
    if (flushing.current.has(key)) return;
    const chat = committed || chatsRef.current.find((c) => c.key === key);
    if (!chat || chat.busy || switching.current.has(key) || reading.current.has(key)) return;
    const head = chat.queued?.find((m) => !m.held);
    if (!head || head.editing) return;
    flushing.current.add(key);
    edit(key, (c) => ({ ...c, queued: c.queued.filter((m) => m.id !== head.id) }));
    try {
      if (head.text?.trim() || (head.images || []).length) await sendTo(key, head.text, head.images, { committed: chat });
    } finally {
      flushing.current.delete(key);
    }
  }, [edit, sendTo]);

  // A parked message goes out on its own once that chat is idle. Background
  // chats included, still one message per turn.
  useEffect(() => {
    // A switch has landed once its chat is committed on the new CLI.
    for (const [key, s] of switching.current) {
      if (!s.landing) continue;
      const c = chats.find((x) => x.key === key);
      if (!c || c.provider === s.want) switching.current.delete(key);
    }
    for (const c of chats) if (!c.busy && c.queued.length) flushChat(c.key, c);
  }, [chats, flushChat]);

  const decide = useCallback((id, decision, input) => {
    const key = activeRef.current;
    conn().agent.decide(key, id, decision, input);
    // answers, when there are any, so the settled card can show what was picked
    patch(key, id, { decided: decision, answers: input?.answers });
    // The agent that asked is no longer stuck on us.
    const card = chatsRef.current.find((c) => c.key === key)?.items.find((it) => it.id === id);
    if (card?.agent?.toolUseId) patch(key, card.agent.toolUseId, { waiting: false });
  }, [patch]);

  // Stopping one agent rather than the whole turn. Everything else in flight
  // carries on, which is the point of stopping just this one.
  const stopAgent = useCallback(async (item) => {
    const key = activeRef.current;
    if (!item?.taskId) return;
    patch(key, item.id, { status: 'stopping' });
    const res = await conn().agent.stopTask(key, item.taskId);
    patch(key, item.id, res?.error ? { status: 'running' } : { status: 'stopped' });
  }, [patch]);

  // Hand a blocking agent to the background so the turn stops waiting on it.
  const backgroundAgent = useCallback(async (item) => {
    const key = activeRef.current;
    if (!item?.id) return;
    const res = await conn().agent.background(key, item.id);
    if (res?.ok) patch(key, item.id, { background: true });
  }, [patch]);

  // A replayed chat draws its agent rows from the meta files and only reads a
  // transcript when someone opens one. Loaded once, then kept.
  const openAgent = useCallback(async (item) => {
    const key = activeRef.current;
    const chat = chatsRef.current.find((c) => c.key === key);
    // A row from an earlier segment, or copied by a fork, names its own session.
    const session = item?.session || chat?.session;
    if (!session || !item?.agentId || item.loaded) return;
    patch(key, item.id, { loaded: 'loading' });
    try {
      const t = await conn().agent.subagent(session, item.agentId, chat.project);
      const kids = replay(t.messages, item.id);
      edit(key, (c) => ({ ...c, items: [...c.items, ...kids] }));
      patch(key, item.id, { loaded: true });
    } catch (e) {
      patch(key, item.id, { loaded: true, report: item.report || `could not read that agent's transcript: ${e.message}` });
    }
  }, [edit, patch]);

  // A background agent sends nothing back until it finishes, but it writes its
  // transcript as it goes, under the same id its task started with. Reading
  // that is the only way to watch one work. A tool with no result yet is the
  // step it is on.
  const peekAgent = useCallback(async (item) => {
    const key = activeRef.current;
    const chat = chatsRef.current.find((c) => c.key === key);
    const id = item?.agentId || item?.taskId;
    if (!chat?.session || !id) return;
    try {
      const t = await conn().agent.subagent(chat.session, id, chat.project);
      const steps = replay(t.messages, item.id)
        .map((n) => (n.kind === 'tool' && n.output === undefined ? { ...n, state: 'input-available' } : n));
      patch(key, item.id, { peek: steps });
    } catch {
      // Not written yet, or not a Claude agent. The pane keeps saying so.
    }
  }, [patch]);

  // Pending permission cards are denied here too: main does the same for the
  // SDK, and a card left clickable after Stop is a lie.
  const interrupt = useCallback(async () => {
    const key = activeRef.current;
    dropThoughts(key);
    edit(key, (c) => ({
      ...c,
      queued: c.queued.map((m) => ({ ...m, held: true, now: false })),
      busy: false,
      usage: withStop(c.usage),
      stopped: true,
      items: interrupted(c.items),
    }));
    await conn().agent.interrupt(key);
  }, [edit, dropThoughts]);

  // The message at the front, now rather than after this turn. The turn is
  // stopped and stays busy until its own result arrives, and the idle flush
  // sends the message from there. Every provider sends that result, and
  // sending before it would hand codex a turn it is tearing down and let an
  // ACP prompt's late answer end the new turn.
  const sendNow = useCallback(async () => {
    const key = activeRef.current;
    const chat = chatsRef.current.find((c) => c.key === key);
    const head = chat?.queued.find((m) => !m.held);
    if (!chat?.busy || !head || head.editing || head.now) return false;
    dropThoughts(key);
    edit(key, (c) => ({
      ...c,
      queued: c.queued.map((m) => (m.id === head.id ? { ...m, now: true } : m)),
      stopped: true,
      items: interrupted(c.items),
    }));
    await conn().agent.interrupt(key);
    return true;
  }, [edit, dropThoughts]);

  // Moving to another chat. A chat nobody is waiting on does not need a process
  // sitting behind it: the transcript stays here and the next message resumes
  // it. A chat that is working is left alone, which is the point.
  const switchTo = useCallback((key) => {
    const prev = chatsRef.current.find((c) => c.key === activeRef.current);
    activeRef.current = key;
    setActiveKey(key);
    // Each chat runs on its own CLI, so the picker has to name that one rather
    // than whatever was last chosen somewhere else.
    const next = chatsRef.current.find((c) => c.key === key);
    if (next?.provider) setProvider(next.provider);
    if (next?.usage?.model) setModel(next.usage.model);
    else if (next?.provider) {
      conn().agent.models(key, next.provider).then((res) => {
        if (activeRef.current !== key || !res?.current) return;
        setModel(res.current);
        if (res.provider) setProvider(res.provider);
      }).catch(() => {});
    }
    if (typeof next?.effort === 'string') setEffort(next.effort);
    if (prev && prev.key !== key && !prev.busy && prev.session) {
      conn().agent.reset(prev.key, { idleOnly: true }).catch(() => {});
    }
  }, []);

  // New chat, in the folder you are looking at unless the caller names another:
  // the rail's per-folder button starts a chat in that folder without dragging
  // the rest of the window over to it. A blank chat in the right folder is
  // reused rather than piling up empties; one in another folder is not, because
  // its folder is the thing you asked for.
  const reset = useCallback(async (project = null) => {
    const dir = project || focusedProject.current;
    // The sidebar lists only chats with a message in them, so a second unsent
    // chat in a folder would leave the first, and its draft, out of reach.
    const unsent = chatsRef.current.find((c) => !c.items.length && !c.session && (c.project || dir) === dir);
    if (unsent) {
      if (unsent.key !== activeRef.current) switchTo(unsent.key);
      return;
    }
    const next = blankChat(dir, providerRef.current, startMode.current);
    chatsRef.current = [...chatsRef.current, next];
    setChats(chatsRef.current);
    switchTo(next.key);
  }, [switchTo]);

  /* Pointing the chat on screen at another folder, which is what the chip under
     the box is for. A chat nobody has typed in yet moves: the chip names the
     folder the next message runs in, and picking one from it is how you say
     where you meant that message to go. A chat that has already said something
     stays where it ran, transcript and session and all, so picking a folder for
     one of those starts a new chat there instead of dragging the old one over. */
  const setProject = useCallback((dir) => {
    if (!dir) return;
    const cur = chatsRef.current.find((c) => c.key === activeRef.current);
    if (cur && !cur.session && !cur.items.length) edit(cur.key, (c) => ({ ...c, project: dir }));
    else reset(dir);
  }, [edit, reset]);

  // The folder moved. Main has already stopped every session, and the chats
  // here belong to the folder that was open when they ran.
  const clear = useCallback(() => {
    for (const st of streams.current.values()) if (st.raf) cancelAnimationFrame(st.raf);
    streams.current.clear();
    const next = blankChat(focusedProject.current, providerRef.current, startMode.current);
    setChats([next]);
    activeRef.current = next.key;
    setActiveKey(next.key);
    window.connRail?.refresh();
  }, []);

  // Deleting a chat, from the rail or from anywhere else that has a row. Two
  // halves, and a chat can be either or both: the transcript on disk, which is
  // what the rail lists and what `claude --resume` offers, and the copy in
  // memory with its process behind it. A chat that was never written to disk
  // has no session id and only the second half applies.
  const removeChat = useCallback(async (row) => {
    const key = row.key || null;
    // rows() names a chat with no session by its key, so id and key matching is
    // how a chat that never reached disk says it has nothing to delete there.
    const session = row.id && row.id !== key ? row.id : null;

    if (session) {
      const res = await conn().agent.deleteSession(session, row.project).catch((e) => ({ error: e.message }));
      if (res?.error) return res;
      // An agent that cannot delete a chat from outside itself keeps its part,
      // or the whole chat. The rail keeps it hidden, and the toast says which.
      const note = deleteNote(res || {});
      if (note) toast(note.title, note.description);
    } else if (key) {
      // No transcript to remove, so the process is ours to stop. (With one,
      // main stops it before the unlink.)
      await conn().agent.reset(key).catch(() => {});
    }

    if (key) {
      for (const [k, st] of streams.current) {
        if (!k.startsWith(`${key}\0`)) continue;
        if (st.raf) cancelAnimationFrame(st.raf);
        streams.current.delete(k);
      }

      const all = chatsRef.current;
      const at = all.findIndex((c) => c.key === key);
      const rest = all.filter((c) => c.key !== key);
      // Deleting the last chat leaves the pane on a blank one rather than on
      // nothing at all.
      const next = rest.length ? rest : [blankChat(focusedProject.current, providerRef.current, startMode.current)];
      chatsRef.current = next;
      setChats(next);
      if (activeRef.current === key) {
        // The row that took its place, or the one above it if it was last.
        const land = next[Math.min(at, next.length - 1)];
        activeRef.current = land.key;
        setActiveKey(land.key);
      }
    }

    window.connRail?.refresh();
    return { ok: true };
  }, []);

  /* A switched chat off disk: every session it ran on, read whole and put back
     in order. Read whole because the segments interleave, and a window cut off
     one session would not say where in the others it starts. Each session
     after the first has its row ids prefixed, since every transcript numbers
     its rows from h0. */
  const openSegments = useCallback(async (chat, segs) => {
    try {
      // One agent's transcript gone missing leaves its stretch out rather than
      // the whole chat unopenable. See readThread.
      const thread = await readThread(segs, (session, provider) =>
        conn().agent.transcript(session, chat.project, { limit: WHOLE, provider }));
      const sizes = Object.fromEntries(Object.entries(thread.reads).map(([id, r]) => [id, storedContext(r.t)]));
      // A segment's window size is its session's, as last saved or, failing
      // that, as its transcript last reported.
      const segments = thread.segments.map((x) => (x.context ? x : { ...x, ...(sizes[x.session] && { context: sizes[x.session] }) }));
      const lastSession = segs[segs.length - 1].session;
      const last = thread.reads[lastSession];
      edit(chat.key, (c) => {
        const usage = last?.t.usage ? account(c.usage, last.t.usage) : c.usage;
        return {
          ...c,
          items: thread.items,
          segments,
          stored: null,
          usage: sizes[lastSession] ? { ...usage, context: sizes[lastSession] } : usage,
        };
      });
    } catch (e) {
      edit(chat.key, (c) => ({
        ...c,
        items: [...c.items.filter((it) => it.id !== 'opening'), { id: uid('e'), kind: 'note', error: true, text: `could not open that chat: ${e.message}` }],
      }));
    }
  }, [edit]);

  // Open a stored chat. One already in memory is just brought forward, live
  // turn and all. One off disk is replayed here and resumed on the next
  // message, so clicking through the rail costs nothing.
  const open = useCallback(async (s) => {
    // A row for a chat that is already open here names it by our key: it may
    // have no session id yet, and two new chats would both match on null.
    // Opening a chat moves the window to its folder: the files, the changes and
    // the shells beside it should be the ones that chat is talking about.
    if (s.project && s.project !== focusedProject.current && s.project !== chatsDir.current) {
      conn().project.focus(s.project).catch(() => {});
    }

    const known = chatsRef.current.find((c) => (s.key ? c.key === s.key : headOf(c) === s.id));
    if (known) return switchTo(known.key);

    // A chat that changed agent opens on the one it was last on.
    const segs = s.segments?.length > 1 ? s.segments : null;
    const last = segs?.[segs.length - 1];
    const chat = {
      ...blankChat(s.project || focusedProject.current, last?.provider || s.provider || providerRef.current, startMode.current),
      session: last?.session || s.id,
      // Read again once the transcripts are in; until then the chat is still
      // known by its first session, which is the one the rail and drafts use.
      ...(segs && { segments: segs.map((x) => ({ ...x, from: 0 })) }),
      // A chat from before boards has none on record and keeps the fresh one
      // blankChat minted.
      ...(s.canvas && { canvas: s.canvas }),
      title: s.title.slice(0, TITLE_MAX),
    };
    chatsRef.current = [...chatsRef.current, chat];
    setChats(chatsRef.current);
    switchTo(chat.key);

    push(chat.key, { id: 'opening', kind: 'note', text: 'opening this chat…' });
    if (segs) return openSegments(chat, segs);
    try {
      const t = await conn().agent.transcript(s.id, chat.project);
      const span = storedWindow(t);
      const next = replayStored(t, span.from);
      // How full it was, so a switch away from it records how much room it
      // has for whatever it is handed when it is switched back to.
      const context = storedContext(t);
      edit(chat.key, (c) => {
        const usage = t.usage ? account(c.usage, t.usage) : c.usage;
        return {
          ...c,
          items: next,
          stored: storedOf(s.id, span, next.length),
          usage: context ? { ...usage, context } : usage,
        };
      });
    } catch (e) {
      edit(chat.key, (c) => ({
        ...c,
        items: [...c.items.filter((it) => it.id !== 'opening'), { id: uid('e'), kind: 'note', error: true, text: `could not open that chat: ${e.message}` }],
      }));
    }
  }, [edit, push, switchTo, openSegments]);

  // Reading further back into a chat opened off disk. The wider window is
  // replayed whole, not prepended, so a call and the result the old cut split
  // pair up again.
  const loadEarlier = useCallback(async () => {
    const key = activeRef.current;
    const chat = chatsRef.current.find((c) => c.key === key);
    const at = chat?.stored;
    if (!at || at.loading) return;
    edit(key, (c) => ({ ...c, stored: c.stored && { ...c.stored, loading: true } }));
    try {
      const t = await conn().agent.transcript(at.session, chat.project, { limit: widerLimit(at), end: at.to });
      const span = storedWindow(t, at.to);
      const fresh = replayStored(t, span.from);
      // A rewind while this was reading made the chat a fork, and this window
      // is of the transcript it left.
      edit(key, (c) => widened(c, fresh, span, at.session));
    } catch (e) {
      edit(key, (c) => ({ ...c, stored: c.stored && { ...c.stored, loading: false } }));
      toast(`Could not load earlier messages: ${e.message}`);
    }
  }, [edit]);

  /* Changing how hard the model thinks. The CLI takes this when a session
     starts and has no setter for it, so main parks this chat when idle and the
     next message resumes its transcript at the new level. A chat mid-turn
     keeps the level it started on rather than having the session pulled out
     from under it. */
  const changeEffort = useCallback(async (value) => {
    const key = activeRef.current;
    setEffort(value);
    edit(key, (c) => ({ ...c, effort: value }));
    const res = await conn().agent.setEffort(key, value).catch(() => null);
    if (res && typeof res.effort === 'string') {
      setEffort(res.effort);
      edit(key, (c) => ({ ...c, effort: res.effort }));
    }
  }, [edit]);

  // The long window is a different name for the same model, so this swaps the
  // name and the picker follows.
  const changeLongContext = useCallback(async (on) => {
    const key = activeRef.current;
    setLongContext((cur) => ({ ...cur, on }));
    const res = await conn().agent.setLongContext(key, on).catch(() => null);
    if (res?.error) return setLongContext((cur) => ({ ...cur, on: !on }));
    if (res?.model) {
      // The list comes back with the switched-to name on it. Without that the
      // picker has a value it cannot find and falls back to its placeholder,
      // which reads as nothing being selected at all.
      if (res.models?.length) setModels(res.models);
      setModel(res.model);
      setLongContext({ on: !!res.long, capable: true });
      edit(key, (c) => ({ ...c, usage: { ...c.usage, model: res.model, window: 0 } }));
    }
  }, [edit]);

  /* Forking: the same conversation carried into a new chat on `value`, with
     this one left exactly as it was. The new chat shows what it was forked
     from and its first message carries the handoff, the same way a switch's
     does, so the agent starts on what you ask it rather than on a recap. */
  const forkTo = useCallback(async (value, provider) => {
    let chat = chatsRef.current.find((c) => c.key === activeRef.current);
    if (!chat?.items.length) return;
    if (chat.busy) {
      toast('Wait for this turn to finish before forking it.');
      return;
    }
    // The fork carries the whole chat, not just the end that was read in.
    if (chat.stored) chat = await readWhole(chat.key, chat);
    const want = provider || modelEntry(models, value)?.provider || chat.provider;
    const marker = { id: uid('h'), kind: 'handoff', fork: true, from: labelOf(chat.provider), to: labelOf(want), model: modelName(models, value, want), pending: true };
    const by = chat.segments?.length ? chat.segments : [{ provider: chat.provider, from: 0 }];
    const next = {
      ...blankChat(chat.project, want, chat.mode),
      // The carried transcript names this chat's board folder, so the fork keeps drawing there.
      canvas: chat.canvas,
      // Kept as a name so the first message does not take the row back.
      title: chat.title,
      renamed: true,
      // An agent row opens its transcript from the session it ran in, which
      // is the old chat's, not the fork's.
      items: [
        // Going back to a message rewinds this chat's own session, which has
        // none of the copied ones in it, so they lose the mark that offers it.
        ...chat.items.filter((it) => it.kind !== 'perm' || it.decided).map(({ forkAt, ...it }) => (
          it.kind === 'agent' && !it.session ? { ...it, session: chat.session } : it)),
        marker,
      ],
      handoff: { since: 0, used: 0, from: chat.provider, marker: marker.id, segments: by },
      usage: { ...blankUsage(), model: value },
    };
    chatsRef.current = [...chatsRef.current, next];
    setChats(chatsRef.current);
    switchTo(next.key);
    setModel(value);
    setProvider(want);
    const res = await conn().agent.setModel(next.key, value, want);
    if (res?.models?.length) setModels(res.models);
    if (typeof res?.long === 'boolean') setLongContext({ on: res.long, capable: !!res.longCapable });
  }, [models, switchTo, readWhole]);

  /* Picking a model. The list holds every CLI, and a pick on another one
     moves the chat there in place: the transcript stays, a handoff row marks
     the switch, and the next message carries the turns the new agent missed.
     One that was in this chat before resumes its own session and is handed
     only what happened since it left. A turn still running keeps its CLI. */
  const switchChatTo = useCallback(async (chat, value, want) => {
    if (chat.busy) {
      toast(`Wait for this turn to finish before switching to ${labelOf(want)}.`);
      return;
    }
    const key = chat.key;
    // Until the switch lands, a message typed here queues rather than going to
    // the session being left. See sendTo. Landing is when the switched chat is
    // committed, which the queue's flush checks for; a refused switch has
    // nothing to wait for.
    switching.current.set(key, { landing: false, want });
    let landed = false;
    try {
      // Main parks the session this chat is on before anything here moves, so
      // a refusal leaves nothing to put back.
      const res = await conn().agent.setModel(key, value, want);
      if (res?.busy) {
        toast(`Wait for this turn to finish before switching to ${labelOf(want)}.`);
        return;
      }
      // Something else may have started a turn while main was answering. That
      // turn is on the old CLI, so the chat stays there with it, and so does
      // what its next session will start on, busy or not.
      if (chatsRef.current.find((c) => c.key === key)?.busy) {
        toast(`Wait for this turn to finish before switching to ${labelOf(want)}.`);
        await conn().agent.restoreModel(key, chat.usage?.model || '', chat.provider).catch(() => {});
        return;
      }
      intended.current.set(key, want);
      setModel(res?.model || value);
      setProvider(want);
      const shown = modelName(models, value, want);
      if (res?.models?.length) setModels(res.models);
      if (typeof res?.long === 'boolean') setLongContext({ on: res.long, capable: !!res.longCapable });
      setChats((cur) => {
        const next = cur.map((c) => {
          if (c.key === key) {
            const moved = switchChat(c, { provider: want, model: shown, id: uid('h'), label: labelOf });
            return { ...moved, usage: { ...c.usage, model: value, window: 0, context: 0 } };
          }
          return c.items.length ? c : { ...c, provider: want, usage: { ...c.usage, model: value, window: 0 } };
        });
        chatsRef.current = next;
        return next;
      });
      switching.current.set(key, { landing: true, want });
      landed = true;
    } finally {
      if (!landed) switching.current.delete(key);
      // A message queued while this ran goes once the chat next commits.
      edit(key, (c) => ({ ...c }));
    }
  }, [models, edit]);

  // `provider` is the CLI the model was picked under. Only a caller with
  // nothing but a name, such as one typed by hand, leaves it to the list.
  const pickModel = useCallback(async (key, value, provider) => {
    const chat = chatsRef.current.find((c) => c.key === key);
    const want = provider || modelEntry(models, value)?.provider;
    // An earlier pick may still be on its way into state.
    const on = intended.current.get(key) || chat?.provider;
    const crossing = want && on && want !== on;

    if (crossing && chat.items.length) return switchChatTo(chat, value, want);

    if (want) intended.current.set(key, want);
    setModel(value);
    if (want) setProvider(want);
    const followsPicker = (c) => c.key === key || !c.items.length;
    setChats((cur) => {
      const next = cur.map((c) => (followsPicker(c)
        ? { ...c, ...(want ? { provider: want } : {}), usage: { ...c.usage, model: value, window: 0 } }
        : c));
      chatsRef.current = next;
      return next;
    });
    // A name typed by hand comes back as part of the list, so the picker has it
    // the next time it opens rather than only while it is selected.
    const res = await conn().agent.setModel(key, value, want);
    if (res?.busy) {
      if (res.model) setModel(res.model);
      if (res.provider) {
        setProvider(res.provider);
        intended.current.set(key, res.provider);
      }
      setChats((cur) => {
        const next = cur.map((c) => (c.key === key
          ? { ...c, provider: res.provider || chat?.provider || c.provider, usage: { ...c.usage, model: res.model || c.usage.model } }
          : c));
        chatsRef.current = next;
        return next;
      });
      return;
    }
    if (res?.model) setModel(res.model);
    if (res?.models?.length) setModels(res.models);
    if (res?.provider) setProvider(res.provider);
    if (typeof res?.long === 'boolean') setLongContext({ on: res.long, capable: !!res.longCapable });
  }, [models, switchChatTo]);

  // One chat's picks run in the order they were made.
  const changeModel = useCallback((value, provider) => {
    const key = activeRef.current;
    return serial.current(key, () => pickModel(key, value, provider));
  }, [pickModel]);

  // Drops a hand-typed name. The main process answers with what is left and
  // which of those the picker should land on.
  const forgetModel = useCallback(async (value) => {
    const res = await conn().agent.forgetModel?.(value);
    if (!res) return;
    if (res.models?.length) setModels(res.models);
    if (res.model) {
      setModel(res.model);
      setChats((cur) => cur.map((c) => (c.key === activeRef.current
        ? { ...c, usage: { ...c.usage, model: res.model, window: 0 } }
        : c)));
    }
  }, []);

  /* Switching CLI. The model has to move with it or the picker keeps showing
     the last one's name over the new one's list, and the first message would go
     out asking codex for a claude model. Main answers with both. */
  const changeProvider = useCallback(async (value) => {
    const key = activeRef.current;
    const res = await conn().agent.setProvider?.(key, value);
    if (!res) return;
    setProvider(res.provider);
    setModels(res.models || []);
    setModel(res.current || '');
    setChats((cur) => cur.map((c) => (c.key === key
      ? { ...c, provider: res.provider, usage: { ...c.usage, model: res.current || '', window: 0 } }
      : c)));
  }, []);

  // A CLI installed or logged into after Conn started. The new state
  // arrives through the same 'agent:driver' push a normal refresh sends.
  // force is the button, a full re-probe; the quiet call a page's own mount
  // makes only re-probes a driver whose binary actually moved.
  const recheck = useCallback(async (force = false) => {
    setChecking(true);
    try { await conn().agent.recheck?.(force); } finally { setChecking(false); }
  }, []);

  const changeMode = useCallback(async (value) => {
    const key = activeRef.current;
    edit(key, (c) => ({ ...c, mode: value }));
    await conn().agent.mode(key, value);
  }, [edit]);

  // The rail's rename. The row changes straight away; the file is what makes
  // it survive the next history read, which would otherwise put the first
  // message back. A chat with no session yet keeps the name in memory, and
  // onReady writes it down once there is one.
  const renameChat = useCallback(async (key, title) => {
    const next = String(title || '').trim().slice(0, RENAME_MAX);
    if (!next) return { error: 'Give the chat a name.' };
    const chat = chatsRef.current.find((c) => c.key === key);
    // A switched chat's name belongs to its first session, the one the rail
    // shows it under.
    const head = headOf(chat);
    if (head) written.current.titles.set(key, `${head}\0${next}`);
    edit(key, (c) => ({ ...c, title: next, renamed: true }));
    if (!head) return { ok: true };
    const res = await conn().agent.rename(head, next).catch((e) => ({ error: e.message }));
    if (res?.error) edit(key, (c) => ({ ...c, title: chat.title, renamed: !!chat.renamed }));
    else window.connRail?.refresh();
    return res || {};
  }, [edit]);

  return {
    items: tree,
    running,
    busy: active.busy,
    startedAt: active.startedAt || 0,
    session: active.session,
    // A switched chat's first session and its run of sessions, which export
    // reads whole.
    head: headOf(active),
    segments: active.segments || [],
    // The folder the chat on screen runs in, which is not always the focused
    // one: you can read a chat in another project without moving the window.
    project: active.project || null,
    canvas: active.canvas,
    folderless: !!active.project && active.project === chatsDir.current,
    title: active.title,
    mode: active.mode,
    queued: active.queued,
    // How many stored messages come before the ones replayed, still on disk.
    earlier: active.stored?.from || 0,
    loadingEarlier: !!active.stored?.loading,
    usage,
    models, model, driver, provider, providers, effort, efforts, longContext,
    chats, activeKey, checking,
    send, redo, retryTurn, editsSince, undoEdits, enqueue, unqueue, editQueued, sendNow, sendNext,
    decide, interrupt, reset, setProject, clear, open, removeChat, renameChat, switchTo, changeModel, forkTo, forgetModel,
    changeProvider, changeMode, recheck,
    changeEffort, changeLongContext,
    stopAgent, backgroundAgent, openAgent, peekAgent, loadEarlier,
  };
}
