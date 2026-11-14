import { useSyncExternalStore } from 'react';
import { Appearance, type TextStyle } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

type Palette = {
  ground: string;
  text: string;
  muted: string;
  faint: string;
  border: string;
  secondary: string;
  input: string;
  chrome: string;
  raised: string;
  accent: string;
  accentText: string;
  send: string;
  sendGlyph: string;
  working: string;
  workingFill: string;
  waiting: string;
  waitingBorder: string;
  waitingFill: string;
  finished: string;
  danger: string;
  dangerFill: string;
  scrim: string;
};

const dark: Palette = {
  ground: '#0F0F10',
  text: '#F2F2F3',
  muted: '#A1A1A6',
  faint: '#6E6E73',
  border: '#2A2A2D',
  secondary: '#232326',
  input: '#18181A',
  chrome: '#141415',
  raised: '#1A1A1C',
  accent: '#E8743B',
  accentText: '#FFFFFF',
  send: '#F2F2F3',
  sendGlyph: '#111112',
  working: '#3DD598',
  workingFill: 'rgba(61, 213, 152, 0.12)',
  waiting: '#F5B544',
  waitingBorder: 'rgba(245, 181, 68, 0.32)',
  waitingFill: 'rgba(245, 181, 68, 0.08)',
  finished: '#2DD4AE',
  danger: '#F05252',
  dangerFill: 'rgba(240, 82, 82, 0.10)',
  scrim: 'rgba(0, 0, 0, 0.55)',
};

const light: Palette = {
  ground: '#F6F6F4',
  text: '#18181B',
  muted: '#55555C',
  faint: '#8A8A90',
  border: '#E3E3E0',
  secondary: '#ECECE9',
  input: '#FFFFFF',
  chrome: '#FFFFFF',
  raised: '#FFFFFF',
  accent: '#D9622B',
  accentText: '#FFFFFF',
  send: '#18181B',
  sendGlyph: '#FFFFFF',
  working: '#12A36E',
  workingFill: 'rgba(18, 163, 110, 0.10)',
  waiting: '#B87400',
  waitingBorder: 'rgba(184, 116, 0, 0.30)',
  waitingFill: 'rgba(245, 181, 68, 0.12)',
  finished: '#0F9C7B',
  danger: '#D93636',
  dangerFill: 'rgba(217, 54, 54, 0.08)',
  scrim: 'rgba(0, 0, 0, 0.35)',
};

export type Appearance = 'system' | 'light' | 'dark';
export type Scheme = 'light' | 'dark';

const KEY = 'conn.appearance';
let choice: Appearance = 'system';
let scheme: Scheme = resolve();
let version = 0;
const listeners = new Set<() => void>();

function resolve(): Scheme {
  if (choice !== 'system') return choice;
  return Appearance.getColorScheme() === 'light' ? 'light' : 'dark';
}

function apply(): void {
  const next = resolve();
  if (next === scheme) return;
  scheme = next;
  version += 1;
  for (const cb of listeners) cb();
}

Appearance.addChangeListener(apply);
void AsyncStorage.getItem(KEY).then((saved) => {
  if (saved === 'light' || saved === 'dark' || saved === 'system') {
    choice = saved;
    apply();
    for (const cb of listeners) cb();
  }
});

export function setAppearance(next: Appearance): void {
  choice = next;
  void AsyncStorage.setItem(KEY, next);
  apply();
  for (const cb of listeners) cb();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function currentScheme(): Scheme {
  return scheme;
}

export function useScheme(): Scheme {
  return useSyncExternalStore(subscribe, () => scheme, () => scheme);
}

export function useAppearance(): Appearance {
  return useSyncExternalStore(subscribe, () => choice, () => choice);
}

// Reads the palette in force right now. Style sheets are built through
// themed(), so they rebuild after the scheme changes and the tree re-renders.
export const zinc: Readonly<Palette> = new Proxy({} as Palette, {
  get: (_t, key: string) => (scheme === 'light' ? light : dark)[key as keyof Palette],
});

export function themed<T extends object>(build: () => T): T {
  let made: T | null = null;
  let at = -1;
  return new Proxy({} as T, {
    get: (_t, key) => {
      if (!made || at !== version) {
        made = build();
        at = version;
      }
      return made[key as keyof T];
    },
    ownKeys: () => {
      if (!made || at !== version) {
        made = build();
        at = version;
      }
      return Reflect.ownKeys(made);
    },
    getOwnPropertyDescriptor: (_t, key) => {
      if (!made || at !== version) {
        made = build();
        at = version;
      }
      const d = Reflect.getOwnPropertyDescriptor(made, key);
      return d ? { ...d, configurable: true } : undefined;
    },
  });
}

// 4-point grid. Name by size, not by use.
export const space = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 14,
  xl: 20,
  full: 999,
} as const;

// Phone-sized ramp: body text is 16, nothing a person must read is under 12.
export const type = themed(
  () =>
    ({
      title: { fontSize: 30, lineHeight: 36, fontWeight: '700', color: zinc.text, letterSpacing: -0.6 },
      headline: { fontSize: 17, lineHeight: 22, fontWeight: '600', color: zinc.text, letterSpacing: -0.2 },
      body: { fontSize: 16, lineHeight: 23, fontWeight: '400', color: zinc.text },
      row: { fontSize: 16, lineHeight: 21, fontWeight: '600', color: zinc.text, letterSpacing: -0.1 },
      subhead: { fontSize: 14, lineHeight: 19, fontWeight: '400', color: zinc.muted },
      label: { fontSize: 12.5, lineHeight: 16, fontWeight: '600', color: zinc.faint, letterSpacing: 0.4 },
      caption: { fontSize: 12.5, lineHeight: 16, fontWeight: '400', color: zinc.faint },
    }) as const satisfies Record<string, TextStyle>,
);

export const layout = {
  screen: space.lg,
  gap: space.sm,
  bubbleX: 14,
  bubbleY: 10,
  bubble: radius.lg,
  composer: 24,
  composerPad: space.md,
  send: 36,
  touch: 44,
} as const;

// One hue per provider, so a chat is recognisable before its title is read.
const PROVIDER_HUES: Record<string, string> = {
  claude: '#D97757',
  codex: '#10A37F',
  cursor: '#6E6EF7',
  grok: '#8B8B93',
  opencode: '#3B82F6',
  copilot: '#A855F7',
};

export function providerHue(id: string): string {
  return PROVIDER_HUES[id] ?? '#8B8B93';
}

const PROVIDER_NAMES: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  grok: 'Grok',
  opencode: 'OpenCode',
  copilot: 'Copilot',
};

export function providerName(id: string): string {
  if (id === '') return '';
  return PROVIDER_NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}
