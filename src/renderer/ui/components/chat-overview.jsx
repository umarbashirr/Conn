import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  BotIcon, GitBranchIcon, GitMergeIcon, GitPullRequestClosedIcon, GitPullRequestDraftIcon, GitPullRequestIcon,
  LayoutListIcon, PanelRightCloseIcon, PanelRightOpenIcon, SquareTerminalIcon,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { linkHint, openLink, wantsExternal } from '@/lib/links';
import { chatOverview, PRS_SHOWN } from '@/lib/overview';
import { cn } from '@/lib/utils';
import { clock, useTick } from '@/lib/clock';

import { useProject } from '../useProject';
import { runCommand } from '../../app.js';
import { openSheet } from '../shell/agents-store.js';
import { useFocusedDir, useLayout, VIEW_KINDS } from '../shell/Shell';
import { activeKind, getTabsVersion, revealTab, subscribeTabs, tabsOf } from '../shell/tabs-store';
import { changesState, getChangesVersion, MARK, primeChanges, selectFile, subscribeChanges } from '../shell/changes-store';
import { filesState, getFilesVersion, subscribeFiles } from '../shell/files-store';
import { useWorktrees } from '../shell/worktrees-store';

// The panel sits at right-4 and wants as much again between it and the column.
// It grows into a wide gutter up to MAX_REM, so titles stop truncating while
// there is room beside them. Tailwind cannot read these, so CORNER repeats the
// margin.
const PANEL_REM = 14;
const MAX_REM = 20;
const MARGIN_REM = 1;
const COLLAPSED_KEY = 'conn.overview.collapsed';
// chat-outline.jsx listens for the same name.
const COLUMN_MOVED = 'conn:chat-column-moved';

// Every row in every section is this one shape, so the panel reads as a list.
const ROW = 'flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-[13px] text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50';
const ICON = 'size-3.5 shrink-0 opacity-70';

// ------------------------------------------------------------------- facts

// The folder is the one this chat runs in, resolved the way the composer does,
// which is not always the one the window has focused.
function useFacts(agent) {
  const info = useProject();
  const layout = useLayout();
  const dir = useFocusedDir();
  useSyncExternalStore(subscribeTabs, getTabsVersion, getTabsVersion);
  useSyncExternalStore(subscribeChanges, getChangesVersion, getChangesVersion);
  useSyncExternalStore(subscribeFiles, getFilesVersion, getFilesVersion);

  const project = agent.folderless ? null : info.projects?.find((p) => p.dir === agent.project) || info;
  const { worktrees } = useWorktrees(project?.dir || null, !agent.folderless);
  // The Changes and Files stores hold the focused folder, so they only speak
  // for this chat when it runs in that folder.
  const mine = !!project?.dir && project.dir === dir;
  useEffect(() => { if (mine) primeChanges(); }, [mine]);
  return {
    project: project?.dir || null,
    name: project?.name || 'No folder',
    branch: project?.branch || null,
    changes: layout.changesCount,
    pane: layout.rightOpen ? activeKind(dir) : null,
    tabs: tabsOf(dir)
      .filter((t) => t.kind === 'browser' || t.kind === 'terminal')
      .map(({ id, kind, title }) => ({ id, kind, title })),
    folderless: !!agent.folderless,
    changedFiles: mine && changesState.repo && !changesState.error
      ? changesState.files.map(({ path, kind }) => ({ path, status: kind })) : [],
    openFile: mine ? filesState.view?.path || null : null,
    worktrees,
  };
}

// Whether the gutter right of the chat column holds the panel. Measured, since
// the column is centred and the window, the rail and the right column all move it.
// The column is centred, so its free width is split between two gutters. The
// panel needs room on the right; when the right gutter alone is too narrow the
// column gives up its left gutter first, sliding left until it meets the edge.
// Only when both gutters together cannot hold the panel does it fold to a
// button. `shift` is how far left of centre the column sits for the panel.
function useFits(anchor) {
  const [fit, setFit] = useState({ fits: false, width: 0, shift: 0 });
  useLayoutEffect(() => {
    const root = anchor.current?.parentElement;
    const column = root?.querySelector('[data-chat-column]');
    const box = column?.parentElement;
    if (!root || !column || !box) return undefined;
    const measure = () => {
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
      // The column's own width when centred: its cap, or all of the box.
      const room = box.clientWidth;
      const cap = parseFloat(getComputedStyle(column).maxWidth) || room;
      const free = Math.max(0, room - Math.min(cap, room));
      // What sits right of the box inside the root, a scrollbar for one.
      const beyond = Math.max(0, root.getBoundingClientRect().right - box.getBoundingClientRect().right);
      const need = (PANEL_REM + 2 * MARGIN_REM) * rem - beyond;
      if (free < need) { setFit({ fits: false, width: 0, shift: 0 }); return; }
      const right = Math.max(need, free / 2);
      const width = Math.round(Math.min(right + beyond - 2 * MARGIN_REM * rem, MAX_REM * rem));
      // How far left of centre the column has to sit.
      setFit({ fits: true, width, shift: Math.round(right - free / 2) });
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(root);
    watch.observe(box);
    return () => watch.disconnect();
  }, [anchor]);
  return fit;
}

// Slides the chat's centred strips (the transcript column, the composer and
// the strips above it, all `conn-seat`) left by however far useFits moved the
// column, and back to the centre otherwise. A translate, so the strips keep
// their width and nothing below reflows. The outline in the left gutter
// measures the column's left edge, and a move is not a resize, so it is told.
function useColumnSeat(anchor, shift) {
  useLayoutEffect(() => {
    const root = anchor.current?.closest('#agent-root');
    if (!root) return undefined;
    root.style.setProperty('--chat-shift', `${shift || 0}px`);
    window.dispatchEvent(new Event(COLUMN_MOVED));
    return () => {
      root.style.removeProperty('--chat-shift');
      window.dispatchEvent(new Event(COLUMN_MOVED));
    };
  }, [anchor, shift]);
}

function useCollapsed() {
  const [collapsed, set] = useState(() => localStorage.getItem(COLLAPSED_KEY) === '1');
  const choose = (next) => {
    if (next) localStorage.setItem(COLLAPSED_KEY, '1');
    else localStorage.removeItem(COLLAPSED_KEY);
    set(next);
  };
  return [collapsed, choose];
}

// An open right column no longer folds the panel: if the chat still has room
// beside it, the panel stays.
const modeOf = ({ fits, collapsed }) => (fits && !collapsed ? 'panel' : 'button');

// ---------------------------------------------------------------- sections

// Same small caps as the RUNNING label above the composer, so the two read as
// one family of labels.
const Label = ({ children, count, live }) => (
  <div className="flex h-6 items-center gap-1.5 px-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/75">
    {live && <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500" />}
    {children}
    <span className="tabular-nums">{count}</span>
  </div>
);

function Header({ name, branch, action }) {
  return (
    <div className="flex h-8 items-center gap-1.5 pr-0.5 pl-2 text-[12px]">
      <span className="min-w-0 truncate font-medium text-foreground/90" title={name}>{name}</span>
      {branch && (
        <span className="flex min-w-0 items-center gap-1 text-muted-foreground" title={branch}>
          <GitBranchIcon className="size-3 shrink-0 opacity-70" />
          <span className="truncate">{branch}</span>
        </span>
      )}
      {action && <span className="ml-auto shrink-0">{action}</span>}
    </div>
  );
}

// One per row, labelled, with the browser pages and shells this chat has open
// listed under their row so they can be brought back with the column shut.
const PLACE_ROW = 'flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-[12px] text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50';


// Bringing back whatever a row under a place stands for.
function actOn(act) {
  if (act.tab) revealTab(act.tab);
  else if (act.change) { runCommand('changes', true); selectFile(act.change); }
  else if (act.file) runCommand('openFile', act.file);
  else if (act.worktree) window.conn.project.open({ dir: act.worktree });
}

function Places({ places, onAct }) {
  return (
    <div className="flex flex-col gap-0.5">
      {places.map(({ kind, open, count, items = [], more = 0 }) => {
        const { icon: Icon, label, command } = VIEW_KINDS[kind];
        const shown = count > 0 ? count : items.length + more;
        return (
          <div key={kind} className="flex flex-col gap-0.5">
            <button
              type="button"
              data-overview-place={kind}
              aria-current={open ? 'true' : undefined}
              title={shown > 0 ? `${label} · ${shown}` : label}
              className={cn(PLACE_ROW, open && 'bg-accent text-foreground')}
              onClick={() => { runCommand(command, true); onAct(); }}>
              <Icon className="size-3.5 shrink-0 opacity-70" />
              <span className="truncate">{label}</span>
              {shown > 0 && <span className="ml-auto font-mono text-[10px] tabular-nums">{shown}</span>}
            </button>
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                data-overview-item={item.id}
                title={item.detail ? `${item.label} · ${item.detail}` : item.label}
                aria-current={item.current ? 'true' : undefined}
                className={cn(PLACE_ROW, 'ml-5 h-6 text-[11.5px]', item.current && 'text-foreground')}
                onClick={() => { actOn(item.act); onAct(); }}>
                {item.mark
                  ? <span className="w-2.5 shrink-0 text-center font-mono text-[10px] opacity-70">{MARK[item.mark] || '•'}</span>
                  : <span className="size-1 shrink-0 rounded-full bg-current opacity-50" />}
                <span className="min-w-0 shrink truncate">{item.label}</span>
                {item.detail && <span className="min-w-0 flex-1 truncate text-right font-mono text-[10px] opacity-60">{item.detail}</span>}
              </button>
            ))}
            {more > 0 && (
              <button
                type="button"
                className={cn(PLACE_ROW, 'ml-5 h-6 text-[11.5px] opacity-80')}
                onClick={() => { runCommand(command, true); onAct(); }}>
                {more} more
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

const PR_LOOK = {
  open: { icon: GitPullRequestIcon, tone: 'text-emerald-600 dark:text-emerald-400', word: 'open' },
  draft: { icon: GitPullRequestDraftIcon, tone: 'text-muted-foreground', word: 'draft' },
  merged: { icon: GitMergeIcon, tone: 'text-violet-600 dark:text-violet-400', word: 'merged' },
  closed: { icon: GitPullRequestClosedIcon, tone: 'text-rose-600 dark:text-rose-400', word: 'closed' },
};
const PR_REFRESH_MS = 60_000;

// gh answers for each PR; until it does, or if it cannot, the row has no state.
function usePrStates(prs) {
  const [states, setStates] = useState({});
  const wanted = prs.map(({ repo, number }) => `${repo}#${number}`).join(' ');
  useEffect(() => {
    const ask = window.conn?.prs?.states;
    if (!wanted || !ask) return undefined;
    let live = true;
    const list = wanted.split(' ').map((k) => {
      const at = k.lastIndexOf('#');
      return { repo: k.slice(0, at), number: Number(k.slice(at + 1)) };
    });
    const read = () => ask(list).then((got) => { if (live && got) setStates(got); }).catch(() => {});
    read();
    const t = setInterval(read, PR_REFRESH_MS);
    return () => { live = false; clearInterval(t); };
  }, [wanted]);
  return states;
}

function Prs({ prs, repos, onAct }) {
  const [all, setAll] = useState(false);
  const states = usePrStates(prs);
  const open = (e, url, external) => {
    e.preventDefault();
    openLink(url, external);
    onAct();
  };
  const shown = all ? prs : prs.slice(0, PRS_SHOWN);
  return (
    <div className="flex flex-col">
      <Label count={prs.length}>Pull requests</Label>
      {shown.map(({ url, repo, number, title }) => {
        const look = PR_LOOK[states[`${repo.toLowerCase()}#${number}`]];
        const Icon = look?.icon || GitPullRequestIcon;
        // With no title the repo heads the row, so the number is not said twice.
        const meta = [`#${number}`, title && repos > 1 ? repo : null, look?.word].filter(Boolean).join(' · ');
        return (
          <a
            key={url}
            href={url}
            data-overview-pr={`${repo}#${number}`}
            data-state={look?.word}
            title={[title, linkHint(url)].filter(Boolean).join('\n')}
            className={cn(ROW, 'h-auto items-start py-1.5')}
            onClick={(e) => open(e, url, wantsExternal(e))}
            onAuxClick={(e) => { if (e.button === 1) open(e, url, true); }}>
            <Icon className={cn(ICON, 'mt-0.5', look && cn(look.tone, 'opacity-100'))} />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-foreground/85">{title || repo}</span>
              <span className="truncate font-mono text-[10.5px] text-muted-foreground/75">{meta}</span>
            </span>
          </a>
        );
      })}
      {prs.length > shown.length && (
        <button type="button" className={ROW} onClick={() => setAll(true)}>
          <span className="pl-[22px]">{prs.length - shown.length} more</span>
        </button>
      )}
    </div>
  );
}

// The folder goes after the name, dim and cut from the left, so two index.ts
// read apart and the part of the path that differs is the part that shows.
function Files({ files, total, onAct }) {
  return (
    <div className="flex flex-col">
      <Label count={total}>Edited in this chat</Label>
      {files.map(({ path, rel, name, dir, added, removed }) => (
        <button
          key={path}
          type="button"
          data-overview-file={path}
          title={rel}
          className={ROW}
          onClick={() => { window.connOpenFile(rel); onAct(); }}>
          <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
            <span className="max-w-full shrink-0 truncate text-foreground/85">{name}</span>
            {dir && <span className="min-w-0 truncate text-[11px] text-muted-foreground/60" dir="rtl">{dir}</span>}
          </span>
          <span className="flex shrink-0 gap-1.5 font-mono text-[11px] tabular-nums">
            {added > 0 && <span className="text-emerald-600 dark:text-emerald-400/80">+{added}</span>}
            {removed > 0 && <span className="text-rose-600 dark:text-rose-400/80">-{removed}</span>}
          </span>
        </button>
      ))}
      {total > files.length && (
        <button type="button" className={ROW} onClick={() => { runCommand('changes', true); onAct(); }}>
          {total - files.length} more
        </button>
      )}
    </div>
  );
}

function Background({ tasks, onAct }) {
  useTick(tasks.some((t) => t.at));
  const show = (task) => {
    if (task.kind === 'agent') openSheet(task.id);
    else {
      const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
      document.getElementById(`row-${task.id}`)?.scrollIntoView({ block: 'center', behavior: calm ? 'auto' : 'smooth' });
    }
    onAct();
  };
  return (
    <div className="flex flex-col">
      <Label count={tasks.length} live>Running</Label>
      {tasks.map((task) => {
        const Icon = task.kind === 'agent' ? BotIcon : SquareTerminalIcon;
        return (
          <button key={task.id} type="button" data-overview-task={task.id} title={task.name} className={ROW} onClick={() => show(task)}>
            <Icon className={cn(ICON, 'text-emerald-600 opacity-100 dark:text-emerald-400')} />
            <span className="min-w-0 flex-1 truncate text-foreground/85">{task.name}</span>
            {task.at && (
              <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground/70">{clock(Date.now() - task.at)}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

const SECTIONS = { header: Header, places: Places, prs: Prs, files: Files, background: Background };

// The same content floats beside the chat and drops from the button. `action`
// is the corner control, which sits in the header and, with no header, above.
function OverviewContent({ sections, action, onAct = () => {} }) {
  const headed = sections[0]?.kind === 'header';
  return (
    <div data-slot="overview-content" className="flex flex-col gap-3 p-1">
      {!headed && action && <div className="flex justify-end pb-1">{action}</div>}
      {sections.map(({ kind, ...section }) => {
        const Section = SECTIONS[kind];
        return (
          <div key={kind}>
            <Section {...section} action={kind === 'header' ? action : undefined} onAct={onAct} />
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------- shell

// The chat pane is zoomed to the chat text size, and the panel is chrome like
// the rail, so it undoes that zoom. Its popover is portalled outside the pane
// and already unscaled.
const UNSCALED = { zoom: 'calc(1 / var(--chat-scale, 1))' };

// Below the 38px chat header, and short of the composer at the foot.
const CORNER = 'absolute top-[52px] right-4 z-10 flex max-h-[calc(100%-52px-9rem)] flex-col';

export function ChatOverview({ agent }) {
  const anchor = useRef(null);
  const facts = useFacts(agent);
  const { fits, width, shift } = useFits(anchor);
  const [collapsed, collapse] = useCollapsed();
  const [open, setOpen] = useState(false);

  const items = useDeferredValue(agent.items);
  const { project, name, branch, changes, pane, tabs, folderless, changedFiles, openFile, worktrees } = facts;
  // Fresh lists each render; their contents are what decide a recompute.
  const listsKey = JSON.stringify([tabs, changedFiles, worktrees]);
  const sections = useMemo(
    () => chatOverview(items, { project, name, branch, changes, pane, tabs, folderless, changedFiles, openFile, worktrees }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, project, name, branch, changes, pane, listsKey, folderless, openFile],
  );

  const mode = modeOf({ fits, collapsed });
  useColumnSeat(anchor, mode === 'panel' ? shift : 0);
  const asPanel = (
    <Button variant="ghost" size="icon-xs" aria-label="Show as panel" title="Show as panel" className="text-muted-foreground"
      onClick={() => { collapse(false); setOpen(false); }}>
      <PanelRightOpenIcon />
    </Button>
  );

  return (
    <div
      ref={anchor}
      data-slot={mode === 'panel' ? 'overview-panel' : undefined}
      // The composer's running chip says the same thing, so it steps aside
      // while this panel is listing the work (see FleetStrip).
      data-background={mode === 'panel' && sections.some((x) => x.kind === 'background') ? '' : undefined}
      style={mode === 'panel' ? { ...UNSCALED, width } : UNSCALED}
      className={cn(CORNER, mode === 'panel' && 'conn-rise overflow-y-auto rounded-xl border bg-card p-1.5 shadow-xs')}>
      {mode === 'panel' ? (
        <OverviewContent
          sections={sections}
          action={
            <Button variant="ghost" size="icon-xs" aria-label="Collapse overview" title="Collapse overview"
              className="text-muted-foreground" onClick={() => collapse(true)}>
              <PanelRightCloseIcon />
            </Button>
          } />
      ) : (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              data-slot="overview-button"
              variant="ghost"
              size="icon-sm"
              aria-label="Chat overview"
              title="Chat overview"
              className="text-muted-foreground">
              <LayoutListIcon />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="w-72 max-h-[min(var(--radix-popover-content-available-height),32rem)] overflow-y-auto rounded-xl p-1">
            <OverviewContent sections={sections} action={collapsed && fits ? asPanel : undefined} onAct={() => setOpen(false)} />
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
