/* The preview browser: an address bar, the slot the native view is flown into,
   and the console/network drawer under it.

   #paneslot is deliberately empty. The page is a separate web contents that the
   window paints on top of this document at whatever bounds that div reports, so
   everything here is the frame around a hole.

   A folder can have several previews open, and the frame is drawn once per
   preview tab rather than once for the window. All of them stay mounted and
   every one but the active tab's is display:none. The alternative, one frame
   reading whichever record is active, throws away everything the DOM is holding
   for the tabs behind it: the address you were halfway through typing, where
   you had scrolled the console. Those belong to a tab, not to a window, and
   moving them into the store would repaint three hundred log rows per
   keystroke.

   There is still only one hole. Bounds are measured and watched off #paneslot
   by id, and a native view can only be in one place, so the frames stack around
   a single slot that outlives all of them: toolbars above it, drawers below,
   and the one that is showing gives the hole its height.

   Empty and error Stages paint inside the hole. The guest is hidden for those
   states (see guestWanted in browser-store), otherwise Chromium's blank page
   would cover this chrome. */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import {
  AppWindowIcon,
  BotIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  ChevronDownIcon,
  EllipsisVerticalIcon,
  FolderTreeIcon,
  GitCompareIcon,
  GlobeIcon,
  HistoryIcon,
  LaptopIcon,
  MonitorIcon,
  MousePointer2Icon,
  RadioTowerIcon,
  RotateCcwSquareIcon,
  RotateCwIcon,
  ScanIcon,
  SearchIcon,
  SmartphoneIcon,
  SparklesIcon,
  StarIcon,
  TabletIcon,
  TerminalIcon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { runCommand } from '../../app.js';
import { getControlVersion, handBack, learn, subscribeControl, youHold } from './control-store';
import {
  bookmarkBarOn,
  bookmarksOf,
  clearRecents,
  isBookmarked,
  setBookmarkBar,
  toggleBookmark,
  askAboutError,
  attachBrowser,
  detachBrowser,
  poppedTab,
  clearLogs,
  consoleErrors,
  getBrowserVersion,
  go,
  hideDrawer,
  localServers,
  navigateTab,
  onScreen,
  parseViewport,
  pickElement,
  previewOf,
  previews,
  recentUrls,
  removeRecent,
  rotateViewport,
  frameBox,
  holdScale,
  MAX_VIEWPORT,
  MIN_VIEWPORT,
  toggleResponsive,
  toggleRecording,
  screenshot,
  setViewport,
  showDrawer,
  subscribeBrowser,
  VIEWPORTS,
} from './browser-store';
import { warmPane } from './pane-cover';
import { DEFAULT_ENGINE, SEARCH_ENGINES, displayUrl, engineLabel, searchUrl, inlineCompletion, matchPlaces, places, worthSuggesting } from './address-suggest';
import { useLayout, usePaneCover } from './Shell';
import { useSettings } from '../useSettings';

const VIEWPORT_ICON = {
  scan: ScanIcon,
  smartphone: SmartphoneIcon,
  tablet: TabletIcon,
  laptop: LaptopIcon,
  monitor: MonitorIcon,
};

const ICON_BUTTON = 'size-7 rounded-md text-muted-foreground';

const ERROR_HINTS = [
  [/ERR_CONNECTION_REFUSED|refused|(-102)/i, 'Connection refused'],
  [/ERR_NAME_NOT_RESOLVED|(-105)/i, 'DNS address could not be found'],
  [/ERR_CONNECTION_TIMED_OUT|(-118)/i, 'Connection timed out'],
  [/ERR_INTERNET_DISCONNECTED|(-106)/i, 'No internet connection'],
  [/ERR_SSL|CERT_/i, 'SSL certificate problem'],
  [/ERR_EMPTY_RESPONSE|(-324)/i, 'Empty response from server'],
];

function friendlyError(message) {
  for (const [re, label] of ERROR_HINTS) {
    if (re.test(message || '')) return label;
  }
  return 'The page did not load';
}

function errorCode(message) {
  const m = /(ERR_[A-Z0-9_]+)|(-?\d{2,4})/.exec(message || '');
  return m ? (m[1] || `ERR_${Math.abs(Number(m[2]))}`) : 'ERR_FAILED';
}

function useBrowser(tab) {
  useSyncExternalStore(subscribeBrowser, getBrowserVersion, getBrowserVersion);
  return previewOf(tab);
}

// Tooltips open away from the pane, which is a native view they would land
// under. The bars sit above it and the drawer below.
function Tip({ label, side = 'top', children }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
}

// ------------------------------------------------------------- address bar

// The bar shows the whole address, scheme included, the way a browser does.
// The stored url drops https so the old field could paint the scheme in amber.
function fullAddress(s) {
  if (!s.url) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(s.url)) return s.url;
  return `${s.scheme || 'https://'}${s.url}`;
}

const SUGGEST_DEBOUNCE_MS = 120;

function AddressBar({ tab, showing }) {
  const s = useBrowser(tab);
  const shown = fullAddress(s);
  const { settings } = useSettings();
  const engine = settings?.browser?.searchEngine;
  const [draft, setDraft] = useState(shown);
  const [focused, setFocused] = useState(false);
  // What the person actually typed; the draft may carry an inline completion
  // past it, selected so the next keystroke replaces it.
  const [typed, setTyped] = useState('');
  const [completion, setCompletion] = useState(null);
  const [remote, setRemote] = useState([]);
  const [active, setActive] = useState(-1);
  // Escape closes the list without throwing away what was typed.
  const [dismissed, setDismissed] = useState(false);
  const [box, setBox] = useState(null);
  const input = useRef(null);
  const frame = useRef(null);
  const asked = useRef(0);

  useEffect(() => { if (!focused) setDraft(shown); }, [shown, focused]);
  // A page that finishes loading under a focused bar shows its address, unless
  // the person has started typing. Read through a ref: clearing the field is
  // not a reason to put the address back.
  const typing = useRef(false);
  typing.current = !!typed;
  useEffect(() => {
    if (focused && !s.loading && !typing.current) setDraft(shown);
  }, [shown, s.loading, focused]);

  // Per keystroke, not per render: a loading page re-renders the bar many
  // times a second while what was typed stays the same.
  const rows = useMemo(() => suggestionRows(typed, remote, engine), [typed, remote, engine]);
  const open = focused && !!typed && !dismissed && rows.length > 0;
  usePaneCover(open);

  useEffect(() => {
    if (!open || !frame.current) return undefined;
    // The bar moves without the window resizing when the rail or a divider
    // does, so watch the bar itself as well.
    const measure = () => setBox(frame.current?.getBoundingClientRect() || null);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(frame.current);
    window.addEventListener('resize', measure);
    return () => { watch.disconnect(); window.removeEventListener('resize', measure); };
  }, [open]);

  // Ask the search engine once typing pauses. A reply to an older question
  // than the one on screen is dropped.
  useEffect(() => {
    const ticket = ++asked.current;
    if (!focused || !worthSuggesting(typed) || settings?.browser?.searchSuggestions === false) {
      setRemote([]);
      return undefined;
    }
    const t = setTimeout(async () => {
      const list = await window.conn.browser.action('suggest', typed, tab).catch(() => []);
      if (ticket === asked.current) setRemote(Array.isArray(list) ? list : []);
    }, SUGGEST_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [typed, focused, tab, settings?.browser?.searchSuggestions]);

  // Select the completed tail after React has written it into the field.
  useEffect(() => {
    const el = input.current;
    if (el && completion && document.activeElement === el && el.value === completion.text) {
      el.setSelectionRange(typed.length, completion.text.length);
    }
  }, [completion, typed]);

  const reset = () => {
    setTyped('');
    setCompletion(null);
    setRemote([]);
    setActive(-1);
    setDismissed(false);
  };

  const openTarget = (target) => {
    const where = String(target || '').trim();
    if (!where) return;
    navigateTab(where, tab);
    reset();
    input.current?.blur();
  };

  const submit = () => {
    const row = rows[active];
    if (row) return openTarget(row.value);
    if (completion && draft === completion.text) return openTarget(completion.url);
    openTarget(draft);
  };

  const onChange = (e) => {
    const value = e.target.value;
    const el = e.target;
    // Plain typing only: completing mid-composition breaks an IME, and a paste
    // is meant as pasted.
    const adding = e.nativeEvent?.inputType === 'insertText' && !e.nativeEvent?.isComposing
      && el.selectionEnd === value.length;
    const done = adding ? inlineCompletion(value, places(recentUrls(), bookmarksOf())) : null;
    setTyped(value);
    setCompletion(done);
    setActive(-1);
    setDismissed(false);
    setDraft(done ? done.text : value);
  };

  const pick = (i) => {
    setActive(i);
    setCompletion(null);
    setDraft(i < 0 ? typed : rows[i].fill);
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); return; }
    if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const next = active + step;
      pick(next >= rows.length ? -1 : next < -1 ? rows.length - 1 : next);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      // First press drops the list and the completion; the second gives the
      // field back to the page's address.
      if (open || completion) {
        setDraft(typed);
        setCompletion(null);
        setActive(-1);
        setDismissed(true);
        return;
      }
      setDraft(shown);
      input.current?.blur();
    }
  };

  return (
    <div ref={frame} className="flex h-7 min-w-0 flex-1 items-center rounded-full bg-muted/70 px-3">
      <input
        id={showing ? 'url' : undefined}
        ref={input}
        spellCheck={false}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="both"
        aria-controls={open ? `address-list-${tab}` : undefined}
        placeholder={`Search ${engineLabel(engine)} or enter URL`}
        className="w-full bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
        value={focused ? draft : shown}
        onChange={onChange}
        onFocus={() => {
          setDraft(shown);
          reset();
          setFocused(true);
          queueMicrotask(() => input.current?.select());
        }}
        onBlur={() => { setFocused(false); reset(); }}
        onKeyDown={onKeyDown} />
      {open && box && createPortal(
        <SuggestionList
          id={`address-list-${tab}`}
          box={box}
          rows={rows}
          active={active}
          onHover={setActive}
          onPick={(row) => openTarget(row.value)} />,
        document.body,
      )}
    </div>
  );
}

/* History and bookmarks that match, then what the engine suggests, then the
   plain search for exactly what was typed when nothing else says it. */
function suggestionRows(typed, remote, engine) {
  const q = typed.trim();
  if (!q) return [];
  const local = matchPlaces(q, places(recentUrls(), bookmarksOf())).map((e) => ({
    kind: e.kind,
    label: e.title || displayUrl(e.url),
    detail: displayUrl(e.url),
    value: e.url,
    fill: e.url,
  }));
  const seen = new Set([q.toLowerCase()]);
  const searches = [];
  if (worthSuggesting(q)) {
    searches.push({ kind: 'search', label: q, detail: `${engineLabel(engine)} Search`, value: searchUrl(q, engine), fill: q });
  }
  for (const phrase of remote) {
    if (seen.has(phrase.toLowerCase())) continue;
    seen.add(phrase.toLowerCase());
    searches.push({ kind: 'search', label: phrase, detail: '', value: searchUrl(phrase, engine), fill: phrase });
  }
  return [...local, ...searches].slice(0, 10);
}

const ROW_ICON = { history: HistoryIcon, bookmark: StarIcon, search: SearchIcon };

// Portalled, and tagged as a popover, so the pane cover sees it: the page is a
// native view that would otherwise paint straight over the list.
function SuggestionList({ id, box, rows, active, onHover, onPick }) {
  return (
    <div
      id={id}
      role="listbox"
      data-slot="popover-content"
      data-state="open"
      className="fixed z-50 overflow-hidden rounded-xl border bg-popover p-1 text-popover-foreground shadow-lg"
      style={{ top: box.bottom + 4, left: box.left, width: box.width }}>
      {rows.map((row, i) => {
        const Icon = ROW_ICON[row.kind] || GlobeIcon;
        return (
          <div
            key={`${row.kind}:${row.value}`}
            role="option"
            aria-selected={i === active}
            data-active={i === active ? '' : undefined}
            className="flex h-8 cursor-default items-center gap-2.5 rounded-md px-2 text-[13px] data-[active]:bg-accent data-[active]:text-accent-foreground"
            onMouseEnter={() => onHover(i)}
            // Keep focus in the field, or its blur closes the list first.
            onMouseDown={(e) => { e.preventDefault(); onPick(row); }}>
            <Icon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 shrink truncate">{row.label}</span>
            {row.detail && row.detail !== row.label && (
              <span className="min-w-0 shrink-[3] truncate text-muted-foreground">
                <span className="px-1">&ndash;</span>{row.detail}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- pane menu

function PointerSparkIcon() {
  return (
    <span className="relative inline-flex size-4 items-center justify-center">
      <MousePointer2Icon className="size-4" />
      <SparklesIcon className="-top-[3px] -right-[3px] absolute size-2.5" />
    </span>
  );
}

function PickButton({ tab }) {
  const s = useBrowser(tab);

  return (
    <Tip label={s.picking ? 'Stop pointing (Esc)' : 'Point at an element (Ctrl+Shift+E)'}>
      <Button
        variant="ghost"
        size="icon"
        data-armed={s.picking ? '' : undefined}
        className={`${ICON_BUTTON} data-[armed]:bg-foreground data-[armed]:text-background data-[armed]:hover:bg-foreground data-[armed]:hover:text-background`}
        aria-pressed={s.picking ? 'true' : 'false'}
        onClick={() => pickElement(tab)}>
        <PointerSparkIcon />
      </Button>
    </Tip>
  );
}

function ResponsiveButton({ tab }) {
  const s = useBrowser(tab);
  const held = VIEWPORTS.find((v) => v.size === s.viewport);
  const Current = VIEWPORT_ICON[held?.icon] || SmartphoneIcon;

  return (
    <Tip label={s.viewport ? 'Close responsive mode' : 'Responsive mode'}>
      <Button
        variant="ghost"
        size="icon"
        aria-pressed={!!s.viewport}
        data-armed={s.viewport ? '' : undefined}
        className={`${ICON_BUTTON} data-[armed]:bg-accent data-[armed]:text-foreground`}
        onClick={() => toggleResponsive(tab)}>
        <Current />
      </Button>
    </Tip>
  );
}

/* Chrome's device toolbar, under the address bar while a viewport is set. The
   presets used to live in a dropdown on the toolbar button; they are here now,
   beside the numbers they set, and the button only turns the mode on and off. */
function SizeInput({ value, label, onCommit }) {
  const [draft, setDraft] = useState(null);
  const commit = () => {
    const n = Math.round(Number(draft));
    if (draft !== null && n >= MIN_VIEWPORT && n <= MAX_VIEWPORT) onCommit(n);
    setDraft(null);
  };

  return (
    <input
      aria-label={label}
      inputMode="numeric"
      className="h-6 w-14 rounded-md border bg-transparent px-1.5 text-center font-mono text-xs tabular-nums outline-none focus-visible:ring-1 focus-visible:ring-ring"
      value={draft ?? value}
      onChange={(e) => setDraft(e.target.value.replace(/\D/g, ''))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') { setDraft(null); e.currentTarget.blur(); }
      }} />
  );
}

function DeviceBar({ tab, showing }) {
  const s = useBrowser(tab);
  const [open, setOpen] = useState(false);
  usePaneCover(open);
  const dims = parseViewport(s.viewport);
  if (!showing || !dims) return null;

  const held = VIEWPORTS.find((v) => v.size === s.viewport);
  const resize = (width, height) => setViewport(`${width}x${height}`, tab);

  return (
    <div className="flex h-9 shrink-0 items-center justify-center gap-2 border-b border-border/60 px-2 text-xs">
      <span className="text-muted-foreground">Dimensions:</span>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-xs" onPointerDown={warmPane}>
            {held ? held.label : 'Responsive'}
            <ChevronDownIcon className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-52">
          <DropdownMenuCheckboxItem checked={!held} onCheckedChange={() => {}}>
            <ScanIcon />
            Responsive
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          {VIEWPORTS.map((v) => {
            const Icon = VIEWPORT_ICON[v.icon];
            return (
              <DropdownMenuCheckboxItem
                key={v.size}
                checked={s.viewport === v.size}
                onCheckedChange={() => setViewport(v.size, tab)}>
                <Icon />
                {v.label}
                <span className="ml-auto font-mono text-[10.5px] text-muted-foreground">{v.note}</span>
              </DropdownMenuCheckboxItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      <SizeInput label="Width" value={dims.width} onCommit={(w) => resize(w, dims.height)} />
      <span className="text-muted-foreground">×</span>
      <SizeInput label="Height" value={dims.height} onCommit={(h) => resize(dims.width, h)} />

      <Tip label="Rotate">
        <Button variant="ghost" size="icon" className="size-6" onClick={() => rotateViewport(tab)}>
          <RotateCcwSquareIcon />
        </Button>
      </Tip>
      <Tip label="Close responsive mode">
        <Button variant="ghost" size="icon" className="size-6" onClick={() => setViewport('', tab)}>
          <XIcon />
        </Button>
      </Tip>
    </div>
  );
}

function PaneMenu({ tab }) {
  const s = useBrowser(tab);
  const { previewFull } = useLayout();
  const { settings, set } = useSettings();
  const [open, setOpen] = useState(false);
  usePaneCover(open);
  const devtoolsDetached = !!settings?.browser?.devtoolsDetached;
  const suggestionsOn = settings?.browser?.searchSuggestions !== false;
  const popped = poppedTab() === tab;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tip label="Preview tools">
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={ICON_BUTTON}
            onPointerDown={warmPane}>
            <EllipsisVerticalIcon />
          </Button>
        </DropdownMenuTrigger>
      </Tip>

      <DropdownMenuContent align="end" className="w-64 p-1.5">
        <DropdownMenuItem onSelect={() => screenshot(tab)}>
          Take Screenshot
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => toggleRecording(tab)}>
          {s.recording ? 'Stop recording' : 'Start recording'}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => go('hardReload', tab)}>
          Hard Reload
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigator.clipboard.writeText(fullAddress(s))}>
          Copy Current URL
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={(e) => { e.preventDefault(); setBookmarkBar(!bookmarkBarOn()); }}>
          Show Bookmark Bar
          <Switch
            className="ml-auto"
            checked={bookmarkBarOn()}
            onCheckedChange={setBookmarkBar}
            onClick={(e) => e.stopPropagation()} />
        </DropdownMenuItem>

        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            Search Engine
            <span className="ml-auto text-xs text-muted-foreground">{engineLabel(settings?.browser?.searchEngine)}</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={settings?.browser?.searchEngine || DEFAULT_ENGINE}
              onValueChange={(id) => set({ browser: { searchEngine: id } })}>
              {Object.entries(SEARCH_ENGINES).map(([id, { label }]) => (
                <DropdownMenuRadioItem key={id} value={id}>{label}</DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem
          onSelect={(e) => { e.preventDefault(); set({ browser: { searchSuggestions: !suggestionsOn } }); }}>
          Search Suggestions
          <Switch
            className="ml-auto"
            checked={suggestionsOn}
            onCheckedChange={(on) => set({ browser: { searchSuggestions: on } })}
            onClick={(e) => e.stopPropagation()} />
        </DropdownMenuItem>

        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => { clearRecents(); window.conn.browser.action('clearData', 'history', tab); }}>
          Clear Browsing History
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => window.conn.browser.action('clearData', 'cookies', tab)}>
          Clear Cookies
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => window.conn.browser.action('clearData', 'cache', tab)}>
          Clear Cache
        </DropdownMenuItem>

        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => go('devtools', tab)}>
          DevTools
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={(e) => { e.preventDefault(); set({ browser: { devtoolsDetached: !devtoolsDetached } }); }}>
          DevTools in a Window
          <Switch
            className="ml-auto"
            checked={devtoolsDetached}
            onCheckedChange={(on) => set({ browser: { devtoolsDetached: on } })}
            onClick={(e) => e.stopPropagation()} />
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => (popped ? attachBrowser() : detachBrowser(tab))}>
          {popped ? 'Dock the Browser' : 'Browser in a Window'}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => go('openExternal', tab)}>
          Open in system browser
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => runCommand('previewFull')}>
          {previewFull ? 'Back to the chat' : 'Preview at full width'}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => runCommand('preview', false)}>
          Hide the preview
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ------------------------------------------------------------------- stage

function PageError({ tab, error }) {
  const [details, setDetails] = useState(false);
  const host = (() => {
    try { return new URL(error.url || 'http://local').host; } catch { return error.url || 'the page'; }
  })();

  return (
    <div className="absolute inset-0 overflow-y-auto bg-background">
      <div className="mx-auto flex min-h-full w-full max-w-xl flex-col px-8 py-12">
        <TriangleAlertIcon className="mb-6 size-10 text-muted-foreground/70" />
        <h1 className="mb-3 font-semibold text-2xl text-foreground leading-tight">
          This site can&apos;t be reached
        </h1>
        <p className="text-muted-foreground text-sm leading-relaxed">
          <span className="font-semibold text-foreground">{host}</span>
          {`: ${friendlyError(error.message)}.`}
        </p>

        {details && (
          <div className="mt-6 rounded-lg border bg-muted/40 p-4 text-sm">
            <p className="mb-2 font-medium text-foreground">Try:</p>
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              <li>Confirming the dev server is running</li>
              <li>Checking the port in the address bar</li>
              <li>Asking the agent to start or fix the server</li>
            </ul>
            <p className="mt-3 break-all font-mono text-[11px] text-muted-foreground">
              {error.message}
            </p>
          </div>
        )}

        <div className="mt-8 text-[11px] text-muted-foreground/70 uppercase tracking-wide">
          {errorCode(error.message)}
        </div>

        <div className="mt-auto flex flex-wrap items-center gap-2 pt-8">
          <Button type="button" variant="outline" size="sm" onClick={() => setDetails((v) => !v)}>
            {details ? 'Hide details' : 'Details'}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => showDrawer('network', tab)}>
            Network
          </Button>
          <span className="flex-1" />
          <Button type="button" variant="outline" size="sm" onClick={() => go('reload', tab)}>
            Reload
          </Button>
          <Button type="button" size="sm" onClick={() => askAboutError(tab)}>
            Ask Agent
          </Button>
        </div>
      </div>
    </div>
  );
}

function Tile({ icon: Icon, label, hint, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-24 w-32 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border bg-card text-card-foreground transition-colors hover:border-ring hover:bg-accent">
      <Icon className="size-5 text-muted-foreground" />
      <span className="font-medium text-xs">{label}</span>
      {hint && <span className="text-[10px] text-muted-foreground">{hint}</span>}
    </button>
  );
}

function RecentRow({ entry, onOpen, onRemove }) {
  let label = entry.url;
  try {
    const u = new URL(entry.url);
    label = `${u.host}${u.pathname === '/' ? '' : u.pathname}${u.search}`;
  } catch { /* keep url */ }

  return (
    <div className="group relative flex w-full items-center">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-3 px-3 py-2.5 pr-10 text-left hover:bg-accent/40">
        <GlobeIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-sm">{entry.title || label}</span>
          {entry.title && <span className="block truncate text-muted-foreground text-xs">{label}</span>}
        </span>
      </button>
      <button
        type="button"
        aria-label={`Remove ${label}`}
        className="absolute right-2 rounded p-1 text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100"
        onClick={onRemove}>
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}

function Placeholder({ tab }) {
  useBrowser(tab);
  const recents = recentUrls().slice(0, 8);
  const servers = localServers();

  const address = () => {
    const box = document.getElementById('url');
    box?.focus();
    box?.select();
  };

  const hasLists = recents.length > 0 || servers.length > 0;

  return (
    <div className="absolute inset-0 overflow-y-auto">
      {!hasLists ? (
        <Empty className="min-h-full">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <AppWindowIcon />
            </EmptyMedia>
            <EmptyTitle>New tab</EmptyTitle>
            <EmptyDescription>
              Type a URL above, or run a dev script. Local servers show up here when the terminal prints them.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <div className="grid grid-cols-2 gap-2">
              <Tile icon={GlobeIcon} label="Open an address" hint="^⇧L" onClick={address} />
              <Tile icon={TerminalIcon} label="Terminal" hint="^`" onClick={() => runCommand('terminal')} />
              <Tile icon={FolderTreeIcon} label="Project files" hint="^⇧D" onClick={() => runCommand('files')} />
              <Tile icon={GitCompareIcon} label="Changes" hint="^⇧G" onClick={() => runCommand('changes')} />
            </div>
            <p className="text-[11px] text-muted-foreground">
              <code>conn go 3000</code> from the shell or the agent
            </p>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="mx-auto flex w-full max-w-xl flex-col gap-6 px-5 py-8">
          {recents.length > 0 && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <HistoryIcon className="size-4 shrink-0" />
                <h2 className="font-medium">Recently used</h2>
              </div>
              <div className="overflow-hidden rounded-lg border">
                {recents.map((entry) => (
                  <RecentRow
                    key={entry.url}
                    entry={entry}
                    onOpen={() => navigateTab(entry.url, tab)}
                    onRemove={() => removeRecent(entry.url)} />
                ))}
              </div>
            </div>
          )}

          {servers.length > 0 && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <RadioTowerIcon className="size-4 shrink-0" />
                <h2 className="font-medium">Local servers</h2>
              </div>
              <div className="overflow-hidden rounded-lg border">
                {servers.map((server) => (
                  <button
                    key={server.url}
                    type="button"
                    className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-accent/40"
                    onClick={() => navigateTab(server.url, tab)}>
                    <RadioTowerIcon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate font-medium text-sm">{server.url}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Tile icon={GlobeIcon} label="Address" hint="^⇧L" onClick={address} />
            <Tile icon={TerminalIcon} label="Terminal" hint="^`" onClick={() => runCommand('terminal')} />
            <Tile icon={FolderTreeIcon} label="Files" hint="^⇧D" onClick={() => runCommand('files')} />
            <Tile icon={GitCompareIcon} label="Changes" hint="^⇧G" onClick={() => runCommand('changes')} />
          </div>
        </div>
      )}
    </div>
  );
}

function useSize(ref) {
  const [size, setSize] = useState(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => setSize({ width: el.clientWidth, height: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/* The page itself is a native view that main lays over the frame's box, so all
   this draws is what sits around it: the outline and the three handles. The
   handles sit just outside the box, since anything inside it is under the view.

   A drag holds the scale it started at. Refitting as the frame grows or
   shrinks would move it under the pointer, and the handle would run away from
   the hand dragging it. Past the edge of the pane it does have to shrink, and
   the frame refits once the drag lets go. */
function DeviceFrame({ tab, showing }) {
  const s = useBrowser(tab);
  const here = useRef(null);
  const slot = useSize(here);
  const dims = parseViewport(s.viewport);
  const on = showing && s.live && !s.error && dims;

  const box = on && slot ? frameBox(slot, dims, s.hold) : null;

  const drag = (axes) => (e) => {
    if (!box || e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const start = { x: e.clientX, y: e.clientY, ...dims };
    const { scale } = box;
    const clamp = (n) => Math.max(MIN_VIEWPORT, Math.min(MAX_VIEWPORT, Math.round(n)));
    holdScale(scale, tab);

    let next = null;
    let frame = 0;
    const move = (ev) => {
      // The frame is centred, so the right edge moves half of what the width
      // does. Twice the pointer's travel keeps the handle under it.
      const width = axes.includes('x') ? clamp(start.width + (2 * (ev.clientX - start.x)) / scale) : start.width;
      const height = axes.includes('y') ? clamp(start.height + (ev.clientY - start.y) / scale) : start.height;
      next = `${width}x${height}`;
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; setViewport(next, tab); });
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      cancelAnimationFrame(frame);
      if (next) setViewport(next, tab);
      holdScale(null, tab);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  return (
    <div ref={here} className="absolute inset-0" hidden={!on || undefined}>
      {box && (
        <div className="absolute inset-0 bg-muted/35">
          <div
            className="pointer-events-none absolute rounded-[1px] outline outline-1 outline-border"
            style={{ left: box.x, top: box.y, width: box.width, height: box.height }} />
          <div
            title="Drag to resize"
            className="absolute flex w-3 cursor-ew-resize touch-none items-center justify-center rounded-sm hover:bg-accent"
            style={{ left: box.x + box.width + 3, top: box.y, height: box.height }}
            onPointerDown={drag('x')}>
            <div className="h-8 w-1 rounded-full bg-muted-foreground/50" />
          </div>
          <div
            title="Drag to resize"
            className="absolute flex h-3 cursor-ns-resize touch-none items-center justify-center rounded-sm hover:bg-accent"
            style={{ left: box.x, top: box.y + box.height + 3, width: box.width }}
            onPointerDown={drag('y')}>
            <div className="h-1 w-8 rounded-full bg-muted-foreground/50" />
          </div>
          <div
            title="Drag to resize"
            className="absolute size-3 cursor-nwse-resize touch-none rounded-sm hover:bg-accent"
            style={{ left: box.x + box.width + 3, top: box.y + box.height + 3 }}
            onPointerDown={drag('xy')} />
        </div>
      )}
    </div>
  );
}

function Popped() {
  return (
    <Empty className="absolute inset-0 bg-background">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ArrowUpRightIcon />
        </EmptyMedia>
        <EmptyTitle>The browser is in its own window</EmptyTitle>
        <EmptyDescription>
          The agent still drives it from here. Close that window or bring it back to see the page in this column.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="outline" size="sm" onClick={attachBrowser}>
          <ArrowDownLeftIcon />
          Bring it back
        </Button>
      </EmptyContent>
    </Empty>
  );
}

function Stage({ tab, showing }) {
  const s = useBrowser(tab);
  if (!showing) return null;
  if (tab === poppedTab()) return <Popped />;
  if (s.error) return <PageError tab={tab} error={s.error} />;
  return s.live ? <DeviceFrame tab={tab} showing={showing} /> : <Placeholder tab={tab} />;
}

// ------------------------------------------------------------------ drawer

function LogRow({ row }) {
  const level = row.level || (row.kind === 'failed' ? 'error' : '') || row.kind || '';
  const message = row.message ?? `${row.status || row.error || ''} ${row.method || ''} ${row.url || ''}`.trim();

  return (
    <div className="flex gap-2 border-b px-3 py-1 font-mono text-[11px] last:border-b-0">
      <span
        data-level={level}
        className="w-14 shrink-0 text-muted-foreground data-[level=error]:text-destructive data-[level=warning]:text-[hsl(var(--warning))]">
        {level}
      </span>
      <span className="min-w-0 break-all">{message}</span>
    </div>
  );
}

function Drawer({ tab, showing }) {
  const s = useBrowser(tab);
  const body = useRef(null);
  const seat = useRef({ top: 0, stick: true });
  const rows = s.drawerTab === 'console' ? s.console : s.network;

  useEffect(() => {
    const el = body.current;
    if (!el) return undefined;
    const onScroll = () => {
      seat.current.stick = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
      seat.current.top = el.scrollTop;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [s.drawerOpen]);

  useEffect(() => {
    const el = body.current;
    if (!el || !showing) return;
    el.scrollTop = seat.current.stick ? el.scrollHeight : seat.current.top;
  }, [showing, rows.length, s.drawerTab]);

  if (!s.drawerOpen) return null;

  const errors = consoleErrors(tab);

  return (
    <div className="flex h-[220px] shrink-0 flex-col border-t" hidden={!showing || undefined}>
      <Tabs value={s.drawerTab} onValueChange={(v) => showDrawer(v, tab)} className="min-h-0 flex-1 gap-0">
        <div className="flex items-center gap-2 border-b px-2 py-1">
          <TabsList className="h-7 bg-transparent p-0">
            <TabsTrigger value="console" className="gap-1.5 text-xs">
              console
              {s.console.length > 0 && (
                <Badge variant={errors ? 'destructive' : 'secondary'} className="px-1.5 py-0 text-[10px]">
                  {errors || s.console.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="network" className="gap-1.5 text-xs">
              network
              {s.network.length > 0 && (
                <Badge variant="destructive" className="px-1.5 py-0 text-[10px]">{s.network.length}</Badge>
              )}
            </TabsTrigger>
          </TabsList>

          <span className="flex-1" />

          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-muted-foreground"
            onClick={() => clearLogs(tab)}>
            clear
          </Button>
          <Tip label="Close drawer (Ctrl+Shift+J)" side="bottom">
            <Button
              variant="ghost"
              size="icon"
              className={ICON_BUTTON}
              onClick={() => hideDrawer(tab)}>
              <ChevronDownIcon />
            </Button>
          </Tip>
        </div>

        <ScrollArea className="min-h-0 flex-1" viewportRef={body}>
          {rows.length === 0
            ? <div className="p-3 text-xs text-muted-foreground">{`no ${s.drawerTab} entries`}</div>
            : rows.slice(-300).map((row, i) => <LogRow key={`${i}-${row.url || row.message}`} row={row} />)}
        </ScrollArea>
      </Tabs>
    </div>
  );
}

// ------------------------------------------------------------------ toolbar

function LoadingBar({ tab }) {
  const s = useBrowser(tab);
  return (
    <div
      aria-hidden
      data-loading={s.loading ? '' : undefined}
      className="preview-loading-progress pointer-events-none absolute right-0 bottom-0 left-0 z-10 h-0.5 origin-left rounded-r-full bg-primary" />
  );
}

function BookmarkBar({ tab, showing }) {
  useSyncExternalStore(subscribeBrowser, getBrowserVersion, getBrowserVersion);
  if (!showing || !bookmarkBarOn()) return null;
  const marks = bookmarksOf();
  return (
    <div className="flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-b border-border/60 px-2" hidden={!showing || undefined}>
      {marks.length === 0 && (
        <span className="px-1 text-[12px] text-muted-foreground">Star a page to keep it here.</span>
      )}
      {marks.map((b) => (
        <button
          key={b.url}
          type="button"
          title={b.url}
          className="max-w-40 shrink-0 truncate rounded-md px-2 py-0.5 text-[12px] text-foreground/80 hover:bg-muted"
          onClick={() => navigateTab(b.url, tab)}>
          {b.title || b.url.replace(/^https?:\/\//, '')}
        </button>
      ))}
    </div>
  );
}

function Toolbar({ tab, showing }) {
  const s = useBrowser(tab);
  const errors = consoleErrors(tab);

  const onRefresh = () => {
    if (s.loading) go('stop', tab);
    else go('reload', tab);
  };

  return (
    <div className="relative flex h-9 shrink-0 items-center gap-0.5 border-b border-border/60 px-1.5" hidden={!showing || undefined}>
      <div className="flex items-center" role="group" aria-label="Navigation">
        <Tip label="Back">
          <Button variant="ghost" size="icon" className={ICON_BUTTON} disabled={!s.canGoBack} onClick={() => go('back', tab)}>
            <ArrowLeftIcon />
          </Button>
        </Tip>
        <Tip label="Forward">
          <Button variant="ghost" size="icon" className={ICON_BUTTON} disabled={!s.canGoForward} onClick={() => go('forward', tab)}>
            <ArrowRightIcon />
          </Button>
        </Tip>
        <Tip label={s.loading ? 'Stop' : 'Reload'}>
          <Button variant="ghost" size="icon" className={ICON_BUTTON} onClick={onRefresh}>
            <RotateCwIcon className={s.loading ? 'animate-spin' : undefined} />
          </Button>
        </Tip>
        <Tip label={isBookmarked(fullAddress(s)) ? 'Remove bookmark' : 'Bookmark this page'}>
          <Button
            variant="ghost"
            size="icon"
            className={ICON_BUTTON}
            aria-pressed={isBookmarked(fullAddress(s))}
            onClick={() => toggleBookmark(fullAddress(s), s.title)}>
            <StarIcon className={isBookmarked(fullAddress(s)) ? 'fill-current text-foreground' : undefined} />
          </Button>
        </Tip>
      </div>

      <AddressBar tab={tab} showing={showing} />

      {errors > 0 && (
        <Tip label="Console errors">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-destructive"
            onClick={() => showDrawer('console', tab)}>
            <TriangleAlertIcon />
            {errors}
          </Button>
        </Tip>
      )}

      <HandBack tab={tab} />
      <PickButton tab={tab} />
      <ResponsiveButton tab={tab} />
      <PaneMenu tab={tab} />
      <LoadingBar tab={tab} />
    </div>
  );
}

/* Take control is pressed on the page, so handing it back is offered on the
   page too, not only by the chip at the top of the window. Shown for as long
   as you hold this page. */
function HandBack({ tab }) {
  useSyncExternalStore(subscribeControl, getControlVersion, getControlVersion);
  useEffect(() => { learn(tab); }, [tab]);
  if (!youHold(tab)) return null;
  return (
    <Tip label="Agents are refused this page until you hand it back">
      <Button
        size="sm"
        data-slot="hand-back"
        className="h-7 shrink-0 gap-1 rounded-full px-2.5 text-[12px]"
        onClick={() => handBack(tab)}>
        <BotIcon />
        Hand back to the agent
      </Button>
    </Tip>
  );
}

// -------------------------------------------------------------------- pane

export default function BrowserView() {
  useSyncExternalStore(subscribeBrowser, getBrowserVersion, getBrowserVersion);
  useLayout();
  const shown = onScreen();
  const open = previews();

  return (
    <div className="flex h-full min-h-0 flex-col" hidden={!shown || undefined}>
      {open.map(({ tab }) => <Toolbar key={tab} tab={tab} showing={tab === shown} />)}
      {open.map(({ tab }) => <BookmarkBar key={tab} tab={tab} showing={tab === shown} />)}
      {open.map(({ tab }) => <DeviceBar key={tab} tab={tab} showing={tab === shown} />)}

      <div className="relative min-h-0 flex-1">
        <div id="paneslot" className="absolute inset-0" />
        {open.map(({ tab }) => <Stage key={tab} tab={tab} showing={tab === shown} />)}
      </div>

      {open.map(({ tab }) => <Drawer key={tab} tab={tab} showing={tab === shown} />)}
    </div>
  );
}
