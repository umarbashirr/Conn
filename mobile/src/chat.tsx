import { useState, useSyncExternalStore, type ReactElement } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { attachLive, decidePerm, sendTurn } from './conn-live';
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

type UserItem = ItemBase & {
  readonly kind: 'user';
  readonly text: string;
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

type PermItem = ItemBase & {
  readonly kind: 'perm';
  readonly tool: string;
  readonly title: string;
  readonly input: Readonly<Record<string, unknown>>;
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
};

type ChatState = {
  readonly labeledAt: number;
  readonly seq: number;
  readonly sessions: readonly Session[];
  readonly itemsBySession: Readonly<Record<string, readonly Item[]>>;
  readonly draftBySession: Readonly<Record<string, string>>;
  readonly activeId: SessionId | null;
  readonly query: string;
};

type ChatEvent =
  | { readonly type: 'open'; readonly id: SessionId }
  | { readonly type: 'back' }
  | { readonly type: 'new-chat' }
  | { readonly type: 'query'; readonly text: string }
  | { readonly type: 'draft'; readonly text: string }
  | { readonly type: 'send' };

export type LiveEvent =
  | { readonly type: 'upsert'; readonly session: SessionId; readonly item: LiveItem }
  | { readonly type: 'decide'; readonly session: SessionId; readonly itemId: ItemId; readonly verdict: PermVerdict };

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

const id1 = sessionId('s1');
const id2 = sessionId('s2');
const id3 = sessionId('s3');

function userItem(id: string, text: string): UserItem {
  return { id: itemId(id), kind: 'user', parent: null, text };
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

function noteItem(id: string, text: string, flags: { error?: true; ended?: true }): NoteItem {
  return { id: itemId(id), kind: 'note', parent: null, text, ...flags };
}

const INITIAL: ChatState = {
  labeledAt: SEEDED_AT,
  seq: 4,
  activeId: null,
  query: '',
  sessions: [
    { id: id1, title: 'Zinc tokens', at: SEEDED_AT - 3_600_000, provider: 'Claude', project: 'conn' },
    { id: id2, title: 'Empty draft', at: SEEDED_AT - 86_400_000, provider: 'Codex', project: 'conn' },
    { id: id3, title: 'Field notes', at: SEEDED_AT - 600_000, provider: 'Claude', project: 'notes' },
  ],
  itemsBySession: {
    [id1]: [
      userItem('s1-u', 'Where do the zinc colors live?'),
      assistantItem('s1-a', 'In the desktop dark theme, ground is #141414.'),
      toolItem('s1-t', 'Read', 'output-available', { file_path: 'src/renderer/styles.css' }, '--background: 0 0% 8%'),
      noteItem('s1-n', 'done in 1.2s', { ended: true }),
    ],
    [id2]: [],
    [id3]: [
      userItem('s3-u', 'Summarize the open thread'),
      assistantItem('s3-a', 'Two notes, one failed lookup.'),
      toolItem('s3-t', 'Grep', 'output-error', { pattern: 'zinc' }, 'permission denied'),
      noteItem('s3-n', 'could not read the index', { error: true }),
    ],
  },
  draftBySession: { [id1]: '', [id2]: '', [id3]: '' },
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
    draft,
    canSend: draft.trim().length > 0,
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
    if (item.kind !== 'perm' || !item.decided || item.answers || item.tool === 'AskUserQuestion') continue;
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
  const shift = now - state.labeledAt;
  return {
    ...state,
    labeledAt: now,
    sessions: state.sessions.map((session) => ({ ...session, at: session.at + shift })),
  };
}

function startChat(state: ChatState, now: number): ChatState {
  const existing = state.sessions.find(
    (session) =>
      session.project === DRAFT_PROJECT &&
      session.title === NEW_TITLE &&
      state.itemsBySession[session.id].length === 0 &&
      state.draftBySession[session.id] === '',
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
      { id, title: NEW_TITLE, at: now, provider: '', project: DRAFT_PROJECT },
    ],
    itemsBySession: { ...clocked.itemsBySession, [id]: [] },
    draftBySession: { ...clocked.draftBySession, [id]: '' },
  };
}

function writeDraft(state: ChatState, text: string): ChatState {
  const id = state.activeId;
  if (id === null || state.draftBySession[id] === text) return state;
  return { ...state, draftBySession: { ...state.draftBySession, [id]: text } };
}

function sendDraft(state: ChatState, now: number): ChatState {
  const id = state.activeId;
  if (id === null) return state;
  const text = state.draftBySession[id].trim();
  if (text === '') return state;
  const clocked = withClock(state, now);
  return {
    ...clocked,
    seq: clocked.seq + 1,
    sessions: clocked.sessions.map((session) => (session.id === id ? { ...session, at: now } : session)),
    itemsBySession: {
      ...clocked.itemsBySession,
      [id]: [...clocked.itemsBySession[id], userItem(`u${clocked.seq}`, text)],
    },
    draftBySession: { ...clocked.draftBySession, [id]: '' },
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
      { id: session, title: NEW_TITLE, at: now, provider: 'Claude', project: DRAFT_PROJECT },
    ],
    itemsBySession: { ...state.itemsBySession, [session]: [] },
    draftBySession: { ...state.draftBySession, [session]: '' },
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

function markPerm(state: ChatState, session: SessionId, target: ItemId, verdict: PermVerdict): ChatState {
  if (!state.sessions.some((entry) => entry.id === session)) return state;
  const items = state.itemsBySession[session];
  const index = items.findIndex((entry) => entry.id === target);
  if (index === -1) return state;
  const current = items[index];
  if (current.kind !== 'perm' || current.decided === verdict) return state;
  const next = items.slice();
  next[index] = { ...current, decided: verdict };
  return { ...state, itemsBySession: { ...state.itemsBySession, [session]: next } };
}

function reduceLive(state: ChatState, event: LiveEvent, now: number): ChatState {
  switch (event.type) {
    case 'upsert':
      return upsertItem(state, event.session, event.item, now);
    case 'decide':
      return markPerm(state, event.session, event.itemId, event.verdict);
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
  },
  open(id: SessionId): void {
    dispatch({ type: 'open', id });
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
  send(): void {
    const id = state.activeId;
    const text = id === null ? '' : state.draftBySession[id].trim();
    dispatch({ type: 'send' });
    if (id !== null && text !== '') void sendTurn(id, text);
  },
};

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

function renderUser(item: UserItem): ReactElement {
  return (
    <View style={styles.user}>
      <Text style={styles.userText} selectable>
        {item.text}
      </Text>
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
  void decidePerm(session, target, verdict);
}

function PermCard({ item }: { item: PermItem }) {
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
  },
  userText: {
    color: zinc.text,
    fontSize: 14,
    lineHeight: 20,
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
