import AsyncStorage from '@react-native-async-storage/async-storage';
import type { CatalogChat, LiveEvent, SessionId } from './chat';
import { decodeTicket } from '../../src/shared/phone-ticket.js';

type Upsert = Extract<LiveEvent, { readonly type: 'upsert' }>;
type Decide = Extract<LiveEvent, { readonly type: 'decide' }>;
type LiveItem = Upsert['item'];
type ItemId = Decide['itemId'];
type PermVerdict = Decide['verdict'];
type ToolItem = Extract<LiveItem, { readonly kind: 'tool' }>;
type ToolState = ToolItem['state'];
type AgentItem = Extract<LiveItem, { readonly kind: 'agent' }>;
type AgentStatus = AgentItem['status'];
type PlanStatus = Extract<LiveItem, { readonly kind: 'plan' }>['entries'][number]['status'];

type OpenBlock = {
  id: string;
  kind: 'assistant' | 'reasoning';
  text: string;
  pushed: boolean;
};

type Stream = {
  parent: ItemId | null;
  open: OpenBlock | null;
  seen: Set<string>;
};

type ToolSnap = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  state: ToolState;
  output?: string;
  parent: ItemId | null;
  at: number;
  end?: number;
  agent: boolean;
  agentType: string;
  description: string;
  status: AgentStatus;
  tools: number;
  ms: number;
};

type SessionFold = {
  streams: Map<string, Stream>;
  tools: Map<string, ToolSnap>;
};

type SendJob = {
  nonce: string;
  text: string;
  session: SessionId;
  attempts: number;
  sentOnThisSocket: boolean;
};

type DecideJob = {
  session: SessionId;
  id: ItemId;
  verdict: PermVerdict;
  sentOnThisSocket: boolean;
};

const HAS_FINAL_ANSWER_TAG = /<\/?final_answer>/i;
const FINAL_ANSWER_TAG = /<\/?final_answer>/gi;
const FILE_REFERENCE = /^\/?[\w.@+-]+(?:\/[\w.@+-]+)+(?::\d+(?:-\d+)?)?$/;

let seq = 0;
let started = false;
let authed = false;
let hadAuth = false;
let authFailed = false;
let wasDown = false;
let delayMs = 1000;
let retry: ReturnType<typeof setTimeout> | null = null;
let socket: WebSocket | null = null;
let apply: ((event: LiveEvent) => void) | null = null;
let lastChat: SessionId | null = null;

const KEY = 'conn.phone.ticket';

export type PhoneStatus = 'pending' | 'empty' | 'bound';
type Ticket = NonNullable<ReturnType<typeof decodeTicket>>;

let binding: Ticket | null = null;
let status: PhoneStatus = 'pending';
let hydrateGen = 0;
const phoneListeners = new Set<(status: PhoneStatus) => void>();
let storageTail: Promise<void> = Promise.resolve();

const cli = new Map<string, string>();
const remote = new Map<string, { resume: string; provider: string }>();
let chatsNonce = 0;
let chatsWait = '';
let transcriptNonce = 0;
const transcriptWait = new Map<string, string>();
const folds = new Map<string, SessionFold>();
const inflight = new Map<string, SendJob>();
const decides = new Map<string, DecideJob>();

function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}${seq}`;
}

// The gate rejects a send whose chat key equals the resume id, so a listed
// chat keeps a prefixed key and stores the desktop id beside it.
function phoneKey(provider: string, id: string): SessionId {
  return `h:${provider}:${id}` as SessionId;
}

function folderName(project: string): string {
  const parts = project.split(/[/\\]/).filter((part) => part !== '');
  return parts.length === 0 ? project : parts[parts.length - 1];
}

function forgetRemote(): void {
  remote.clear();
  transcriptWait.clear();
  for (const key of [...cli.keys()]) {
    if (key.startsWith('h:')) cli.delete(key);
  }
}

function canSend(): boolean {
  return binding !== null && authed && socket !== null && socket.readyState === WebSocket.OPEN;
}

function asSession(raw: string): SessionId {
  return raw as SessionId;
}

function asItem(raw: string): ItemId {
  return raw as ItemId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isVerdict(value: unknown): value is PermVerdict {
  return value === 'allow' || value === 'deny' || value === 'always';
}

function isPlanStatus(value: unknown): value is PlanStatus {
  return value === 'pending' || value === 'in_progress' || value === 'completed';
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) out[key] = entry;
  return out;
}

function isInternalAnswerArtifact(text: string): boolean {
  if (!HAS_FINAL_ANSWER_TAG.test(text)) return false;
  const content = text.replace(FINAL_ANSWER_TAG, '').trim();
  if (!content) return true;
  const references = content.split(/\s+/).filter(Boolean);
  return references.length >= 2 && references.every((reference) => FILE_REFERENCE.test(reference));
}

function emit(event: LiveEvent): void {
  apply?.(event);
}

function note(
  session: SessionId,
  text: string,
  flags: { error?: true; ended?: true; id?: string } = {},
): void {
  const item: LiveItem = {
    id: asItem(flags.id ?? nextId('n')),
    kind: 'note',
    parent: null,
    text,
    ...(flags.error ? { error: true } : {}),
    ...(flags.ended ? { ended: true } : {}),
  };
  emit({ type: 'upsert', session, item });
}

function parentOf(raw: unknown): ItemId | null {
  if (typeof raw !== 'string' || raw === '') return null;
  return asItem(raw);
}

function foldFor(session: SessionId): SessionFold {
  let fold = folds.get(session);
  if (!fold) {
    fold = { streams: new Map(), tools: new Map() };
    folds.set(session, fold);
  }
  return fold;
}

function streamFor(fold: SessionFold, parent: ItemId | null): Stream {
  const key = parent ?? '';
  let stream = fold.streams.get(key);
  if (!stream) {
    stream = { parent, open: null, seen: new Set() };
    fold.streams.set(key, stream);
  }
  return stream;
}

function emitText(session: SessionId, open: OpenBlock, parent: ItemId | null, streaming: boolean): void {
  if (open.kind === 'reasoning') {
    const item: LiveItem = {
      id: asItem(open.id),
      kind: 'reasoning',
      parent,
      text: open.text,
      ...(streaming ? { streaming: true } : {}),
    };
    emit({ type: 'upsert', session, item });
    return;
  }
  const item: LiveItem = {
    id: asItem(open.id),
    kind: 'assistant',
    parent,
    text: open.text,
    ...(streaming ? { streaming: true } : {}),
  };
  emit({ type: 'upsert', session, item });
}

function finishOpen(session: SessionId, stream: Stream): void {
  const open = stream.open;
  if (!open) return;
  stream.open = null;
  if (open.kind === 'reasoning' && !open.pushed) return;
  emitText(session, open, stream.parent, false);
}

function emitTool(session: SessionId, snap: ToolSnap): void {
  if (snap.agent) {
    const item: LiveItem = {
      id: asItem(snap.id),
      kind: 'agent',
      parent: snap.parent,
      name: snap.name,
      agentType: snap.agentType,
      description: snap.description,
      status: snap.status,
      tools: snap.tools,
      ms: snap.ms,
    };
    emit({ type: 'upsert', session, item });
    return;
  }
  const item: LiveItem = {
    id: asItem(snap.id),
    kind: 'tool',
    parent: snap.parent,
    name: snap.name,
    input: snap.input,
    state: snap.state,
    at: snap.at,
    ...(snap.output !== undefined ? { output: snap.output } : {}),
    ...(snap.end !== undefined ? { end: snap.end } : {}),
  };
  emit({ type: 'upsert', session, item });
}

function toolText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') parts.push(part);
    else if (isRecord(part) && typeof part.text === 'string') parts.push(part.text);
  }
  return parts.join('\n');
}

function planStatus(value: unknown): PlanStatus {
  if (value === 'inProgress') return 'in_progress';
  if (isPlanStatus(value)) return value;
  return 'pending';
}

function planOf(input: Record<string, unknown>): {
  entries: { content: string; status: PlanStatus }[];
  explanation?: string;
} | null {
  const todos = input.todos;
  if (!Array.isArray(todos) || todos.length === 0) return null;
  const entries: { content: string; status: PlanStatus }[] = [];
  for (const todo of todos) {
    if (!isRecord(todo) || typeof todo.content !== 'string') continue;
    entries.push({ content: todo.content, status: planStatus(todo.status) });
  }
  if (entries.length === 0) return null;
  const explanation = typeof input.explanation === 'string' && input.explanation.trim() !== ''
    ? input.explanation
    : undefined;
  return explanation ? { entries, explanation } : { entries };
}

function blocksOf(msg: Record<string, unknown>): Record<string, unknown>[] {
  const message = msg.message;
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
  return message.content.filter(isRecord);
}

function onStream(session: SessionId, msg: Record<string, unknown>, stream: Stream): void {
  const ev = msg.event;
  if (!isRecord(ev) || typeof ev.type !== 'string') return;
  const block = isRecord(ev.content_block) ? ev.content_block : null;
  const blockType = block && typeof block.type === 'string' ? block.type : '';
  const delta = isRecord(ev.delta) ? ev.delta : null;
  if (ev.type === 'content_block_start' && blockType === 'text') {
    finishOpen(session, stream);
    stream.open = { id: nextId('a'), kind: 'assistant', text: '', pushed: true };
    emitText(session, stream.open, stream.parent, true);
    return;
  }
  if (ev.type === 'content_block_start' && blockType === 'thinking') {
    finishOpen(session, stream);
    stream.open = { id: nextId('r'), kind: 'reasoning', text: '', pushed: false };
    return;
  }
  if (ev.type === 'content_block_delta' && delta?.type === 'text_delta' && stream.open?.kind === 'assistant') {
    stream.open.text += typeof delta.text === 'string' ? delta.text : '';
    emitText(session, stream.open, stream.parent, true);
    return;
  }
  const thinking = delta && typeof delta.thinking === 'string' ? delta.thinking : '';
  if (
    ev.type === 'content_block_delta'
    && delta?.type === 'thinking_delta'
    && stream.open?.kind === 'reasoning'
    && thinking !== ''
    && (stream.open.pushed || thinking.trim() !== '')
  ) {
    if (!stream.open.pushed) stream.open.pushed = true;
    stream.open.text += thinking;
    emitText(session, stream.open, stream.parent, true);
    return;
  }
  if (ev.type === 'content_block_stop' && stream.open) {
    if (stream.open.kind === 'assistant') {
      emitText(session, stream.open, stream.parent, false);
      stream.open = null;
      return;
    }
    finishOpen(session, stream);
  }
}

function onAssistant(session: SessionId, msg: Record<string, unknown>, fold: SessionFold, stream: Stream): void {
  if (msg.error) {
    const text = blocksOf(msg).map((block) => (typeof block.text === 'string' ? block.text : '')).join('\n').trim();
    note(session, text || errorText(msg.error), { error: true });
    return;
  }
  const blocks = blocksOf(msg);
  if (
    blocks.some((block) => block.type === 'tool_use' || block.type === 'text')
    && stream.open?.kind === 'reasoning'
  ) finishOpen(session, stream);
  for (const block of blocks) {
    if (block.type === 'tool_use') {
      const name = typeof block.name === 'string' ? block.name : 'tool';
      const input = record(block.input);
      const planned = name === 'TodoWrite' ? planOf(input) : null;
      if (planned) {
        const item: LiveItem = {
          id: asItem(`plan:${stream.parent ?? 'root'}`),
          kind: 'plan',
          parent: stream.parent,
          entries: planned.entries,
          ...(planned.explanation ? { explanation: planned.explanation } : {}),
        };
        emit({ type: 'upsert', session, item });
        continue;
      }
      const id = typeof block.id === 'string' && block.id !== '' ? block.id : nextId('tool');
      const agent = name === 'Agent' || name === 'Task';
      const description = typeof input.description === 'string' ? input.description : '';
      const agentType = typeof input.subagent_type === 'string' ? input.subagent_type : 'agent';
      const snap: ToolSnap = {
        id,
        name,
        input,
        state: 'input-available',
        parent: stream.parent,
        at: Date.now(),
        agent,
        agentType,
        description,
        status: 'running',
        tools: 0,
        ms: 0,
      };
      fold.tools.set(id, snap);
      emitTool(session, snap);
      continue;
    }
    if (block.type !== 'text' || typeof block.text !== 'string') continue;
    if (stream.open?.kind === 'assistant' || isInternalAnswerArtifact(block.text)) continue;
    const key = block.text.slice(0, 80);
    if (stream.seen.has(key)) continue;
    if (stream.seen.size >= 200) stream.seen.clear();
    stream.seen.add(key);
    emitText(session, { id: nextId('t'), kind: 'assistant', text: block.text, pushed: true }, stream.parent, false);
  }
}

function onUser(session: SessionId, msg: Record<string, unknown>, fold: SessionFold): void {
  for (const block of blocksOf(msg)) {
    if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
    const snap = fold.tools.get(block.tool_use_id);
    if (!snap) continue;
    const failed = block.is_error === true;
    snap.state = failed ? 'output-error' : 'output-available';
    snap.output = toolText(block.content);
    snap.end = Date.now();
    if (snap.agent) snap.status = failed ? 'error' : 'done';
    emitTool(session, snap);
  }
}

function onResult(session: SessionId, msg: Record<string, unknown>, fold: SessionFold): void {
  for (const stream of fold.streams.values()) finishOpen(session, stream);
  const subtype = typeof msg.subtype === 'string' ? msg.subtype : '';
  const failed = msg.is_error === true || (subtype !== '' && subtype !== 'success');
  const secs = typeof msg.duration_ms === 'number' ? `${(msg.duration_ms / 1000).toFixed(1)}s` : '';
  const text = failed ? `turn ended: ${subtype || 'error'} ${secs}`.trim() : `done in ${secs}`.trim();
  note(session, text, failed ? { error: true, ended: true } : { ended: true });
}

function foldMessage(session: SessionId, msg: Record<string, unknown>): void {
  const fold = foldFor(session);
  const stream = streamFor(fold, parentOf(msg.parent_tool_use_id));
  if (msg.type === 'stream_event') {
    onStream(session, msg, stream);
    return;
  }
  if (msg.type === 'tool_input' && typeof msg.tool_use_id === 'string' && isRecord(msg.input)) {
    const snap = fold.tools.get(msg.tool_use_id);
    if (!snap) return;
    snap.input = { ...snap.input, ...record(msg.input) };
    emitTool(session, snap);
    return;
  }
  if (msg.type === 'assistant') {
    onAssistant(session, msg, fold, stream);
    return;
  }
  if (msg.type === 'user') {
    onUser(session, msg, fold);
    return;
  }
  if (msg.type === 'result') onResult(session, msg, fold);
}

function errorText(error: unknown): string {
  if (typeof error === 'string' && error !== '') return error;
  if (isRecord(error) && typeof error.message === 'string' && error.message !== '') return error.message;
  return 'the turn failed';
}

function onPermission(session: SessionId, payload: Record<string, unknown>): void {
  if (typeof payload.id !== 'string' || payload.id === '') return;
  const tool = typeof payload.tool === 'string' && payload.tool !== '' ? payload.tool : 'tool';
  const title = typeof payload.title === 'string' && payload.title !== '' ? payload.title : `Allow ${tool}?`;
  const reason = typeof payload.reason === 'string' && payload.reason !== '' ? payload.reason : undefined;
  const askedBy = isRecord(payload.agent) && typeof payload.agent.label === 'string' && payload.agent.label !== ''
    ? payload.agent.label
    : undefined;
  const item: LiveItem = {
    id: asItem(payload.id),
    kind: 'perm',
    parent: null,
    tool,
    title,
    input: record(payload.input),
    forId: parentOf(payload.forId),
    ...(reason ? { reason } : {}),
    ...(askedBy ? { askedBy } : {}),
  };
  emit({ type: 'upsert', session, item });
}

function onLive(frame: Record<string, unknown>): void {
  if (typeof frame.channel !== 'string' || !isRecord(frame.payload)) return;
  const payload = frame.payload;
  const chat = typeof payload.chat === 'string' ? payload.chat : '';
  if (chat === '') return;
  const session = asSession(chat);
  switch (frame.channel) {
    case 'agent:message':
      if (isRecord(payload.msg)) {
        if (
          payload.msg.type === 'system'
          && payload.msg.subtype === 'init'
          && typeof payload.msg.session_id === 'string'
          && payload.msg.session_id !== ''
        ) {
          cli.set(session, payload.msg.session_id);
        }
        foldMessage(session, payload.msg);
      }
      return;
    case 'agent:permission':
      onPermission(session, payload);
      return;
    case 'agent:ready':
      if (typeof payload.sessionId === 'string' && payload.sessionId !== '') cli.set(session, payload.sessionId);
      return;
    case 'agent:decided':
      if (typeof payload.id === 'string' && payload.id !== '' && isVerdict(payload.decision)) {
        emit({ type: 'decide', session, itemId: asItem(payload.id), verdict: payload.decision });
      }
      return;
    case 'agent:error':
      note(session, errorText(payload.error), { error: true, ended: true });
      return;
    case 'agent:closed':
      note(session, 'the session ended', { id: 'closed' });
      return;
    default:
      return;
  }
}

function rememberCli(session: SessionId, sessionId: unknown): void {
  if (typeof sessionId === 'string' && sessionId !== '') cli.set(session, sessionId);
}

function onAck(frame: Record<string, unknown>): void {
  if (frame.of === 'auth') {
    authed = true;
    hadAuth = true;
    authFailed = false;
    delayMs = 1000;
    const down = wasDown;
    wasDown = false;
    flush();
    refreshChats();
    if (down && lastChat) note(lastChat, 'reconnected to Conn');
    return;
  }
  if (frame.of === 'chats') {
    onChats(frame);
    return;
  }
  if (frame.of === 'transcript') {
    onTranscript(frame);
    return;
  }
  if (frame.of === 'send') {
    const chat = typeof frame.chat === 'string' ? frame.chat : '';
    if (chat === '') return;
    const session = asSession(chat);
    const job = inflight.get(session);
    const nonce = typeof frame.nonce === 'string' ? frame.nonce : '';
    if (job && nonce !== '' && job.nonce !== nonce) return;
    if (typeof frame.error === 'string') {
      inflight.delete(session);
      note(session, frame.error, { error: true });
      return;
    }
    if (frame.ok === true) {
      inflight.delete(session);
      rememberCli(session, frame.sessionId);
    }
    return;
  }
  if (frame.of !== 'decide') return;
  const chat = typeof frame.chat === 'string' ? frame.chat : '';
  const id = typeof frame.id === 'string' ? frame.id : '';
  if (chat === '' || id === '') return;
  decides.delete(`${chat}\0${id}`);
  if (typeof frame.error === 'string') note(asSession(chat), frame.error, { error: true });
}

function onChats(frame: Record<string, unknown>): void {
  const nonce = typeof frame.nonce === 'string' ? frame.nonce : '';
  if (nonce === '' || nonce !== chatsWait || !binding) return;
  if (typeof frame.error === 'string' || !Array.isArray(frame.chats)) return;
  const folder = typeof frame.folder === 'string' && frame.folder !== '' ? frame.folder : folderName(binding.project);
  const seen = new Set<string>();
  const chats: CatalogChat[] = [];
  for (const row of frame.chats) {
    if (!isRecord(row) || typeof row.id !== 'string' || row.id === '' || typeof row.provider !== 'string' || row.provider === '') {
      continue;
    }
    const id = phoneKey(row.provider, row.id);
    if (seen.has(id)) continue;
    seen.add(id);
    const title = typeof row.title === 'string' && row.title.trim() !== '' ? row.title : 'Chat';
    const at = typeof row.at === 'number' ? row.at : Date.now();
    remote.set(id, { resume: row.id, provider: row.provider });
    cli.set(id, row.id);
    chats.push({ id, title, at, provider: row.provider, resume: row.id });
  }
  const stale = [...remote.keys()].filter((key) => !seen.has(key));
  for (const key of stale) {
    remote.delete(key);
    cli.delete(key);
    transcriptWait.delete(key);
  }
  emit({ type: 'catalog', folder, chats });
}

function onTranscript(frame: Record<string, unknown>): void {
  const nonce = typeof frame.nonce === 'string' ? frame.nonce : '';
  const id = typeof frame.id === 'string' ? frame.id : '';
  if (nonce === '' || id === '') return;
  let session: SessionId | null = null;
  for (const [key, row] of remote) {
    if (row.resume === id && transcriptWait.get(key) === nonce) session = key as SessionId;
  }
  if (session === null) return;
  transcriptWait.delete(session);
  if (typeof frame.error === 'string') {
    note(session, frame.error, { error: true, id: 'transcript' });
    return;
  }
  if (!Array.isArray(frame.messages)) return;
  emit({ type: 'transcript', session, messages: frame.messages });
}

function onFrame(raw: unknown): void {
  if (!isRecord(raw) || typeof raw.op !== 'string') return;
  if (raw.op === 'ack') onAck(raw);
  else if (raw.op === 'live') onLive(raw);
  else if (raw.op === 'reject') {
    authFailed = true;
    authed = false;
    if (lastChat) note(lastChat, 'The mobile gate rejected the token.', { error: true, id: 'gate-auth' });
  }
}

function enqueueStorage<T>(op: () => Promise<T>): Promise<T> {
  const run = storageTail.then(op, op);
  storageTail = run.then(() => undefined, () => undefined);
  return run;
}

function emitPhone(next: PhoneStatus): void {
  status = next;
  for (const cb of phoneListeners) cb(next);
}

export function onPhone(cb: (status: PhoneStatus) => void): () => void {
  cb(status);
  phoneListeners.add(cb);
  return () => { phoneListeners.delete(cb); };
}

function flush(): void {
  if (!binding || !authed || !socket || socket.readyState !== WebSocket.OPEN) return;
  const ws = socket;
  for (const [key, job] of inflight) {
    if (job.sentOnThisSocket) continue;
    if (job.attempts >= 2) {
      inflight.delete(key);
      note(job.session, 'the turn did not reach Conn', { error: true });
      continue;
    }
    job.sentOnThisSocket = true;
    job.attempts += 1;
    const cliSession = cli.get(job.session) ?? null;
    ws.send(JSON.stringify({
      op: 'send',
      chat: job.session,
      text: job.text,
      project: binding.project,
      session: cliSession,
      nonce: job.nonce,
    }));
  }
  for (const job of decides.values()) {
    if (job.sentOnThisSocket) continue;
    job.sentOnThisSocket = true;
    ws.send(JSON.stringify({
      op: 'decide',
      chat: job.session,
      id: job.id,
      decision: job.verdict,
    }));
  }
}

function clearRetry(): void {
  if (retry === null) return;
  clearTimeout(retry);
  retry = null;
}

function scheduleReconnect(): void {
  if (retry !== null || authFailed) return;
  retry = setTimeout(() => {
    retry = null;
    openSocket();
  }, delayMs);
  delayMs = Math.min(delayMs * 2, 10_000);
}

function markUnsent(): void {
  for (const job of inflight.values()) job.sentOnThisSocket = false;
  for (const job of decides.values()) job.sentOnThisSocket = false;
}

function openSocket(): void {
  if (!binding || authFailed) return;
  if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) return;
  clearRetry();
  const ticket = binding;
  const ws = new WebSocket(ticket.url);
  socket = ws;
  authed = false;
  markUnsent();
  ws.onopen = () => {
    if (socket !== ws) return;
    ws.send(JSON.stringify({ op: 'auth', token: ticket.token }));
  };
  ws.onmessage = (event: MessageEvent) => {
    if (socket !== ws || typeof event.data !== 'string') return;
    try {
      onFrame(JSON.parse(event.data));
    } catch {
      return;
    }
  };
  ws.onerror = () => {
    if (socket === ws) ws.close();
  };
  ws.onclose = (event: CloseEvent) => {
    if (socket !== ws) return;
    socket = null;
    authed = false;
    if (authFailed) return;
    if (event.code === 4000 && event.reason === 'replaced') {
      if (lastChat) {
        note(lastChat, 'Another phone took the mobile gate.', { error: true, id: 'gate-link' });
      }
      return;
    }
    if (hadAuth) {
      wasDown = true;
      if (lastChat) note(lastChat, 'the link to Conn dropped', { error: true, id: 'gate-link' });
    } else if (lastChat) {
      note(lastChat, 'Conn is not reachable.', { error: true, id: 'gate-link' });
    }
    scheduleReconnect();
  };
}

export function foldLiveMessage(payload: Record<string, unknown>): void {
  onLive({ channel: 'agent:message', payload });
}

export function attachLive(next: (event: LiveEvent) => void): void {
  apply = next;
}

async function hydrate(): Promise<void> {
  const gen = ++hydrateGen;
  const raw = await enqueueStorage(() => AsyncStorage.getItem(KEY));
  if (gen !== hydrateGen) return;
  const next = typeof raw === 'string' ? decodeTicket(raw) : null;
  if (raw && !next) {
    if (gen !== hydrateGen) return;
    await enqueueStorage(() => AsyncStorage.removeItem(KEY));
    if (gen !== hydrateGen) return;
  }
  if (gen !== hydrateGen) return;
  binding = next;
  emitPhone(next ? 'bound' : 'empty');
  if (next) openSocket();
}

function replaceSocket(): void {
  clearRetry();
  authFailed = false;
  const old = socket;
  socket = null;
  if (old && old.readyState !== WebSocket.CLOSED) old.close();
  openSocket();
}

export function adoptTicket(raw: string): Promise<boolean> {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const next = decodeTicket(text);
  if (!next) return Promise.resolve(false);
  const gen = ++hydrateGen;
  return enqueueStorage(() => AsyncStorage.setItem(KEY, text)).then(() => {
    if (gen !== hydrateGen) return false;
    binding = next;
    emitPhone('bound');
    forgetRemote();
    emit({ type: 'catalog', folder: folderName(next.project), chats: [] });
    replaceSocket();
    return true;
  });
}

export function connectLive(): void {
  const first = !started;
  started = true;
  authFailed = false;
  if (first) {
    void hydrate();
    return;
  }
  if (binding) openSocket();
}

export function resumeLive(): void {
  if (!started) return;
  authFailed = false;
  openSocket();
  refreshChats();
}

export function refreshChats(): void {
  if (!canSend() || !binding || !socket) return;
  chatsNonce += 1;
  chatsWait = String(chatsNonce);
  socket.send(JSON.stringify({ op: 'chats', project: binding.project, nonce: chatsWait }));
}

export function requestTranscript(session: SessionId): void {
  const row = remote.get(session);
  if (!row || !canSend() || !binding || !socket) return;
  transcriptNonce += 1;
  const nonce = String(transcriptNonce);
  transcriptWait.set(session, nonce);
  socket.send(JSON.stringify({
    op: 'transcript',
    project: binding.project,
    id: row.resume,
    provider: row.provider,
    nonce,
  }));
}

function tokenRejected(session: SessionId): boolean {
  if (!authFailed) return false;
  note(session, 'The mobile gate rejected the token.', { error: true, id: 'gate-auth' });
  return true;
}

export function sendTurn(session: SessionId, text: string): Promise<void> {
  lastChat = session;
  if (!started) return Promise.resolve();
  if (tokenRejected(session)) return Promise.resolve();
  if (!binding) {
    note(session, 'Scan the code in Conn on your computer.', { error: true, id: 'gate-project' });
    return Promise.resolve();
  }
  inflight.set(session, {
    nonce: nextId('n'),
    text,
    session,
    attempts: 0,
    sentOnThisSocket: false,
  });
  flush();
  return Promise.resolve();
}

export function decidePerm(session: SessionId, id: ItemId, verdict: PermVerdict): Promise<void> {
  lastChat = session;
  if (!started) return Promise.resolve();
  if (tokenRejected(session)) return Promise.resolve();
  decides.set(`${session}\0${id}`, {
    session,
    id,
    verdict,
    sentOnThisSocket: false,
  });
  flush();
  return Promise.resolve();
}
