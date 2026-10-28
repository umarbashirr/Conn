/* Only text is kept. A pasted image rides in the draft as a base64 data URL,
   and localStorage holds about 5 MB per origin. An empty draft is not stored. */

const STORE_KEY = 'conn.drafts';
const WAIT_MS = 400;

export const storageKeyOf = (chat) => chat?.session || (chat?.project ? `new:${chat.project}` : null);

// Two unsent chats in one folder map to the same key, and only the first one
// open owns it.
export function ownedStorageKey(chats, chat) {
  const key = storageKeyOf(chat);
  return key && chats.find((c) => storageKeyOf(c) === key)?.key === chat.key ? key : null;
}

// A rail row for a chat never opened in this window is named by its session id.
export function storageKeyOfRow(chats, row) {
  const open = chats.find((c) => c.key === row.key);
  return open ? ownedStorageKey(chats, open) : row.id;
}

export function createDrafts({
  storage = () => globalThis.localStorage,
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) {
  let all = null;
  let timer = null;

  const load = () => {
    if (all) return all;
    all = {};
    try {
      const saved = JSON.parse(storage().getItem(STORE_KEY));
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        for (const [k, v] of Object.entries(saved)) if (typeof v === 'string') all[k] = v;
      }
    } catch {}
    return all;
  };

  const flushDrafts = () => {
    if (timer === null) return;
    cancel(timer);
    timer = null;
    try {
      storage().setItem(STORE_KEY, JSON.stringify(all));
    } catch {}
  };

  const save = () => {
    if (timer !== null) cancel(timer);
    timer = schedule(flushDrafts, WAIT_MS);
  };

  return {
    flushDrafts,
    readDraft: (key) => (key ? load()[key] || '' : ''),
    writeDraft(key, text) {
      if (!key) return;
      const drafts = load();
      const next = text.trim() ? text : '';
      if ((drafts[key] || '') === next) return;
      if (next) drafts[key] = next;
      else delete drafts[key];
      save();
    },
    moveDraft(from, to) {
      if (!from || !to || from === to) return;
      const drafts = load();
      if (!(from in drafts)) return;
      drafts[to] = drafts[from];
      delete drafts[from];
      save();
    },
    dropDraft(key) {
      if (!key || !(key in load())) return;
      delete all[key];
      save();
    },
  };
}

const drafts = createDrafts();
export const { readDraft, writeDraft, moveDraft, dropDraft, flushDrafts } = drafts;

globalThis.addEventListener?.('pagehide', flushDrafts);
