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
import { activeKind, getTabsVersion, subscribeTabs } from '../shell/tabs-store';

// The panel sits at right-4 and wants as much again between it and the column.
// It grows into a wide gutter up to MAX_REM, so titles stop truncating while
// there is room beside them. Tailwind cannot read these, so CORNER repeats the
// margin.
const PANEL_REM = 14;
const MAX_REM = 20;
const MARGIN_REM = 1;
const COLLAPSED_KEY = 'conn.overview.collapsed';

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

  const project = agent.folderless ? null : info.projects?.find((p) => p.dir === agent.project) || info;
  return {
    project: project?.dir || null,
    name: project?.name || 'No folder',
    branch: project?.branch || null,
    changes: layout.changesCount,
    pane: layout.rightOpen ? activeKind(dir) : null,
    folderless: !!agent.folderless,
  };
}

// Whether the gutter right of the chat column holds the panel. Measured, since
// the column is centred and the window, the rail and the right column all move it.
function useFits(anchor) {
  const [fit, setFit] = useState({ fits: false, width: 0 });
  useLayoutEffect(() => {
    const root = anchor.current?.parentElement;
    const column = root?.querySelector('[data-chat-column]');
    if (!root || !column) return undefined;
    const measure = () => {
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
      const gutter = root.getBoundingClientRect().right - column.getBoundingClientRect().right;
      const room = gutter - 2 * MARGIN_REM * rem;
      setFit({ fits: room >= PANEL_REM * rem, width: Math.round(Math.min(room, MAX_REM * rem)) });
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(root);
    watch.observe(column);
    return () => watch.disconnect();
  }, [anchor]);
  return fit;
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

const modeOf = ({ fits, rightOpen, collapsed }) => (fits && !rightOpen && !collapsed ? 'panel' : 'button');

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

// The toolbar already has a button for each of these, so here they are one
// row of icons rather than four rows of the panel. The label stays in the
// accessible name and the tooltip.
function Places({ places, onAct }) {
  return (
    <div className="flex gap-0.5">
      {places.map(({ kind, open, count }) => {
        const { icon: Icon, label, command } = VIEW_KINDS[kind];
        return (
          <button
            key={kind}
            type="button"
            data-overview-place={kind}
            aria-current={open ? 'true' : undefined}
            title={count > 0 ? `${label} · ${count}` : label}
            className={cn(
              'flex h-7 min-w-0 flex-1 items-center justify-center gap-1 rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50',
              open && 'bg-background text-foreground shadow-xs dark:bg-accent',
            )}
            onClick={() => { runCommand(command, true); onAct(); }}>
            <Icon className="size-3.5 shrink-0" />
            <span className="sr-only">{label}</span>
            {count > 0 && <span className="font-mono text-[10px] tabular-nums">{count}</span>}
          </button>
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
  const { rightOpen } = useLayout();
  const { fits, width } = useFits(anchor);
  const [collapsed, collapse] = useCollapsed();
  const [open, setOpen] = useState(false);

  const items = useDeferredValue(agent.items);
  const { project, name, branch, changes, pane, folderless } = facts;
  const sections = useMemo(
    () => chatOverview(items, { project, name, branch, changes, pane, folderless }),
    [items, project, name, branch, changes, pane, folderless],
  );

  const mode = modeOf({ fits, rightOpen, collapsed });
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
      className={cn(CORNER, mode === 'panel' && 'conn-rise overflow-y-auto rounded-xl bg-muted/40 p-1 dark:bg-muted/25')}>
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
