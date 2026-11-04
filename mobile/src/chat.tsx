import { useState, useSyncExternalStore, type ReactElement } from 'react';
import { Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { withAnswers, type Question, type Reply } from '../../src/shared/ask-answers.js';
import { MAX_PHOTOS } from '../../src/shared/phone-wire.js';
import { attachLive, decidePerm, refreshChats, requestTranscript, sendTurn } from './conn-live';
import { takePhotos, type Photo, type PhotoSource } from './photos';
import { QuestionCard } from './question-card';
import { layout, zinc } from './theme/zinc';

declare const sessionBrand: unique symbol;
declare const itemBrand: unique symbol;

export type SessionId = string & { readonly [sessionBrand]: typeof sessionBrand };

type ItemId = string & { readonly [itemBrand]: typeof itemBrand };

function sessionId(raw: string): SessionId {
  return raw as SessionId;
}

function itemId(raw: string): ItemId {
  return raw as ItemId;
}

type ItemBase = {
  readonly id: ItemId;
  readonly parent: ItemId | null;
};

type PhotoThumb = Pick<Photo, 'uri' | 'width' | 'height'>;

type UserItem = ItemBase & {
  readonly kind: 'user';
  readonly text: string;
  readonly photos?: readonly PhotoThumb[];
};

type Draft = {
  readonly text: string;
  readonly photos: readonly Photo[];
};

type AssistantItem = ItemBase & {
  readonly kind: 'assistant';
  readonly text: string;
  readonly streaming?: true;
};

type ReasoningItem = ItemBase & {
  readonly kind: 'reasoning';
  readonly text: string;
  readonly streaming?: true;
};

type PlanStatus = 'pending' | 'in_progress' | 'completed';

type PlanItem = ItemBase & {
  readonly kind: 'plan';
  readonly entries: readonly { readonly content: string; readonly status: PlanStatus }[];
  readonly explanation?: string;
};

type ToolState = 'input-streaming' | 'input-available' | 'output-available' | 'output-error';

type ToolItem = ItemBase & {
  readonly kind: 'tool';
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly state: ToolState;
  readonly output?: string;
  readonly at?: number;
  readonly end?: number;
};

type PermVerdict = 'allow' | 'deny' | 'always';

type PermAsk =
  | { readonly kind: 'tool' }
  | { readonly kind: 'questions'; readonly questions: readonly Question[] };

type PermItem = ItemBase & {
  readonly kind: 'perm';
  readonly tool: string;
  readonly title: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly ask: PermAsk;
  readonly forId: ItemId | null;
  readonly askedBy?: string;
  readonly reason?: string;
  readonly answers?: Readonly<Record<string, string>>;
  readonly decided?: PermVerdict;
};

type AgentStatus = 'running' | 'done' | 'stopped' | 'error';

type AgentItem = ItemBase & {
  readonly kind: 'agent';
  readonly name: string;
  readonly agentType: string;
  readonly description: string;
  readonly status: AgentStatus;
  readonly tools: number;
  readonly ms: number;
};

type NoteItem = ItemBase & {
  readonly kind: 'note';
  readonly text: string;
  readonly error?: true;
  readonly ended?: true;
};

type Item =
  | UserItem
  | AssistantItem
  | ReasoningItem
  | PlanItem
  | ToolItem
  | PermItem
  | AgentItem
  | NoteItem;

type LiveItem = Exclude<Item, { kind: 'user' }>;

type Session = {
  readonly id: SessionId;
  readonly title: string;
  readonly at: number;
  readonly provider: string;
  readonly project: string;
  readonly resume: string | null;
};

type ChatState = {
  readonly labeledAt: number;
  readonly seq: number;
  readonly sessions: readonly Session[];
  readonly itemsBySession: Readonly<Record<string, readonly Item[]>>;
  readonly draftBySession: Readonly<Record<string, Draft>>;
  readonly activeId: SessionId | null;
  readonly query: string;
};

type ChatEvent =
  | { readonly type: 'open'; readonly id: SessionId }
  | { readonly type: 'back' }
  | { readonly type: 'new-chat' }
  | { readonly type: 'query'; readonly text: string }
  | { readonly type: 'draft'; readonly text: string }
  | { readonly type: 'photos'; readonly session: SessionId; readonly photos: readonly Photo[] }
  | { readonly type: 'drop-photo'; readonly index: number }
  | { readonly type: 'send' };

export type CatalogChat = {
  readonly id: SessionId;
  readonly title: string;
  readonly at: number;
  readonly provider: string;
  readonly resume: string;
};

export type LiveEvent =
  | { readonly type: 'upsert'; readonly session: SessionId; readonly item: LiveItem }
  | {
      readonly type: 'decide';
      readonly session: SessionId;
      readonly itemId: ItemId;
      readonly verdict: PermVerdict;
      readonly answers?: Readonly<Record<string, string>>;
    }
  | { readonly type: 'catalog'; readonly folder: string; readonly chats: readonly CatalogChat[] }
  | { readonly type: 'transcript'; readonly session: SessionId; readonly messages: readonly unknown[] };

export type SessionRow = {
  readonly id: SessionId;
  readonly title: string;
  readonly provider: string;
  readonly atLabel: string;
};

export type SessionSection = {
  readonly project: string;
  readonly rows: readonly SessionRow[];
};

export type SessionsView = {
  readonly name: 'sessions';
  readonly query: string;
  readonly sections: readonly SessionSection[];
};

type PermMark = {
  readonly verdict: PermVerdict;
};

export type TranscriptRow = {
  readonly id: string;
  readonly item: Item;
  readonly permMark?: PermMark;
};

export type ChatView = {
  readonly name: 'chat';
  readonly title: string;
  readonly rows: readonly TranscriptRow[];
  readonly draft: string;
  readonly photos: readonly PhotoThumb[];
  readonly canAttach: boolean;
  readonly canSend: boolean;
  readonly starters: readonly string[];
};

export type Screen = SessionsView | ChatView;

const DRAFT_PROJECT = 'Drafts';
const NEW_TITLE = 'New chat';

const STARTERS: readonly string[] = [
  'Explain how this project is organised',
  'What should change?',
  'Where do the zinc colors live?',
];

const SEEDED_AT = Date.now();

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const EMPTY_DRAFT: Draft = { text: '', photos: [] };

function hasContent(draft: Draft): boolean {
  return draft.text.trim() !== '' || draft.photos.length > 0;
}

function thumbsOf(photos: readonly Photo[]): readonly PhotoThumb[] {
  return photos.map(({ uri, width, height }) => ({ uri, width, height }));
}

function userItem(id: string, text: string, photos?: readonly PhotoThumb[]): UserItem {
  return {
    id: itemId(id),
    kind: 'user',
    parent: null,
    text,
    ...(photos && photos.length > 0 ? { photos } : {}),
  };
}

function assistantItem(id: string, text: string): AssistantItem {
  return { id: itemId(id), kind: 'assistant', parent: null, text };
}

function toolItem(
  id: string,
  name: string,
  state: ToolState,
  input: Readonly<Record<string, unknown>>,
  output: string,
): ToolItem {
  return { id: itemId(id), kind: 'tool', parent: null, name, state, input, output };
}

const INITIAL: ChatState = {
  labeledAt: SEEDED_AT,
  seq: 1,
  activeId: null,
  query: '',
  sessions: [],
  itemsBySession: {},
  draftBySession: {},
};

function validate(state: ChatState): void {
  const ids = state.sessions.map((session) => session.id);
  if (new Set(ids).size !== ids.length) throw new Error('duplicate session id');
  if (state.query !== '') throw new Error('fixture query');
  if (state.activeId !== null && !ids.includes(state.activeId)) throw new Error('active session missing');
  const itemKeys = Object.keys(state.itemsBySession);
  const draftKeys = Object.keys(state.draftBySession);
  if (itemKeys.length !== ids.length || draftKeys.length !== ids.length) throw new Error('session map size');
  const known = new Set<string>(ids);
  for (const key of itemKeys) {
    if (!known.has(key)) throw new Error('extra items key');
  }
  for (const key of draftKeys) {
    if (!known.has(key)) throw new Error('extra draft key');
  }
  for (const session of state.sessions) {
    if (session.title.trim() === '' || session.project.trim() === '') throw new Error('empty session label');
    if (!Object.hasOwn(state.itemsBySession, session.id) || !Object.hasOwn(state.draftBySession, session.id)) {
      throw new Error('missing session map');
    }
    const itemIds = state.itemsBySession[session.id].map((item) => item.id);
    if (new Set(itemIds).size !== itemIds.length) throw new Error('duplicate item id');
  }
}

function seed(): ChatState {
  validate(INITIAL);
  return INITIAL;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function dateName(names: readonly string[], index: number): string {
  const name = names[index];
  if (name === undefined) throw new Error('bad date index');
  return name;
}

function formatAt(at: number, labeledAt: number): string {
  const delta = labeledAt - at;
  if (delta >= 0 && delta < 60_000) return 'now';
  const when = new Date(at);
  const label = new Date(labeledAt);
  const sameDay =
    when.getFullYear() === label.getFullYear() &&
    when.getMonth() === label.getMonth() &&
    when.getDate() === label.getDate();
  if (sameDay) return `${pad(when.getHours())}:${pad(when.getMinutes())}`;
  if (delta >= 0 && delta < 7 * 24 * 60 * 60 * 1000) return dateName(WEEKDAYS, when.getDay());
  return `${dateName(MONTHS, when.getMonth())} ${when.getDate()}`;
}

function sessionSections(state: ChatState): readonly SessionSection[] {
  const needle = state.query.trim().toLocaleLowerCase();
  const groups = new Map<string, Session[]>();
  for (const session of state.sessions) {
    if (needle !== '') {
      const title = session.title.toLocaleLowerCase();
      const folder = session.project.toLocaleLowerCase();
      if (!title.includes(needle) && !folder.includes(needle)) continue;
    }
    const bucket = groups.get(session.project);
    if (bucket) bucket.push(session);
    else groups.set(session.project, [session]);
  }
  return [...groups.entries()]
    .map(([project, sessions]) => ({
      project,
      latest: Math.max(...sessions.map((session) => session.at)),
      rows: sessions
        .slice()
        .sort((left, right) => right.at - left.at)
        .map((session) => ({
          id: session.id,
          title: session.title,
          provider: session.provider,
          atLabel: formatAt(session.at, state.labeledAt),
        })),
    }))
    .sort((left, right) => right.latest - left.latest)
    .map(({ project, rows }) => ({ project, rows }));
}

type Projected =
  | { readonly name: 'sessions'; readonly query: string; readonly sections: readonly SessionSection[] }
  | {
      readonly name: 'chat';
      readonly title: string;
      readonly items: readonly Item[];
      readonly draft: string;
      readonly photos: readonly PhotoThumb[];
      readonly canAttach: boolean;
      readonly canSend: boolean;
      readonly starters: readonly string[];
    };

function project(state: ChatState): Projected {
  if (state.activeId === null) {
    return { name: 'sessions', query: state.query, sections: sessionSections(state) };
  }
  const session = state.sessions.find((entry) => entry.id === state.activeId);
  if (!session) throw new Error('active session missing');
  const items = state.itemsBySession[session.id];
  const draft = state.draftBySession[session.id];
  return {
    name: 'chat',
    title: session.title,
    items,
    draft: draft.text,
    photos: thumbsOf(draft.photos),
    canAttach: draft.photos.length < MAX_PHOTOS,
    canSend: hasContent(draft),
    starters: items.length === 0 ? STARTERS.slice() : [],
  };
}

function present(projected: Projected): Screen {
  if (projected.name === 'sessions') return projected;
  const toolIds = new Set<ItemId>();
  for (const item of projected.items) {
    if (item.kind === 'tool') toolIds.add(item.id);
  }
  const marks = new Map<ItemId, PermMark>();
  const placed = new Set<ItemId>();
  for (const item of projected.items) {
    if (item.kind !== 'perm' || !item.decided || item.answers || item.ask.kind === 'questions') continue;
    if (!item.forId || !toolIds.has(item.forId) || marks.has(item.forId)) continue;
    marks.set(item.forId, { verdict: item.decided });
    placed.add(item.id);
  }
  const rows: TranscriptRow[] = [];
  for (const item of projected.items) {
    if (placed.has(item.id)) continue;
    const permMark = item.kind === 'tool' ? marks.get(item.id) : undefined;
    rows.push(permMark ? { id: item.id, item, permMark } : { id: item.id, item });
  }
  return {
    name: 'chat',
    title: projected.title,
    rows,
    draft: projected.draft,
    photos: projected.photos,
    canAttach: projected.canAttach,
    canSend: projected.canSend,
    starters: projected.starters,
  };
}

function openSession(state: ChatState, id: SessionId): ChatState {
  const known = state.sessions.some((session) => session.id === id);
  if (!known || state.activeId === id) return state;
  return { ...state, activeId: id };
}

function withClock(state: ChatState, now: number): ChatState {
  if (now === state.labeledAt) return state;
  return { ...state, labeledAt: now };
}

function startChat(state: ChatState, now: number): ChatState {
  const existing = state.sessions.find(
    (session) =>
      session.project === DRAFT_PROJECT &&
      session.title === NEW_TITLE &&
      state.itemsBySession[session.id].length === 0 &&
      state.draftBySession[session.id].text === '' &&
      state.draftBySession[session.id].photos.length === 0,
  );
  if (existing) {
    if (state.activeId === existing.id) return state;
    return { ...state, activeId: existing.id };
  }
  const clocked = withClock(state, now);
  const id = sessionId(`s${clocked.seq}`);
  return {
    ...clocked,
    seq: clocked.seq + 1,
    activeId: id,
    sessions: [
      ...clocked.sessions,
      { id, title: NEW_TITLE, at: now, provider: '', project: DRAFT_PROJECT, resume: null },
    ],
    itemsBySession: { ...clocked.itemsBySession, [id]: [] },
    draftBySession: { ...clocked.draftBySession, [id]: EMPTY_DRAFT },
  };
}

function writeDraft(state: ChatState, text: string): ChatState {
  const id = state.activeId;
  if (id === null) return state;
  const draft = state.draftBySession[id];
  if (draft.text === text) return state;
  return { ...state, draftBySession: { ...state.draftBySession, [id]: { ...draft, text } } };
}

function addPhotos(state: ChatState, session: SessionId, photos: readonly Photo[]): ChatState {
  const draft = state.draftBySession[session];
  if (!draft || photos.length === 0 || draft.photos.length >= MAX_PHOTOS) return state;
  return {
    ...state,
    draftBySession: {
      ...state.draftBySession,
      [session]: { ...draft, photos: [...draft.photos, ...photos].slice(0, MAX_PHOTOS) },
    },
  };
}

function dropPhotoAt(state: ChatState, index: number): ChatState {
  const id = state.activeId;
  if (id === null) return state;
  const draft = state.draftBySession[id];
  if (index < 0 || index >= draft.photos.length) return state;
  return {
    ...state,
    draftBySession: {
      ...state.draftBySession,
      [id]: { ...draft, photos: draft.photos.filter((_, at) => at !== index) },
    },
  };
}

function sendDraft(state: ChatState, now: number): ChatState {
  const id = state.activeId;
  if (id === null) return state;
  const draft = state.draftBySession[id];
  if (!hasContent(draft)) return state;
  const text = draft.text.trim();
  const clocked = withClock(state, now);
  return {
    ...clocked,
    seq: clocked.seq + 1,
    sessions: clocked.sessions.map((session) => (session.id === id ? { ...session, at: now } : session)),
    itemsBySession: {
      ...clocked.itemsBySession,
      [id]: [...clocked.itemsBySession[id], userItem(`u${clocked.seq}`, text, thumbsOf(draft.photos))],
    },
    draftBySession: { ...clocked.draftBySession, [id]: EMPTY_DRAFT },
  };
}

function reduce(state: ChatState, event: ChatEvent, now: number): ChatState {
  switch (event.type) {
    case 'open':
      return openSession(state, event.id);
    case 'back':
      return state.activeId === null ? state : { ...state, activeId: null };
    case 'new-chat':
      return startChat(state, now);
    case 'query':
      return event.text === state.query ? state : { ...state, query: event.text };
    case 'draft':
      return writeDraft(state, event.text);
    case 'photos':
      return addPhotos(state, event.session, event.photos);
    case 'drop-photo':
      return dropPhotoAt(state, event.index);
    case 'send':
      return sendDraft(state, now);
    default: {
      const _never: never = event;
      return _never;
    }
  }
}

function sameItem(left: Item, right: Item): boolean {
  return left.kind === right.kind && JSON.stringify(left) === JSON.stringify(right);
}

function ensureSession(state: ChatState, session: SessionId, now: number): ChatState {
  if (state.sessions.some((entry) => entry.id === session)) return state;
  return {
    ...state,
    sessions: [
      ...state.sessions,
      { id: session, title: NEW_TITLE, at: now, provider: 'Claude', project: DRAFT_PROJECT, resume: null },
    ],
    itemsBySession: { ...state.itemsBySession, [session]: [] },
    draftBySession: { ...state.draftBySession, [session]: EMPTY_DRAFT },
  };
}

function upsertItem(state: ChatState, session: SessionId, item: LiveItem, now: number): ChatState {
  const ready = ensureSession(state, session, now);
  const items = ready.itemsBySession[session];
  const index = items.findIndex((entry) => entry.id === item.id);
  if (index !== -1 && sameItem(items[index], item)) return ready;
  const next = items.slice();
  if (index === -1) next.push(item);
  else next[index] = item;
  return { ...ready, itemsBySession: { ...ready.itemsBySession, [session]: next } };
}

function markPerm(
  state: ChatState,
  session: SessionId,
  target: ItemId,
  verdict: PermVerdict,
  answers?: Readonly<Record<string, string>>,
): ChatState {
  if (!state.sessions.some((entry) => entry.id === session)) return state;
  const items = state.itemsBySession[session];
  const index = items.findIndex((entry) => entry.id === target);
  if (index === -1) return state;
  const current = items[index];
  if (current.kind !== 'perm') return state;
  if (current.decided === verdict && answers === undefined) return state;
  const next = items.slice();
  next[index] = answers ? { ...current, decided: verdict, answers } : { ...current, decided: verdict };
  return { ...state, itemsBySession: { ...state.itemsBySession, [session]: next } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function visibleText(raw: string): string {
  const kept = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  const flat = kept.replace(/\s+/g, ' ').trim();
  if (flat === '') return '';
  if (/^<(command-name|command-message|command-args|local-command|bash-input|bash-stdout|bash-stderr|user-prompt|ide_)/.test(flat)) {
    return '';
  }
  if (/^(Caveat|\[Request interrupted)/.test(flat)) return '';
  return kept;
}

function blocksOf(message: Record<string, unknown>): Record<string, unknown>[] {
  const content = message.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter(isRecord);
}

function replayToolText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') parts.push(part);
    else if (isRecord(part) && typeof part.text === 'string') parts.push(part.text);
  }
  return parts.join('\n');
}

function itemsFromMessages(messages: readonly unknown[]): Item[] {
  const items: Item[] = [];
  const tools = new Map<string, number>();
  let n = 0;
  for (const raw of messages) {
    if (!isRecord(raw) || !isRecord(raw.message)) continue;
    const blocks = blocksOf(raw.message);
    const uuid = typeof raw.uuid === 'string' && raw.uuid !== '' ? raw.uuid : '';
    if (raw.type === 'user') {
      const text = visibleText(blocks
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n'));
      if (text !== '') items.push(userItem(uuid || `user:${n}`, text));
      for (const block of blocks) {
        if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const index = tools.get(block.tool_use_id);
        if (index === undefined) continue;
        const current = items[index];
        if (current === undefined || current.kind !== 'tool') continue;
        const failed = block.is_error === true;
        items[index] = {
          ...current,
          state: failed ? 'output-error' : 'output-available',
          output: replayToolText(block.content),
        };
      }
    } else if (raw.type === 'assistant') {
      let blockAt = 0;
      for (const block of blocks) {
        const id = uuid !== '' ? `${uuid}:${blockAt}` : `m:${n}:${blockAt}`;
        if (block.type === 'text' && typeof block.text === 'string') {
          const text = visibleText(block.text);
          if (text !== '') items.push(assistantItem(id, text));
        } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim() !== '') {
          items.push({ id: itemId(id), kind: 'reasoning', parent: null, text: block.thinking });
        } else if (block.type === 'tool_use') {
          const toolId = typeof block.id === 'string' && block.id !== '' ? block.id : id;
          const name = typeof block.name === 'string' && block.name !== '' ? block.name : 'tool';
          const input = isRecord(block.input) ? block.input : {};
          tools.set(toolId, items.length);
          items.push(toolItem(toolId, name, 'input-available', input, ''));
        }
        blockAt += 1;
      }
    }
    n += 1;
  }
  return items;
}

function keptMaps(
  state: ChatState,
  sessions: readonly Session[],
): Pick<ChatState, 'itemsBySession' | 'draftBySession'> {
  const itemsBySession: Record<string, readonly Item[]> = {};
  const draftBySession: Record<string, Draft> = {};
  for (const session of sessions) {
    itemsBySession[session.id] = state.itemsBySession[session.id] ?? [];
    draftBySession[session.id] = state.draftBySession[session.id] ?? EMPTY_DRAFT;
  }
  return { itemsBySession, draftBySession };
}

function applyCatalog(state: ChatState, event: Extract<LiveEvent, { type: 'catalog' }>, now: number): ChatState {
  const folder = event.folder.trim() === '' ? 'Conn' : event.folder;
  const remote: Session[] = [];
  const seen = new Set<string>();
  for (const chat of event.chats) {
    if (seen.has(chat.id) || chat.resume.trim() === '' || chat.title.trim() === '') continue;
    seen.add(chat.id);
    remote.push({
      id: chat.id,
      title: chat.title,
      at: chat.at,
      provider: chat.provider,
      project: folder,
      resume: chat.resume,
    });
  }
  const local = state.sessions.filter((session) => session.project === DRAFT_PROJECT && !seen.has(session.id));
  const sessions = [...remote, ...local];
  const kept = new Set(sessions.map((session) => session.id));
  const activeId = state.activeId !== null && kept.has(state.activeId) ? state.activeId : null;
  return {
    ...state,
    labeledAt: now,
    activeId,
    sessions,
    ...keptMaps(state, sessions),
  };
}

function applyTranscript(state: ChatState, event: Extract<LiveEvent, { type: 'transcript' }>): ChatState {
  if (!state.sessions.some((session) => session.id === event.session)) return state;
  const replayed = itemsFromMessages(event.messages);
  const said = new Set(replayed.filter((item) => item.kind === 'user').map((item) => item.text));
  const pending = (state.itemsBySession[event.session] ?? []).filter((item) => (
    item.kind === 'user' && !said.has(item.text)
  ));
  return {
    ...state,
    itemsBySession: { ...state.itemsBySession, [event.session]: [...replayed, ...pending] },
  };
}

function reduceLive(state: ChatState, event: LiveEvent, now: number): ChatState {
  switch (event.type) {
    case 'upsert':
      return upsertItem(state, event.session, event.item, now);
    case 'decide':
      return markPerm(state, event.session, event.itemId, event.verdict, event.answers);
    case 'catalog':
      return applyCatalog(state, event, now);
    case 'transcript':
      return applyTranscript(state, event);
    default: {
      const _never: never = event;
      return _never;
    }
  }
}

let state: ChatState = seed();

type Listener = () => void;
const listeners = new Set<Listener>();

let cache: { readonly state: ChatState; readonly screen: Screen } | null = null;

function commit(next: ChatState): void {
  if (next === state) return;
  state = next;
  cache = null;
  for (const listener of listeners) listener();
}

function dispatch(event: ChatEvent): void {
  commit(reduce(state, event, Date.now()));
}

function applyLive(event: LiveEvent): void {
  commit(reduceLive(state, event, Date.now()));
}

export function acceptLive(event: LiveEvent): void {
  applyLive(event);
}

attachLive(applyLive);

function decide(session: SessionId, target: ItemId, verdict: PermVerdict): void {
  applyLive({ type: 'decide', session, itemId: target, verdict });
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): Screen {
  if (cache && cache.state === state) return cache.screen;
  const screen = present(project(state));
  cache = { state, screen };
  return screen;
}

export function useScreen(): Screen {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function peekScreen(): Screen {
  return getSnapshot();
}

export const chat = {
  back(): void {
    dispatch({ type: 'back' });
    refreshChats();
  },
  open(id: SessionId): void {
    const loaded = (state.itemsBySession[id]?.length ?? 0) > 0;
    dispatch({ type: 'open', id });
    if (!loaded) requestTranscript(id);
  },
  newChat(): void {
    dispatch({ type: 'new-chat' });
  },
  setQuery(text: string): void {
    dispatch({ type: 'query', text });
  },
  setDraft(text: string): void {
    dispatch({ type: 'draft', text });
  },
  attach(source: PhotoSource): void {
    const session = state.activeId;
    if (session === null) return;
    const draft = state.draftBySession[session];
    const room = MAX_PHOTOS - draft.photos.length;
    if (room <= 0) return;
    void takePhotos(source, room).then((pick) => {
      switch (pick.kind) {
        case 'picked':
          if (pick.photos.length > 0) dispatch({ type: 'photos', session, photos: pick.photos });
          if (pick.dropped > 0) photoNote(session, droppedNote(pick.dropped));
          return;
        case 'cancelled':
          return;
        case 'denied':
          photoNote(session, 'Conn needs photo or camera access in Settings.');
          return;
        default: {
          const _never: never = pick;
          return _never;
        }
      }
    }, () => {
      // A failed system sheet leaves the draft as it was.
    });
  },
  dropPhoto(index: number): void {
    dispatch({ type: 'drop-photo', index });
  },
  send(): void {
    const id = state.activeId;
    if (id === null) return;
    const draft = state.draftBySession[id];
    if (!hasContent(draft)) return;
    const text = draft.text.trim();
    const photos = draft.photos;
    dispatch({ type: 'send' });
    void sendTurn(id, { text, photos });
  },
};

let photoNotes = 0;

function droppedNote(count: number): string {
  return count === 1 ? '1 photo did not fit.' : `${count} photos did not fit.`;
}

function photoNote(session: SessionId, text: string): void {
  if (!state.sessions.some((entry) => entry.id === session)) return;
  photoNotes += 1;
  applyLive({
    type: 'upsert',
    session,
    item: {
      id: itemId(`photo-note-${photoNotes}`),
      kind: 'note',
      parent: null,
      text,
    },
  });
}

function toolHue(toolState: ToolState): string {
  switch (toolState) {
    case 'input-streaming':
    case 'input-available':
      return zinc.working;
    case 'output-available':
      return zinc.finished;
    case 'output-error':
      return zinc.danger;
    default: {
      const _never: never = toolState;
      return _never;
    }
  }
}

function agentHue(status: AgentStatus): string {
  switch (status) {
    case 'running':
      return zinc.working;
    case 'done':
      return zinc.finished;
    case 'stopped':
      return zinc.muted;
    case 'error':
      return zinc.danger;
    default: {
      const _never: never = status;
      return _never;
    }
  }
}

function planHue(status: PlanStatus): string {
  switch (status) {
    case 'pending':
      return zinc.muted;
    case 'in_progress':
      return zinc.waiting;
    case 'completed':
      return zinc.finished;
    default: {
      const _never: never = status;
      return _never;
    }
  }
}

function verdictLabel(verdict: PermVerdict): string {
  switch (verdict) {
    case 'allow':
      return 'Allowed';
    case 'always':
      return 'Always allow';
    case 'deny':
      return 'Denied';
    default: {
      const _never: never = verdict;
      return _never;
    }
  }
}

function inputSummary(input: Readonly<Record<string, unknown>>): string {
  for (const value of Object.values(input)) {
    if (typeof value === 'string' && value !== '') return value;
  }
  return '';
}

function caret(streaming: true | undefined): string {
  return streaming ? ' |' : '';
}

function thumbBox(photo: PhotoThumb): { width: number; height: number; borderRadius: number } {
  const long = Math.max(photo.width, photo.height, 1);
  const scale = 72 / long;
  return {
    width: Math.max(1, Math.round(photo.width * scale)),
    height: Math.max(1, Math.round(photo.height * scale)),
    borderRadius: 6,
  };
}

function renderUser(item: UserItem): ReactElement {
  const photos = item.photos ?? [];
  return (
    <View style={styles.user}>
      {photos.length === 0 ? null : (
        <View style={styles.thumbs}>
          {photos.map((photo, index) => (
            <Image
              key={`${photo.uri}:${index}`}
              source={{ uri: photo.uri }}
              accessibilityLabel="Attached photo"
              style={thumbBox(photo)}
            />
          ))}
        </View>
      )}
      {item.text === '' ? null : (
        <Text style={styles.userText} selectable>
          {item.text}
        </Text>
      )}
    </View>
  );
}

function renderAssistant(item: AssistantItem): ReactElement {
  return (
    <Text style={styles.assistant} selectable>
      {item.text}
      {caret(item.streaming)}
    </Text>
  );
}

function renderReasoning(item: ReasoningItem): ReactElement {
  return (
    <Text style={styles.reasoning} numberOfLines={1}>
      {item.text}
      {caret(item.streaming)}
    </Text>
  );
}

function renderPlan(item: PlanItem): ReactElement {
  return (
    <View style={styles.plan}>
      {item.explanation ? <Text style={styles.reasoning}>{item.explanation}</Text> : null}
      {item.entries.map((entry, index) => (
        <Text key={`${index}:${entry.content}`} style={[styles.planEntry, { color: planHue(entry.status) }]}>
          {entry.content}
        </Text>
      ))}
    </View>
  );
}

function ToolRow({ item, permMark }: { item: ToolItem; permMark?: PermMark }) {
  const [open, setOpen] = useState(item.state === 'output-error');
  const summary = inputSummary(item.input);
  const hue = toolHue(item.state);
  const failed = item.state === 'output-error';
  return (
    <Pressable
      onPress={() => setOpen((value) => !value)}
      accessibilityRole="button"
      style={[styles.toolRow, failed && styles.toolRowError]}
    >
      <View style={styles.toolLine}>
        <Text style={styles.toolChevron}>{open ? '▾' : '▸'}</Text>
        <Text style={[styles.toolName, { color: failed ? zinc.danger : hue }]}>{item.name}</Text>
        {summary === '' ? null : (
          <Text style={styles.toolSummary} numberOfLines={1}>
            {summary}
          </Text>
        )}
        {permMark ? <Text style={styles.permMark}>{verdictLabel(permMark.verdict)}</Text> : null}
      </View>
      {open && item.output ? (
        <Text style={[styles.toolOutput, { color: failed ? zinc.danger : zinc.muted }]}>
          {item.output}
        </Text>
      ) : null}
    </Pressable>
  );
}

function answerPerm(target: ItemId, verdict: PermVerdict): void {
  if (state.activeId === null) return;
  const session = state.activeId;
  decide(session, target, verdict);
  void decidePerm(session, target, { kind: 'verdict', verdict });
}

function answerQuestions(item: PermItem, reply: Reply): void {
  const session = state.activeId;
  if (session === null) return;
  applyLive({ type: 'decide', session, itemId: item.id, verdict: 'allow', answers: reply.answers });
  void decidePerm(session, item.id, { kind: 'answers', input: withAnswers(item.input, reply) });
}

function ToolPermCard({ item }: { item: PermItem }): ReactElement {
  return (
    <View style={styles.permCard}>
      <Text style={styles.assistant}>{item.title}</Text>
      {item.reason ? <Text style={styles.permReason}>{item.reason}</Text> : null}
      {item.askedBy ? <Text style={styles.reasoning}>{item.askedBy}</Text> : null}
      <View style={styles.permActions}>
        <Pressable onPress={() => answerPerm(item.id, 'allow')} accessibilityLabel="Allow">
          <Text style={styles.permAction}>Allow</Text>
        </Pressable>
        <Pressable onPress={() => answerPerm(item.id, 'always')} accessibilityLabel="Always">
          <Text style={styles.permAction}>Always</Text>
        </Pressable>
        <Pressable onPress={() => answerPerm(item.id, 'deny')} accessibilityLabel="Deny">
          <Text style={styles.permAction}>Deny</Text>
        </Pressable>
      </View>
    </View>
  );
}

function PermCard({ item }: { item: PermItem }): ReactElement {
  if (item.answers) {
    return (
      <View style={styles.plan}>
        {Object.entries(item.answers).map(([question, answer]) => (
          <View key={question}>
            <Text style={styles.reasoning}>{question}</Text>
            <Text style={styles.assistant}>{answer.replace(/\s*\(Recommended\)/g, '')}</Text>
          </View>
        ))}
      </View>
    );
  }
  if (item.decided) {
    return (
      <Text style={styles.reasoning}>
        {verdictLabel(item.decided)} {item.tool}
      </Text>
    );
  }
  switch (item.ask.kind) {
    case 'questions':
      return (
        <QuestionCard
          questions={item.ask.questions}
          onAnswer={(reply) => answerQuestions(item, reply)}
          onSkip={() => answerPerm(item.id, 'deny')}
        />
      );
    case 'tool':
      return <ToolPermCard item={item} />;
    default: {
      const _never: never = item.ask;
      return _never;
    }
  }
}

function AgentRow({ item }: { item: AgentItem }) {
  const [open, setOpen] = useState(false);
  return (
    <Pressable onPress={() => setOpen((value) => !value)} accessibilityRole="button" style={styles.toolRow}>
      <View style={styles.toolLine}>
        <Text style={styles.toolChevron}>{open ? '▾' : '▸'}</Text>
        <Text style={[styles.toolName, { color: agentHue(item.status) }]}>{item.name}</Text>
        {item.description === '' ? null : (
          <Text style={styles.toolSummary} numberOfLines={1}>
            {item.description}
          </Text>
        )}
      </View>
      {open ? (
        <Text style={styles.reasoning}>
          {item.agentType} · {item.status} · {item.tools} tools · {item.ms}ms
        </Text>
      ) : null}
    </Pressable>
  );
}

function renderNote(item: NoteItem): ReactElement {
  return <Text style={[styles.note, { color: item.error ? zinc.danger : zinc.faint }]}>{item.text}</Text>;
}

function renderTool(item: ToolItem, permMark: PermMark | undefined): ReactElement {
  return <ToolRow item={item} permMark={permMark} />;
}

function renderPerm(item: PermItem): ReactElement {
  return <PermCard item={item} />;
}

function renderAgent(item: AgentItem): ReactElement {
  return <AgentRow item={item} />;
}

export function ChatItemView({ row }: { row: TranscriptRow }): ReactElement {
  const { item, permMark } = row;
  switch (item.kind) {
    case 'user':
      return renderUser(item);
    case 'assistant':
      return renderAssistant(item);
    case 'reasoning':
      return renderReasoning(item);
    case 'plan':
      return renderPlan(item);
    case 'tool':
      return renderTool(item, permMark);
    case 'perm':
      return renderPerm(item);
    case 'agent':
      return renderAgent(item);
    case 'note':
      return renderNote(item);
    default: {
      const _never: never = item;
      return _never;
    }
  }
}

const monoFont = Platform.select({ ios: 'Menlo', default: 'monospace' });

const styles = StyleSheet.create({
  user: {
    alignSelf: 'flex-end',
    maxWidth: '85%',
    backgroundColor: zinc.secondary,
    borderRadius: layout.bubble,
    paddingHorizontal: layout.bubbleX,
    paddingVertical: layout.bubbleY,
    marginTop: 4,
    gap: 6,
  },
  userText: {
    color: zinc.text,
    fontSize: 14,
    lineHeight: 20,
  },
  thumbs: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  assistant: {
    color: zinc.text,
    fontSize: 14,
    lineHeight: 21,
  },
  reasoning: {
    color: zinc.faint,
    fontSize: 12,
    lineHeight: 17,
  },
  plan: {
    gap: 3,
    paddingLeft: 8,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: zinc.border,
  },
  planEntry: {
    fontSize: 12.5,
    lineHeight: 18,
  },
  toolRow: {
    paddingVertical: 2,
    paddingHorizontal: 4,
    borderRadius: 5,
  },
  toolRowError: {
    backgroundColor: zinc.dangerFill,
  },
  toolLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  toolChevron: {
    color: zinc.faint,
    fontSize: 11,
    width: 10,
  },
  toolName: {
    fontSize: 12.5,
    lineHeight: 17,
  },
  toolSummary: {
    flex: 1,
    color: zinc.muted,
    fontSize: 12,
    lineHeight: 17,
    fontFamily: monoFont,
  },
  toolOutput: {
    fontSize: 11.5,
    lineHeight: 16,
    fontFamily: monoFont,
    backgroundColor: zinc.chrome,
    borderRadius: 5,
    paddingHorizontal: 8,
    paddingVertical: 6,
    marginTop: 4,
    marginLeft: 16,
  },
  permMark: {
    color: zinc.faint,
    fontSize: 11,
  },
  permCard: {
    backgroundColor: zinc.waitingFill,
    borderColor: zinc.waitingBorder,
    borderWidth: 1,
    borderRadius: layout.bubble,
    paddingHorizontal: layout.bubbleX,
    paddingVertical: layout.bubbleY,
    gap: 6,
  },
  permReason: {
    color: zinc.waiting,
    fontSize: 12.5,
  },
  permActions: {
    flexDirection: 'row',
    gap: 16,
  },
  permAction: {
    color: zinc.text,
    fontSize: 13,
    fontWeight: '600',
  },
  note: {
    fontSize: 11.5,
    lineHeight: 16,
    fontFamily: monoFont,
    paddingHorizontal: 4,
  },
});
