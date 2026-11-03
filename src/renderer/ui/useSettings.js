import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

const conn = () => window.conn;

// The settings file, and the two update checks that hang off it. Main owns
// both; everything here is a mirror that main corrects. Every setter goes
// through main rather than changing local state first, so the file and the
// window can never disagree about what was saved.
export function useSettings() {
  const [data, setData] = useState(() => {
    try { return conn().settings.snapshot(); } catch { return null; }
  });

  useEffect(() => {
    conn().settings.get().then(setData).catch(() => {});
    return conn().settings.onChanged((next) => { if (next) setData(next); });
  }, []);

  const set = useCallback(async (partial) => {
    const next = await conn().settings.set(partial);
    if (next) setData(next);
    return next;
  }, []);

  const reset = useCallback(async () => {
    const next = await conn().settings.reset();
    if (next) setData(next);
    return next;
  }, []);

  return { settings: data, set, reset };
}

const NO_UPDATES = {
  app: { current: '', latest: null, behind: false },
  claude: { running: null, path: null, version: null, latest: null, behind: false, missing: false },
  codex: { running: null, path: null, version: null, latest: null, behind: false, missing: false },
  cursor: { running: null, path: null, version: null, latest: null, behind: false, missing: false },
  grok: { running: null, path: null, version: null, latest: null, behind: false, missing: false },
  copilot: { running: null, path: null, version: null, latest: null, behind: false, missing: false },
  opencode: { running: null, path: null, version: null, latest: null, behind: false, missing: false },
  kind: 'dev',
  checkedAt: null,
  error: null,
  restart: { running: '', installed: null, kind: 'dev', ready: false },
};

const updateListeners = new Set();
let updateState = {
  ...NO_UPDATES,
  checking: false,
  progress: null,
  file: null,
  installing: false,
  installed: false,
  error: null,
};
let updateEventsStarted = false;

const notifyUpdates = () => updateListeners.forEach((listener) => listener());
const setUpdateState = (patch) => {
  updateState = { ...updateState, ...patch };
  notifyUpdates();
};
const subscribeUpdates = (listener) => {
  updateListeners.add(listener);
  return () => updateListeners.delete(listener);
};
const getUpdateState = () => updateState;

export function useUpdates() {
  const state = useSyncExternalStore(subscribeUpdates, getUpdateState, getUpdateState);

  useEffect(() => {
    if (updateEventsStarted) return;
    updateEventsStarted = true;
    conn().updates.info().then((v) => v && setUpdateState(v)).catch(() => {});
    conn().updates.onChanged((v) => { if (v) setUpdateState(v); });
    conn().updates.onProgress((progress) => setUpdateState({ progress }));
  }, []);

  const check = useCallback(async () => {
    setUpdateState({ checking: true, error: null });
    try {
      const next = await conn().updates.check();
      if (next) setUpdateState(next);
      return next;
    } catch (e) {
      setUpdateState({ error: e.message });
      return null;
    } finally {
      setUpdateState({ checking: false });
    }
  }, []);

  // A quarter of a gigabyte over a home connection, so this is deliberately two
  // steps: fetch, then hand the file to the installer when the person says so.
  const download = useCallback(async () => {
    setUpdateState({
      error: null,
      progress: { received: 0, total: updateState.app?.asset?.size || 0, done: false },
    });
    try {
      const res = await conn().updates.download();
      if (res?.error) {
        setUpdateState({ error: res.error });
        return null;
      }
      setUpdateState({ file: res.path });
      return res.path;
    } catch (e) {
      setUpdateState({ error: e.message });
      return null;
    } finally {
      setUpdateState({ progress: null });
    }
  }, []);

  // apt unpacking a quarter of a gigabyte takes long enough that a button which
  // does nothing visible reads as a button that did nothing.
  const install = useCallback(async (target) => {
    setUpdateState({ error: null, installing: true });
    try {
      const res = await conn().updates.install(target || updateState.file);
      if (res?.error) setUpdateState({ error: res.error });
      else if (res?.action === 'installed') setUpdateState({ installed: true });
      return res;
    } finally {
      setUpdateState({ installing: false });
    }
  }, []);

  return {
    ...state,
    error: state.error || null,
    check,
    download,
    install,
    openPage: () => conn().updates.openPage(),
    relaunch: () => conn().updates.relaunch(),
  };
}
