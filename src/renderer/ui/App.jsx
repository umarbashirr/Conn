import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useStickToBottomContext } from 'use-stick-to-bottom';
import { ArrowUpCircleIcon, PencilIcon, RotateCcwIcon, SquareIcon, Undo2Icon } from 'lucide-react';

import { Conversation, ConversationContent } from '@/components/ai-elements/conversation';
import { Message, MessageAction, MessageActions, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import { DiffView, FileDiffs } from '@/components/diff-view';
import { InputFold, PermMark, ToolOutput, ToolRow, ToolStrip, Pre } from '@/components/tool-row';
import { AgentRow } from '@/components/agent-row';
import { ReasoningRow } from '@/components/reasoning-row';
import { FleetStrip } from '@/components/fleet-strip';
import { SubagentSheet } from '@/components/subagent-sheet';
import { ChatFloor } from '@/components/working-panel';
import { Shimmer } from '@/components/ai-elements/shimmer';
import { Composer } from '@/components/composer';
import { QuestionCard } from '@/components/question-card';
import { CustomizePage } from '@/components/customize-page';
import { ForkDialog } from '@/components/fork-dialog';
import { ReleaseNotesText, PROVIDERS } from '@/components/settings-panel';
import { UsagePage } from '@/components/usage-page';
import { TokenInput } from '@/components/token-input';
import { TokenText } from '@/components/token-text';
import { TurnEdits } from '@/components/turn-edits';
import { fileCount, UndoEditsDialog, undoneCaption, useEditsOffer } from '@/components/undo-edits';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';

import { clock, useTick } from '@/lib/clock';
import { useDictation } from '@/lib/dictation';
import { editHunks, hunkStats } from '@/lib/diff';
import { dropDraft, ownedStorageKey, readDraft, storageKeyOfRow, writeDraft } from '@/lib/drafts';
import { inTerminal, matches } from '@/lib/keys';
import { FOLD_AT_CALLS, runs } from '@/lib/runs';
import { isLive, subagentsIn } from '@/lib/subagents';
import { imageSrc, toolImages, toolLabel, toolName, toolRecording, toolSummary, toolText } from '@/lib/tools';
import { attachPerms, turnEdits } from '@/lib/turns';

import { useAgent } from './useAgent';
import { useCatalog } from './useCatalog';
import { useSettings, useUpdates } from './useSettings';
import { enterFullPage, leaveFullPage, runCommand, toast } from '../app.js';
import { closeSheet, getSheet, openSheet, publish, subscribeAgents, toggleSheetFull } from './shell/agents-store.js';
import { canvasState, onSelection, select, setBoard } from './shell/canvas-store.js';
import { nextSlot, selectionBrief } from './shell/canvas-schema.js';
import { MENTIONS, mentionBlocks } from './lib/conn-mentions.js';
import { mentionsIn } from './lib/tokens.js';

// Everything clipped to a message becomes a preamble above what was typed. An
// element picked out of the preview is described in full; a picture travels as
// real image bytes and only needs naming here; any other file is named by its
// path, because the agent can open it itself and a pasted-in log is a waste of
// the context window.
// What the person wrote against the attachment, folded onto one line. A block
// is a head line and its indented continuations, so a note with a newline in it
// would end the block early and leave the rest as loose prose.
const noteLine = (a) => (a.note ? `  note: ${String(a.note).replace(/\s+/g, ' ').trim()}` : null);

// Frames picked on the board are a $canvas mention nobody had to type.
function mentionNames(list, body) {
  const names = mentionsIn(body);
  if (list.some((a) => a.kind === 'frames')) names.add('canvas');
  return names;
}

function attachmentText(list, body, names, { provider, canvas }) {
  const lines = [];

  for (const a of list) {
    if (a.kind === 'element') {
      const { hit, shotPath } = a;
      lines.push([
        '[preview element]',
        `  css: ${hit.css}`,
        `  element: ${hit.role === 'generic' ? hit.tag : hit.role} ${JSON.stringify(hit.name || hit.text || '')}`,
        `  ref: ${hit.ref}   size: ${hit.rect.w}x${hit.rect.h} at ${hit.rect.x},${hit.rect.y}`,
        shotPath ? `  screenshot: ${shotPath}` : null,
        noteLine(a),
      ].filter(Boolean).join('\n'));
    } else if (a.kind === 'image') {
      lines.push([
        `[attached image] ${a.name}`,
        a.path ? `  file: ${a.path}` : null,
        noteLine(a),
      ].filter(Boolean).join('\n'));
    } else if (a.kind === 'file') {
      lines.push([
        `[attached file] ${a.name}`,
        `  path: ${a.path}`,
        noteLine(a),
        '  Read it before answering.',
      ].filter(Boolean).join('\n'));
    } else if (a.kind === 'frames') {
      lines.push(selectionBrief(a.frames, canvas));
    }
  }
  lines.push(...mentionBlocks(names, body, { provider, canvas, slot: nextSlot(canvasState.board) }));

  return lines.length ? lines.join('\n\n') + '\n\n' : '';
}

const EMPTY_DRAFT = { text: '', attachments: [] };
const restoredDraft = (storageKey) => ({ ...EMPTY_DRAFT, text: readDraft(storageKey) });

// Between a message going out and the first row coming back, and again between
// one tool finishing and the next starting, the transcript holds still. A held
// transcript and a hung agent look identical, so a shimmering "Thinking" fills
// those gaps. It is only up when nothing else on screen is already moving:
// streaming text, a tool mid-call and a subagent still running in the
// foreground all say the same thing on their own, and a question is waiting on
// the human, not the model. A backgrounded subagent is the exception, its
// shimmer is about its own work and the main turn is off waiting on something
// else, so the gap here still needs filling.
function stalled(items) {
  const last = items[items.length - 1];
  if (!last) return true;
  if (last.kind === 'assistant' || last.kind === 'reasoning') return !last.streaming;
  if (last.kind === 'tool') return last.state !== 'input-available' && last.state !== 'input-streaming';
  if (last.kind === 'agent') return last.status !== 'running' || !!last.background;
  if (last.kind === 'perm') return !!last.decided;
  return true;
}

// When `on` has been true for a whole `ms`, the moment it went true. Zero the
// rest of the time. The gap between one tool finishing and the next starting
// is usually a couple of hundred milliseconds of wire, and a line that flashes
// up in every one of those gaps is worse than no line: it turns a turn that is
// going fine into a strobe.
function useSettled(on, ms) {
  const [at, setAt] = useState(0);
  useEffect(() => {
    if (!on) {
      setAt(0);
      return undefined;
    }
    const began = Date.now();
    const t = setTimeout(() => setAt(began), ms);
    return () => clearTimeout(t);
  }, [on, ms]);
  return at;
}

// The word on its own was the whole answer for a while, and it is not enough.
// A shimmer sweeps at the same rate after ninety seconds as after two, so a
// long tool call and a dead socket look identical, and the person sits there
// deciding whether to reload. A number that goes up cannot be faked by a stuck
// render. It waits a couple of seconds first, because a clock reading 0:00 on
// a wait nobody had noticed yet only invents the worry.
function ThinkingLine({ since }) {
  useTick(true);
  const held = Date.now() - since;

  return (
    <div className="conn-in flex h-7 items-center gap-1.5 px-1.5">
      {/* Same two columns the tool rows spend on the chevron and the icon,
          so "Thinking" starts where "Edit" does instead of hanging off the
          left of the list. */}
      <span className="w-3 shrink-0" />
      <span className="w-3.5 shrink-0" />
      <Shimmer className="text-[13px]">Thinking</Shimmer>
      {held >= 2500 && (
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground/70">{clock(held)}</span>
      )}
    </div>
  );
}

// The turn's own clock, up in the header beside the chat's name. Deliberately
// not a second shimmer: two things pulsing at once read as two separate states
// and the reader goes looking for the difference. A dot and a number, and the
// number is the point. This one runs the whole turn, including the stretches
// where a tool row or a subagent is already saying its own piece, so there is
// never a moment with nothing on screen moving.
function TurnClock({ since }) {
  useTick(true);

  return (
    <span className="conn-in ml-3 flex items-center gap-1.5 text-muted-foreground text-xs">
      <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
      working
      {since > 0 && <span className="font-mono tabular-nums">{clock(Date.now() - since)}</span>}
    </span>
  );
}

// Shown at most once per launch for a given installed version. `open` is
// computed by the caller from state lifted to App itself: the Updates page
// and the chat both mount and unmount this component as navigation toggles
// between them, so state kept here would forget a dismissal on every trip
// back to the chat. "Later" leaves `restart.ready` alone, so the dot on the
// Updates nav item (updatesBehind, in settings-panel.jsx) and the row in the
// Updates page keep the offer around for whenever the person gets to it.
function RestartDialog({ updates, busy, open, onDismiss }) {
  const { restart } = updates;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onDismiss(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Conn {restart.installed} is installed</DialogTitle>
          <DialogDescription>
            Restart to use it.
            {busy && ' An agent turn is running in a chat. Restarting stops it, the same as quitting would.'}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onDismiss}>Later</Button>
          <Button onClick={updates.relaunch}>Restart now</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// The first launch on a new version, once. The version is recorded as seen
// only when this is closed, so a launch that quits before anyone reads it asks
// again next time.
function WhatsNewDialog({ release, onDismiss }) {
  return (
    <Dialog open={!!release} onOpenChange={(next) => { if (!next) onDismiss(); }}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>What's new in Conn {release?.version}</DialogTitle>
          <DialogDescription>
            {release?.publishedAt
              ? `You are now on ${release.version}, released ${new Date(release.publishedAt).toLocaleDateString()}.`
              : `You are now on ${release?.version}.`}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto text-sm">
          <ReleaseNotesText notes={release?.notes} />
        </div>
        <DialogFooter>
          <Button onClick={onDismiss}>Got it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const PERM_KEYS = { y: 'allow', a: 'always', n: 'deny' };

// A card may take focus from nowhere, the transcript or an empty message box,
// never from a draft, a terminal or a dialog.
function focusIsIdle() {
  const el = document.activeElement;
  if (!el || el === document.body) return true;
  if (el.closest('[role="log"]')) return true;
  return el.matches('#agent-root [contenteditable="true"]') && !el.textContent.trim();
}

const allowButton = (id) => document.querySelector(`[data-perm-allow="${CSS.escape(id)}"]`);

const permAnnouncement = (item) =>
  item.tool === 'AskUserQuestion' ? 'Question from the agent' : `Permission needed: ${toolName(toolLabel(item.tool))}`;

const permTitleId = (id) => `perm-title-${id}`;

export default function App() {
  const agent = useAgent();
  // The Agents tab draws from this chat's state but mounts in the right column.
  useEffect(() => publish(agent));
  // The Canvas shows the chat on screen's board, in the folder that chat runs in.
  useEffect(() => { setBoard(agent.project, agent.canvas); }, [agent.project, agent.canvas]);
  const sheet = useSyncExternalStore(subscribeAgents, getSheet, getSheet);
  const subagents = useMemo(() => subagentsIn(agent.items), [agent.items]);
  const working = useMemo(() => subagents.filter(isLive), [subagents]);
  const sheetItem = sheet ? subagents.find((a) => a.id === sheet.id) || null : null;
  const catalog = useCatalog();
  const { settings, set, reset } = useSettings();
  const updates = useUpdates();
  const [restartDismissedFor, setRestartDismissedFor] = useState(null);
  const dismissRestart = useCallback(
    () => setRestartDismissedFor(updates.restart.installed),
    [updates.restart.installed],
  );
  const restartOpen = !!(updates.restart.ready && updates.restart.installed !== restartDismissedFor);
  const [whatsNew, setWhatsNew] = useState(null);
  useEffect(() => { window.conn.updates.whatsNew().then(setWhatsNew).catch(() => {}); }, []);
  const dismissWhatsNew = useCallback(() => {
    set({ notices: { whatsNew: whatsNew.version } });
    setWhatsNew(null);
  }, [whatsNew, set]);
  // The Customize page, in the chat's place. null when the chat is showing;
  // otherwise the section on screen, so Help → Check for updates lands on
  // updates and the skills chip lands on skills.
  const [customizeAt, setCustomizeAt] = useState(null);
  const customize = useCallback((at) => {
    enterFullPage();
    setCustomizeAt(at);
  }, []);
  const closeCustomize = useCallback(() => {
    leaveFullPage();
    setCustomizeAt(null);
  }, []);
  const [usageOpen, setUsageOpen] = useState(false);
  const openUsage = useCallback(() => setUsageOpen(true), []);
  const closeUsage = useCallback(() => setUsageOpen(false), []);
  // Picking a chat, from the rail or the palette, means you want to read it, so
  // whichever full page is up gives the window back.
  const showChat = useCallback(() => {
    leaveFullPage();
    setUsageOpen(false);
    setCustomizeAt(null);
  }, []);
  // A half-typed message belongs to the chat it was typed in, so drafts are
  // kept per chat rather than following you around the rail.
  const [drafts, setDrafts] = useState({});
  const key = agent.activeKey;
  const chatsRef = useRef(agent.chats);
  chatsRef.current = agent.chats;
  const activeChat = agent.chats.find((c) => c.key === key);
  const storageKey = activeChat ? ownedStorageKey(agent.chats, activeChat) : null;
  const draft = drafts[key] || restoredDraft(storageKey);
  const text = draft.text;
  const attachments = draft.attachments;
  useEffect(() => writeDraft(storageKey, text), [storageKey, text]);

  // The bridge below hands these to the vanilla half once and never rebinds,
  // so they read the chat that is open now rather than the one that was open
  // when the bridge was installed. Keyed off a ref for that reason.
  const keyRef = useRef(key);
  keyRef.current = key;
  const storageKeyRef = useRef(storageKey);
  storageKeyRef.current = storageKey;

  // Held here rather than in the composer because the dictation chord works
  // from anywhere in the window, and its words go through this box.
  const input = useRef(null);
  const dictation = useDictation({ input, chat: key, command: settings?.dictation?.command });

  const editDraft = useCallback((field, next) => {
    const k = keyRef.current;
    setDrafts((all) => {
      const cur = all[k] || restoredDraft(storageKeyRef.current);
      return { ...all, [k]: { ...cur, [field]: typeof next === 'function' ? next(cur[field]) : next } };
    });
  }, []);
  const setText = useCallback((next) => editDraft('text', next), [editDraft]);
  const setAttachments = useCallback((next) => editDraft('attachments', next), [editDraft]);
  const setNote = useCallback(
    (id, note) => setAttachments((list) => list.map((a) => (a.id === id ? { ...a, note } : a))),
    [setAttachments],
  );

  // The frames selected on the canvas ride along as one chip, so "make this
  // darker" reaches the agent with the files it means.
  useEffect(() => onSelection((frames) => setAttachments((list) => {
    const rest = list.filter((a) => a.kind !== 'frames');
    if (!frames.length) return rest;
    return [...rest, { id: 'frames', kind: 'frames', frames: frames.map((f) => ({ file: f.file, name: f.name })) }];
  })), [setAttachments]);

  // Bridge to the vanilla half: the picker pushes here, the preview's error
  // card sends straight through.
  useEffect(() => {
    // The note was written in the page, on a bar anchored to the element, so it
    // arrives with the hit rather than being asked for once it gets here.
    window.addAttachment = (hit, shotPath) =>
      setAttachments((a) => [
        ...a,
        { id: `el${Date.now()}`, kind: 'element', hit, shotPath, note: hit.note || '' },
      ]);
    window.sendToAgent = (t) => agent.send(t);
    window.connChat = {
      open: (chat) => { showChat(); return agent.open(chat); },
      newChat: (dir) => { showChat(); return agent.reset(dir); },
      // The folder changed under us, so every chat here goes with it.
      clearChats: agent.clear,
      // Deleting one, transcript and all. The draft goes with it: half a
      // message typed into a chat that no longer exists is nobody's to keep.
      remove: async (chat) => {
        const stored = storageKeyOfRow(chatsRef.current, chat);
        const res = await agent.removeChat(chat);
        if (chat.key) setDrafts(({ [chat.key]: _gone, ...rest }) => rest);
        if (!res?.error) dropDraft(stored);
        return res;
      },
      rename: (chat, title) => {
        if (chat?.key) return agent.renameChat(chat.key, title);
        if (!chat?.id) return { error: 'That chat has not been saved yet.' };
        return window.conn.agent.rename(chat.id, title)
          .then((res) => { if (!res?.error) window.connRail?.refresh(); return res; })
          .catch((e) => ({ error: e.message }));
      },
      settings: (at) => customize(typeof at === 'string' ? at : 'appearance'),
      customize: (at) => customize(typeof at === 'string' ? at : 'mcp'),
      usage: openUsage,
      dictate: dictation.toggle,
      jumpPermission: () => {
        const oldest = document.querySelector('[data-perm-card]');
        (oldest?.querySelector('[data-perm-allow]') || oldest?.querySelector('button, input, [tabindex]'))?.focus();
      },
      // A shortcut for typing $canvas, and the canvas opens to show what comes back.
      design: () => {
        setText((t) => (mentionsIn(t).has('canvas') ? t : `${t}${t && !/\s$/.test(t) ? ' ' : ''}$canvas `));
        runCommand('canvas', true);
        runCommand('focusComposer');
      },
      // Removing the chip lets go of the frames on the board as well.
      deselectFrames: () => select([]),
    };
    return () => { window.addAttachment = null; window.sendToAgent = null; window.connChat = null; };
  }, [agent.send, agent.open, agent.reset, agent.clear, agent.removeChat, agent.renameChat, customize, openUsage, showChat, dictation.toggle]);

  // Escape also stops the turn when focus is nowhere or in the transcript.
  // Customize hides the chat, and its own Escape only runs with focus inside
  // it, so a turn nobody can see is left alone.
  useEffect(() => {
    if (!agent.busy || customizeAt !== null) return undefined;
    const onKey = (e) => {
      const t = e.target;
      if (e.defaultPrevented || !matches(e, 'stopTurn') || inTerminal(t)) return;
      const idle = !(t instanceof Element) || t === document.body || t === document.documentElement
        || (!!t.closest('[role="log"]') && !t.closest('input, textarea, [contenteditable="true"]'));
      if (!idle) return;
      e.preventDefault();
      agent.interrupt();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [agent.busy, agent.interrupt, customizeAt]);

  // A card that arrives in the chat on screen is announced, and takes focus
  // when focus is idle. An answered card passes focus to the next one, then to
  // the composer.
  const waiting = useMemo(() => agent.items.filter((it) => it.kind === 'perm' && !it.decided), [agent.items]);
  const cards = useMemo(() => waiting.filter((it) => it.tool !== 'AskUserQuestion').map((it) => it.id), [waiting]);
  const waitingKey = waiting.map((it) => it.id).join('\n');
  const seenCards = useRef({ chat: null, ids: [], waiting: [] });
  const cardFocus = useRef(null);
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    const track = (e) => { cardFocus.current = e.target.closest?.('[data-perm-card]')?.dataset.permCard ?? null; };
    document.addEventListener('focusin', track);
    return () => document.removeEventListener('focusin', track);
  }, []);
  useEffect(() => {
    const prev = seenCards.current;
    seenCards.current = { chat: agent.activeKey, ids: cards, waiting: waiting.map((it) => it.id) };
    const switchedChat = prev.chat !== agent.activeKey;
    const arrived = switchedChat ? undefined : waiting.findLast((it) => !prev.waiting.includes(it.id));
    const next = arrived ? permAnnouncement(arrived) : '';
    // A live region speaks only when its text changes, so a second card for the
    // same tool flips a trailing no-break space to be heard at all.
    setAnnouncement((said) => (next && said === next ? `${next} ` : next));
    if (switchedChat) return;
    const answered = prev.ids.includes(cardFocus.current) && !cards.includes(cardFocus.current);
    if (answered && (!document.activeElement || document.activeElement === document.body)) {
      cardFocus.current = null;
      if (cards.length) allowButton(cards[0])?.focus();
      else runCommand('focusComposer');
    } else if (cards.some((id) => !prev.ids.includes(id)) && focusIsIdle()) {
      allowButton(cards[0])?.focus();
    }
  }, [agent.activeKey, waitingKey]);

  // A release that landed while the window was open, said where the person
  // already is. Update starts the download; Install is a second toast once the
  // file is here. An agent update runs in a terminal, which is the same command
  // the settings page would have run. Later is the only button that stops the
  // news coming back for this version.
  const AGENTS = ['claude', 'codex', 'cursor', 'grok', 'opencode'];
  useEffect(() => {
    if (settings?.startup.checkUpdates) updates.check();
  }, [settings?.startup.checkUpdates, updates.check]);

  useEffect(() => {
    if (!settings?.startup.checkUpdates) return;
    const told = settings.notices || {};
    const { app } = updates;
    const fetching = updates.progress && !updates.progress.done;

    if (app.behind && told.app !== app.latest && !updates.file && !fetching) {
      const canFetch = updates.kind !== 'dev' && app.asset;
      toast(`Conn ${app.latest} is out`, `You are on ${app.current}.`, [
        ...(canFetch ? [{
          label: 'Update',
          primary: true,
          run: async () => {
            const path = await updates.download();
            if (!path) toast('Could not update Conn', 'The download did not finish.', [{ label: 'OK', primary: true }]);
          },
        }] : []),
        { label: 'Later', run: () => set({ notices: { app: app.latest } }) },
      ], { id: `update-app-${app.latest}`, duration: Infinity });
    }

    for (const id of AGENTS) {
      const cli = updates[id];
      const command = PROVIDERS[id]?.update;
      if (!cli?.behind || !command || told[id] === cli.latest) continue;
      toast(`${PROVIDERS[id].label} ${cli.latest} is out`, `You are running ${cli.running?.version}.`, [
        {
          label: 'Update',
          primary: true,
          run: () => {
            runCommand('runInTerminal', command);
            set({ notices: { [id]: cli.latest } });
          },
        },
        { label: 'Later', run: () => set({ notices: { [id]: cli.latest } }) },
      ], { id: `update-${id}-${cli.latest}`, duration: Infinity });
    }
  }, [
    updates.app.behind, updates.app.latest, updates.app.current, updates.app.asset,
    updates.kind, updates.file, updates.progress,
    updates.claude, updates.codex, updates.cursor, updates.grok, updates.opencode,
    updates.download, updates.check,
    settings?.startup.checkUpdates, settings?.notices,
    set,
  ]);

  useEffect(() => {
    if (!updates.file || updates.installing || updates.installed) return;
    const name = updates.app.latest ? `Conn ${updates.app.latest}` : 'Conn';
    toast(`${name} is downloaded`, 'Ready to install.', [
      {
        label: 'Install',
        primary: true,
        run: async () => {
          const res = await updates.install();
          if (res?.error) toast('Could not install Conn', res.error, [{ label: 'OK', primary: true }]);
        },
      },
    ], { id: `install-app-${updates.app.latest || 'conn'}`, duration: Infinity });
  }, [updates.file, updates.installing, updates.installed, updates.app.latest, updates.install]);

  useEffect(() => {
    if (!updates.restart?.ready) return;
    toast(`Conn ${updates.restart.installed} is installed`, 'Restart to use it.', [
      { label: 'Restart', primary: true, run: () => updates.relaunch() },
    ], { id: 'restart-conn', duration: Infinity });
  }, [updates.restart?.ready, updates.restart?.installed, updates.relaunch]);

  // Enter while the agent is working parks the message. It goes out on its
  // own after this turn finishes, and the one behind it waits for that
  // follow-up to finish too. Enter on an empty box sends the one at the front
  // now, stopping the turn for it.
  const submit = useCallback((_message, e) => {
    e?.preventDefault?.();
    const body = text.trim();
    // An attachment with nothing typed is still a message: a screenshot and a
    // note say plenty. An empty box with nothing clipped to it is nothing to send.
    if (!body && !attachments.length) {
      agent.sendNow();
      return;
    }
    const names = mentionNames(attachments, body);
    const full = attachmentText(attachments, body, names, agent) + body;
    const images = attachments.filter((a) => a.kind === 'image');
    if (agent.busy) agent.enqueue(full, images);
    else agent.send(full, images);
    // The part the message is about goes on screen, so the person watches the work land.
    for (const name of names) runCommand(MENTIONS[name].pane, true);
    setText('');
    // The frames stay selected on the board, so the next message is about them too.
    setAttachments((a) => a.filter((x) => x.kind === 'frames'));
  }, [text, attachments, agent, setAttachments]);

  const empty = agent.items.length === 0;
  // A gap the transcript is not already explaining, once it has lasted long
  // enough to be a gap rather than the wire.
  const thinkingSince = useSettled(agent.busy && stalled(agent.items), 400);
  // Any chat, not just the one on screen: a turn running in a background chat
  // is just as real a reason to think before restarting.
  const anyTurnRunning = agent.chats.some((c) => c.busy);

  if (customizeAt !== null) {
    return (
      <>
        <RestartDialog updates={updates} busy={anyTurnRunning} open={restartOpen} onDismiss={dismissRestart} />
        <ForkDialog fork={agent.fork} onAnswer={agent.answerFork} />
        <WhatsNewDialog release={whatsNew} onDismiss={dismissWhatsNew} />
        <UsagePage providers={agent.providers} open={usageOpen} onClose={closeUsage} />
        <CustomizePage
          section={customizeAt}
          onSection={setCustomizeAt}
          onClose={closeCustomize}
          catalog={catalog}
          settings={settings}
          set={set}
          reset={reset}
          agent={agent}
          updates={updates} />
      </>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <RestartDialog updates={updates} busy={anyTurnRunning} open={restartOpen} onDismiss={dismissRestart} />
      <ForkDialog fork={agent.fork} onAnswer={agent.answerFork} />
      <WhatsNewDialog release={whatsNew} onDismiss={dismissWhatsNew} />
      <UsagePage providers={agent.providers} open={usageOpen} onClose={closeUsage} />
      <div className="flex h-[38px] flex-none items-center border-b border-border/60 px-4 text-sm text-foreground/90">
        <span className="truncate">{agent.title}</span>
        {agent.busy && <TurnClock since={agent.startedAt} />}
        {/* Stays for as long as there is a newer Conn, so a toast waved away
            or never seen is not the only place the news was. */}
        {updates.app.behind && (
          <Button
            size="xs"
            className="ml-auto shrink-0 rounded-full"
            title={`You are on ${updates.app.current}`}
            onClick={() => customize('updates')}>
            <ArrowUpCircleIcon />
            Update to {updates.app.latest}
          </Button>
        )}
      </div>

      <Conversation className={empty ? 'mt-auto flex-none' : 'min-h-0 flex-1'}>
        <ConversationContent className="mx-auto w-full max-w-3xl gap-1.5">
          {empty ? (
            <h1 className="py-6 text-center font-medium text-2xl tracking-tight">
              {agent.folderless ? 'What is on your mind?' : 'What should change?'}
            </h1>
          ) : (
            <Transcript key={agent.activeKey} items={agent.items} agent={agent} />
          )}
          {thinkingSince > 0 && <ThinkingLine since={thinkingSince} />}
        </ConversationContent>
        {!empty && (
          <ChatFloor
            agents={working}
            onOpen={(a) => openSheet(a.id)}
            onStopAll={() => working.filter((a) => a.taskId).forEach(agent.stopAgent)} />
        )}
        {sheetItem && (
          <SubagentSheet
            key={sheetItem.id}
            item={sheetItem}
            agent={agent}
            Items={Items}
            full={sheet.full}
            onToggleFull={toggleSheetFull}
            onClose={closeSheet} />
        )}
      </Conversation>

      <FleetStrip
        shells={agent.running.filter((a) => a.kind !== 'agent')}
        onShow={(a) => document.getElementById(`row-${a.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })} />

      <Composer
        agent={agent}
        settings={settings}
        catalog={catalog}
        text={text}
        setText={setText}
        attachments={attachments}
        setAttachments={setAttachments}
        onNote={setNote}
        onSubmit={submit}
        inputRef={input}
        dictation={dictation} />

      {/* Balances the conversation's mt-auto so an empty chat sits centred. */}
      {empty && <div className="mb-auto flex-none" />}

      <div className="sr-only" aria-live="assertive" aria-atomic="true" data-perm-announcer>{announcement}</div>
    </div>
  );
}

// A row landing, seen landing. Without this the transcript grows by jumping,
// and a jump is what the window does when it redraws, not what an agent does
// when it finishes a thought. The wrapper is keyed on the item, so a row that
// merely changes underneath it — a tool filling in its output, a diff arriving
// a beat after its row — sits still instead of replaying.
const Row = ({ children }) => <div className="conn-in">{children}</div>;

const TAIL = 30;

function Transcript({ items, agent }) {
  const total = runs(attachPerms(items).rest).length;
  const [pinnedStart, setPinnedStart] = useState(null);
  const start = pinnedStart ?? Math.max(0, total - TAIL);
  useEffect(() => { if (pinnedStart === null && total) setPinnedStart(start); }, [pinnedStart, total, start]);

  const { scrollRef } = useStickToBottomContext();
  const fromBottom = useRef(null);
  const earlier = () => {
    const el = scrollRef.current;
    fromBottom.current = el ? el.scrollHeight - el.scrollTop : null;
    setPinnedStart(Math.max(0, start - TAIL));
  };
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && fromBottom.current !== null) el.scrollTop = el.scrollHeight - fromBottom.current;
    fromBottom.current = null;
  }, [start, scrollRef]);

  return (
    <>
      {start > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className="self-center text-muted-foreground"
          onClick={earlier}>
          Show {Math.min(start, TAIL)} earlier
        </Button>
      )}
      <Items items={items} agent={agent} from={start} />
    </>
  );
}

export function Items({ items, agent, from = 0 }) {
  const { marks, rest } = useMemo(() => attachPerms(items), [items]);
  const turns = useMemo(() => turnEdits(rest), [rest]);
  const finished = (i) => i < turns.length - 1 || !agent.busy;
  const footers = new Map(turns.flatMap((t, i) => (t.files.length && finished(i) ? [[t.end, t]] : [])));
  return runs(rest).slice(from).flatMap((g) => {
    const last = g.run ? g.run[g.run.length - 1] : g.item;
    const turn = footers.get(last.id);
    const footer = turn && <TurnEdits turn={turn} transcript={rest} />;
    if (!g.run || g.calls < FOLD_AT_CALLS) {
      // Every row is a keyed Fragment, footer or not: if a footer arriving
      // changed the element type here, React would remount the row and replay
      // its conn-in animation.
      return (g.run || [g.item]).map((it) => (
        <Fragment key={it.id}>
          <Row><Item item={it} agent={agent} mark={marks.get(it.id)} /></Row>
          {it === last && footer}
        </Fragment>
      ));
    }
    // The last one is the live one while the turn runs, and the one that just
    // finished once it stops. Either way it is the one worth reading.
    const done = g.run.slice(0, -1);
    const current = g.run[g.run.length - 1];
    return (
      <Fragment key={g.id}>
        <div className="flex flex-col gap-px">
          <ToolStrip items={done.filter((it) => it.kind === 'tool')}>
            {done.map((it) => <Item key={it.id} item={it} agent={agent} mark={marks.get(it.id)} />)}
          </ToolStrip>
          {/* Keyed, so the row the run is currently on is a new element each
              time the run moves on. Without the key React reconciles the next
              tool call into the last one's markup and the reader inherits
              whatever they had opened on the call before. */}
          <Row key={current.id}><Item item={current} agent={agent} mark={marks.get(current.id)} /></Row>
        </div>
        {footer}
      </Fragment>
    );
  });
}

const RESENT = { retry: 'Sent again as a new message', edit: 'Edited and sent again as a new message' };

// The actions sit beside the bubble rather than under it, so having them makes
// no row taller.
function UserRow({ item, agent }) {
  const [draft, setDraft] = useState(null);
  const input = useRef(null);
  const editing = draft !== null;
  const images = item.images || [];
  const [shownOffer, setShownOffer] = useState(null);
  const { offer, bind } = useEditsOffer(item, agent, editing || !!shownOffer);

  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);

  const resend = () => {
    setDraft(null);
    agent.redo(item.id, 'edit', draft, images);
  };
  const empty = editing && !draft.trim() && !images.length;

  // The dialog sits beside the row, not in it. React bubbles a portal's events
  // up its component tree, and the row would take focus in the dialog as its own.
  return (
    <>
      <Message from="user" className="mt-1.5 flex-row items-end" {...bind}>
        {!editing && (
          <MessageActions className="ml-auto shrink-0 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            {offer && (
              <MessageAction label="Undo edits" title={`Undo edits to ${fileCount(offer.files.length)} from this message on`} size="xs" onClick={() => setShownOffer(offer)}>
                <Undo2Icon className="size-3.5" />{offer.files.length}
              </MessageAction>
            )}
            <MessageAction label="Edit" title="Edit this message" size="icon-xs" disabled={agent.busy} onClick={() => setDraft(item.text)}>
              <PencilIcon className="size-3.5" />
            </MessageAction>
            <MessageAction
              label="Retry"
              title="Send this message again"
              size="icon-xs"
              disabled={agent.busy}
              onClick={() => agent.redo(item.id, 'retry', item.text, images)}>
              <RotateCcwIcon className="size-3.5" />
            </MessageAction>
          </MessageActions>
        )}
        <MessageContent className={editing ? 'w-full' : 'whitespace-pre-wrap group-[.is-user]:ml-0'}>
          {images.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {images.map((img, i) => (
                <img
                  key={i}
                  alt={img.name || 'attachment'}
                  title={img.name}
                  className="max-h-40 rounded-md border"
                  src={`data:${img.media};base64,${img.data}`} />
              ))}
            </div>
          )}
          {editing ? (
            <>
              <TokenInput
                ref={input}
                value={draft}
                onChange={setDraft}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') { e.preventDefault(); setDraft(null); }
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!empty && !agent.busy) resend(); }
                }}
                placeholder="Edit this message"
                className="min-h-8 px-0 py-0.5 text-sm" />
              <div className="flex justify-end gap-1">
                <Button type="button" variant="ghost" size="xs" onClick={() => setDraft(null)}>Cancel</Button>
                <Button type="button" size="xs" disabled={empty || agent.busy} onClick={resend}>Send</Button>
              </div>
            </>
          ) : <TokenText text={item.text} />}
          {item.resent && <span className="text-muted-foreground text-xs">{RESENT[item.resent]}</span>}
          {item.undone && <span className="text-muted-foreground text-xs">{undoneCaption(item.undone)}</span>}
        </MessageContent>
      </Message>
      {shownOffer && <UndoEditsDialog offer={shownOffer} undo={() => agent.undoEdits(item.id)} onClose={() => setShownOffer(null)} />}
    </>
  );
}

function TurnErrorRow({ item, agent }) {
  const { kind, action, retryAt, message, detail } = item.turnError;
  const at = agent.items.findIndex((it) => it.id === item.id);
  const asked = (it) => it.kind === 'user';
  // Retry on an older turn would rewind past every turn after it.
  const latest = agent.items.slice(0, at).some(asked) && !agent.items.slice(at + 1).some(asked);
  const left = latest && action === 'wait' && retryAt ? retryAt - Date.now() : 0;
  useTick(left > 0);
  return (
    <div data-turn-error={kind} role="alert" className="flex flex-col items-start gap-1.5 py-1">
      <div className="text-[13px] text-destructive">
        {message.split('`').map((part, i) => (i % 2 ? <code key={i} className="rounded bg-muted px-1 font-mono text-foreground text-xs">{part}</code> : part))}
      </div>
      {detail && <div className="text-muted-foreground text-xs">{detail}</div>}
      {latest && (
        <Button size="xs" variant="outline" disabled={agent.busy || left > 0} onClick={() => agent.retryTurn(item.id)}>
          {left > 0 ? `Retry in ${clock(Math.ceil(left / 1000) * 1000)}` : 'Retry'}
        </Button>
      )}
    </div>
  );
}

function Item({ item, agent, mark }) {
  const onDecide = agent.decide;

  // An agent owns whatever it did, and that opens in a sheet over the chat. Here
  // it is one row, so three at once cost three lines of the chat and not three logs.
  if (item.kind === 'agent') {
    return (
      <div id={`row-${item.id}`}>
        <AgentRow
          item={item}
          onStop={agent.stopAgent}
          onBackground={agent.backgroundAgent}
          onShow={(it) => openSheet(it.id)} />
      </div>
    );
  }

  if (item.kind === 'user') return <UserRow item={item} agent={agent} />;

  if (item.kind === 'reasoning') return <ReasoningRow item={item} />;

  if (item.kind === 'assistant') {
    return (
      <Message from="assistant" aria-busy={item.streaming || undefined} className="mt-1.5">
        <MessageContent>
          {/* The caret rides the last paragraph while text is still coming.
              Prose that pauses for a second between chunks looks finished
              without it, and the reader reaches for the composer mid-answer. */}
          <MessageResponse
            className={item.streaming ? 'conn-streaming' : undefined}
            isAnimating={item.streaming}>
            {item.text}
          </MessageResponse>
        </MessageContent>
      </Message>
    );
  }

  if (item.kind === 'tool') {
    const label = toolLabel(item.name);
    const images = toolImages(item.output);
    const recording = toolRecording(item.output);
    const hunks = editHunks(label, item.input || {});
    const text = toolText(item.output);
    const failed = item.state === 'output-error';

    // A file edit is a diff. Showing it as JSON with two long strings in it is
    // the same information in the shape nobody can read.
    if (hunks) {
      const { added, removed } = hunkStats(hunks);
      return (
        <ToolRow
          name={label}
          input={item.input}
          state={item.state}
          at={item.at}
          defaultOpen
          right={(
            <>
              {mark && <PermMark perm={mark} />}
              <span className="flex items-center gap-1.5 font-mono text-xs">
                {added > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{added}</span>}
                {removed > 0 && <span className="text-rose-600 dark:text-rose-400">-{removed}</span>}
              </span>
            </>
          )}>
          {item.input?.files?.length ? <FileDiffs files={item.input.files} /> : <DiffView hunks={hunks} />}
          {failed && <ToolOutput text={text} error />}
        </ToolRow>
      );
    }

    // A shell left running in the background, a dev server say. It is done as
    // a call but not as a process, so the row says so and can stop it.
    const live = item.taskId && (item.status === 'running' || item.status === 'stopping');
    return (
      <div id={`row-${item.id}`}>
        <ToolRow
          name={label}
          input={item.input}
          state={item.state}
          at={item.at}
          thumb={images.at(-1) ?? null}
          defaultOpen={item.state === 'output-error' || !!recording}
          right={(
            <>
              {mark && <PermMark perm={mark} />}
              {item.taskId && (
                <span className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground/75">
                  <span>{live ? 'background' : item.status}</span>
                  {live && (
                    <span
                      role="button"
                      tabIndex={0}
                      title="Stop this command"
                      onClick={(e) => { e.stopPropagation(); agent.stopAgent(item); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); agent.stopAgent(item); } }}
                      className="grid size-5 place-items-center rounded hover:bg-secondary hover:text-foreground">
                      <SquareIcon className="size-3" />
                    </span>
                  )}
                </span>
              )}
            </>
          )}>
          {failed && text && <ToolOutput text={text} error className="mt-0" />}
          {!failed && <Pre>{JSON.stringify(item.input, null, 2)}</Pre>}
          {recording && (
            <video
              controls
              preload="metadata"
              className="mt-2 max-w-full rounded-md border"
              src={`file://${encodeURI(recording.path)}`} />
          )}
          {!recording && images.map((b, i) => (
            <img
              key={i}
              alt="screenshot"
              className="mt-2 max-w-full rounded-md border"
              loading="lazy"
              src={imageSrc(b)} />
          ))}
          {!failed && text && <ToolOutput text={text} />}
          {failed && <InputFold input={item.input} />}
        </ToolRow>
      </div>
    );
  }

  if (item.kind === 'perm') {
    const label = toolLabel(item.tool);
    if (item.decided) {
      // A question that was answered says what the answer was; there is nothing
      // useful in telling someone they allowed their own reply.
      if (item.answers) {
        return (
          <div className="flex flex-col gap-1.5 px-2 text-xs">
            {Object.entries(item.answers).map(([q, a]) => (
              <div key={q}>
                <div className="text-muted-foreground">{q}</div>
                {/* The picker's advice to the asker, not part of the answer. */}
                <div className="text-foreground">{String(a).replace(/\s*\(Recommended\)/g, '')}</div>
              </div>
            ))}
          </div>
        );
      }
      const verb = item.decided === 'deny' ? 'Denied' : item.decided === 'always' ? 'Always allow' : 'Allowed';
      return (
        <div className="flex h-7 items-center gap-1.5 px-1.5 text-[13px] text-muted-foreground">
          <span className="w-3 shrink-0" />
          <span className="w-3.5 shrink-0" />
          <span>
            {verb}{' '}
            <span className="font-mono text-xs text-foreground/75">{toolName(label)}</span>
          </span>
        </div>
      );
    }

    // A question is not a permission, whatever the transport says.
    if (item.tool === 'AskUserQuestion') {
      return (
        <div data-perm-card={item.id} role="group" aria-labelledby={permTitleId(item.id)}>
          <QuestionCard
            titleId={permTitleId(item.id)}
            input={item.input}
            onAnswer={(answers, annotations) =>
              onDecide(item.id, 'allow', { ...item.input, answers, ...(annotations ? { annotations } : {}) })}
            onSkip={() => onDecide(item.id, 'deny')} />
        </div>
      );
    }
    return (
      <div
        data-perm-card={item.id}
        role="group"
        aria-labelledby={permTitleId(item.id)}
        onKeyDown={(e) => {
          const verdict = PERM_KEYS[e.key.toLowerCase()];
          if (!verdict || e.repeat || e.isComposing || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
          e.preventDefault();
          onDecide(item.id, verdict);
        }}
        className="rounded-md border border-amber-500/30 bg-amber-500/[0.07] px-3 py-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {/* Which agent is stuck on this. Without it a subagent's request
              reads as though the main thread asked. */}
          {item.agent && (
            <Button
              variant="ghost"
              size="xs"
              title="Show the agent that asked"
              onClick={() => document.getElementById(`row-${item.agent.toolUseId}`)
                ?.scrollIntoView({ block: 'center', behavior: 'smooth' })}
              className="h-auto rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] font-normal text-amber-700 dark:text-amber-500">
              {item.agent.label}
            </Button>
          )}
          <span id={permTitleId(item.id)} className="text-[13px]">
            {item.title || <>Allow <span className="font-mono font-medium">{label}</span>?</>}
          </span>
          <span className="truncate font-mono text-muted-foreground text-xs">
            {toolSummary(label, item.input)}
          </span>
          {/* Why this one stopped when the mode lets other calls through. */}
          {item.reason && (
            <span className="text-amber-700 text-xs dark:text-amber-500/90">{item.reason}</span>
          )}
          <div className="ml-auto flex gap-1.5">
            {/* Focus lands here from a script, which Chromium leaves without a
                focus-visible ring after a mouse click, and a click on it
                answers the card anyway. */}
            <Button size="sm" className="h-7 focus:border-ring focus:ring-[3px] focus:ring-ring/50" data-perm-allow={item.id} onClick={() => onDecide(item.id, 'allow')}>Allow</Button>
            <Button size="sm" variant="outline" className="h-7" onClick={() => onDecide(item.id, 'always')}>Always</Button>
            <Button size="sm" variant="ghost" className="h-7" onClick={() => onDecide(item.id, 'deny')}>Deny</Button>
          </div>
        </div>
      </div>
    );
  }

  if (item.turnError) return <TurnErrorRow item={item} agent={agent} />;

  return (
    <div className={`font-mono text-xs ${item.error ? 'text-destructive' : 'text-muted-foreground'}`}>
      {item.text}
    </div>
  );
}
