import { useDeferredValue, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  BotIcon, GitBranchIcon, GitPullRequestIcon, LayoutListIcon, PanelRightCloseIcon, PanelRightOpenIcon, SquareTerminalIcon,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { linkHint, openLink, wantsExternal } from '@/lib/links';
import { chatOverview, PRS_SHOWN } from '@/lib/overview';
import { cn } from '@/lib/utils';

import { useProject } from '../useProject';
import { runCommand } from '../../app.js';
import { openSheet } from '../shell/agents-store.js';
import { useFocusedDir, useLayout, VIEW_KINDS } from '../shell/Shell';
import { activeKind, getTabsVersion, subscribeTabs } from '../shell/tabs-store';

// The panel is w-56 at right-4, and wants as much again between it and the
// column. Tailwind cannot read these, so the classes below repeat them.
const PANEL_REM = 14;
const MARGIN_REM = 1;
const COLLAPSED_KEY = 'conn.overview.collapsed';

// Every row in every section is this one shape, so the panel reads as a list.
const ROW = 'flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-[13px] text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50';
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
  const [fits, setFits] = useState(false);
  useLayoutEffect(() => {
    const root = anchor.current?.parentElement;
    const column = root?.querySelector('[data-chat-column]');
    if (!root || !column) return undefined;
    const measure = () => {
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
      const gutter = root.getBoundingClientRect().right - column.getBoundingClientRect().right;
      setFits(gutter >= (PANEL_REM + 2 * MARGIN_REM) * rem);
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(root);
    watch.observe(column);
    return () => watch.disconnect();
  }, [anchor]);
  return fits;
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

const Label = ({ children, count }) => (
  <div className="flex h-6 items-end px-2 pb-1 text-[11px] text-muted-foreground/70">
    {children}<span className="ml-1.5 tabular-nums">{count}</span>
  </div>
);

function Header({ name, branch, action }) {
  return (
    <div className="flex h-7 items-center gap-1.5 pr-0.5 pl-2 text-[12px] text-muted-foreground/80">
      <span className="min-w-0 truncate" title={name}>{name}</span>
      {branch && (
        <span className="flex min-w-0 items-center gap-1" title={branch}>
          <GitBranchIcon className="size-3 shrink-0 opacity-70" />
          <span className="truncate">{branch}</span>
        </span>
      )}
      {action && <span className="ml-auto shrink-0">{action}</span>}
    </div>
  );
}

function Places({ places, onAct }) {
  return (
    <div className="flex flex-col">
      {places.map(({ kind, open, count }) => {
        const { icon: Icon, label, command } = VIEW_KINDS[kind];
        return (
          <button
            key={kind}
            type="button"
            data-overview-place={kind}
            aria-current={open ? 'true' : undefined}
            className={cn(ROW, open && 'bg-accent text-foreground')}
            onClick={() => { runCommand(command, true); onAct(); }}>
            <Icon className={ICON} />
            <span className="truncate">{label}</span>
            {count > 0 && <span className="ml-auto font-mono text-[11px] tabular-nums">{count}</span>}
          </button>
        );
      })}
    </div>
  );
}

function Prs({ prs, repos, onAct }) {
  const [all, setAll] = useState(false);
  const open = (e, url, external) => {
    e.preventDefault();
    openLink(url, external);
    onAct();
  };
  const shown = all ? prs : prs.slice(0, PRS_SHOWN);
  return (
    <div className="flex flex-col">
      <Label count={prs.length}>Pull requests</Label>
      {shown.map(({ url, repo, number, title }) => (
        <a
          key={url}
          href={url}
          data-overview-pr={`${repo}#${number}`}
          title={[title, linkHint(url)].filter(Boolean).join('\n')}
          className={ROW}
          onClick={(e) => open(e, url, wantsExternal(e))}
          onAuxClick={(e) => { if (e.button === 1) open(e, url, true); }}>
          <GitPullRequestIcon className={ICON} />
          <span className="shrink-0 tabular-nums text-foreground/80">#{number}</span>
          <span className="truncate">{title || (repos > 1 ? repo : '')}</span>
        </a>
      ))}
      {prs.length > shown.length && (
        <button type="button" className={ROW} onClick={() => setAll(true)}>
          <span className="pl-[22px]">{prs.length - shown.length} more</span>
        </button>
      )}
    </div>
  );
}

function Files({ files, total, onAct }) {
  return (
    <div className="flex flex-col">
      <Label count={total}>Files changed</Label>
      {files.map(({ path, rel, added, removed }) => (
        <button
          key={path}
          type="button"
          data-overview-file={path}
          title={rel}
          className={ROW}
          onClick={() => { window.connOpenFile(rel); onAct(); }}>
          <span className="min-w-0 flex-1 truncate">{rel.split('/').pop()}</span>
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
      <Label count={tasks.length}>Running in background</Label>
      {tasks.map((task) => {
        const Icon = task.kind === 'agent' ? BotIcon : SquareTerminalIcon;
        return (
          <button key={task.id} type="button" data-overview-task={task.id} title={task.name} className={ROW} onClick={() => show(task)}>
            <Icon className={cn(ICON, 'text-emerald-600 opacity-100 dark:text-emerald-400')} />
            <span className="truncate">{task.name}</span>
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
    <div data-slot="overview-content" className="flex flex-col gap-2 p-1">
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

// Below the 38px chat header, and short of the composer at the foot.
const CORNER = 'absolute top-[52px] right-4 z-10 flex max-h-[calc(100%-52px-9rem)] flex-col';

export function ChatOverview({ agent }) {
  const anchor = useRef(null);
  const facts = useFacts(agent);
  const { rightOpen } = useLayout();
  const fits = useFits(anchor);
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
      className={cn(CORNER, mode === 'panel' && 'conn-rise w-56 overflow-y-auto')}>
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
            className="w-60 max-h-[min(var(--radix-popover-content-available-height),32rem)] overflow-y-auto rounded-xl p-1">
            <OverviewContent sections={sections} action={collapsed && fits ? asPanel : undefined} onAct={() => setOpen(false)} />
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
