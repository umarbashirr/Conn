/* The Board: every agent at once, sorted by what it wants from you.

   It takes the chat's place, with the rail left where it is, because the rail
   is how you get back to one folder and the Board is how you see all of them.
   Four lanes, decided in lib/board: Needs you, Working, Done and Recent. A card
   opens its chat, in this window or in whichever window holds it. Claude Code
   sessions running outside Conn are shown for what they are, read only. */
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { CopyIcon, GitForkIcon, LayoutDashboardIcon, LoaderCircleIcon, RefreshCwIcon, SquareTerminalIcon, XIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ProviderLogo } from '@/components/provider-logo';
import { LANES, lineOf, placeOf, RECENT_SHOWN } from '@/lib/board';
import { cn } from '@/lib/utils';
import { getRailVersion, relative, subscribeRail } from '../shell/rail-store';
import { boardState, closeBoard, getBoardVersion, lanesNow, openCard, refreshBoard, subscribeBoard } from '../shell/board-store';
import { toast } from '../shell/toast';

const DOT = {
  needs: 'bg-amber-500',
  working: null,
  done: 'bg-[hsl(var(--token-conn))]',
  recent: 'bg-foreground/25',
};

function Where({ card }) {
  if (card.where === 'peer') return <span className="shrink-0 rounded border px-1 text-[10px] text-muted-foreground">other window</span>;
  if (card.where !== 'outside') return null;
  return (
    <span className="flex shrink-0 items-center gap-1 rounded border px-1 text-[10px] text-muted-foreground">
      <SquareTerminalIcon className="size-2.5" />
      {card.kind === 'background' ? 'background' : 'terminal'}
    </span>
  );
}

function Card({ card, lane }) {
  const place = placeOf(card.project);
  const line = lineOf(card);
  const outside = card.where === 'outside';
  const attach = outside && card.kind === 'background' && card.short ? `claude attach ${card.short}` : null;

  const open = async () => {
    if (outside) {
      if (!attach) return;
      navigator.clipboard?.writeText(attach);
      toast('Copied', `${attach} opens it in a terminal.`);
      return;
    }
    const res = await openCard(card);
    if (res?.error) toast('Could not open that chat', res.error);
  };

  return (
    <button
      type="button"
      data-slot="board-card"
      data-lane={lane}
      data-where={card.where}
      aria-label={card.title}
      title={outside ? (attach ? `Copy "${attach}"` : 'Running in a terminal outside Conn') : `Open ${card.title}`}
      onClick={open}
      className={cn(
        'group flex w-full min-w-0 flex-col gap-1 overflow-hidden rounded-lg border bg-card px-3 py-2 text-left shadow-xs transition-colors',
        'hover:border-foreground/20 hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        outside && !attach && 'cursor-default',
      )}>
      <span className="flex w-full min-w-0 items-center gap-2">
        <span className="flex size-3.5 shrink-0 items-center justify-center">
          {lane === 'working' ? (
            <LoaderCircleIcon className="size-3.5 animate-spin text-[hsl(var(--success))]" />
          ) : (
            <span aria-hidden className={cn('size-2 rounded-full', DOT[lane], card.failed && 'bg-destructive')} />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{card.title}</span>
        {card.at > 0 && <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{relative(card.at)}</span>}
      </span>
      <span className="flex w-full min-w-0 items-center gap-1.5 pl-5.5 text-[11px] text-muted-foreground">
        {card.provider && <ProviderLogo id={card.provider} className="size-3 shrink-0" />}
        <span className="truncate" title={card.project}>{place.name}</span>
        {place.worktree && (
          <span className="flex min-w-0 shrink items-center gap-0.5 truncate" title={`Worktree ${place.worktree}`}>
            <GitForkIcon className="size-2.5 shrink-0" />
            <span className="truncate">{place.worktree}</span>
          </span>
        )}
        <span className="ml-auto" />
        <Where card={card} />
      </span>
      {line && (
        <span className={cn('truncate pl-5.5 text-[12px]', card.failed ? 'text-destructive' : 'text-foreground/75')}>{line}</span>
      )}
      {attach && (
        <span className="flex items-center gap-1 pl-5.5 font-mono text-[11px] text-muted-foreground">
          <CopyIcon className="size-3" />
          {attach}
        </span>
      )}
    </button>
  );
}

function Lane({ lane, cards }) {
  // Recent can be a whole day of chats. The others are what needs doing, and
  // hiding any of those would be hiding work.
  const capped = lane.id === 'recent' && cards.length > RECENT_SHOWN;
  const shown = capped ? cards.slice(0, RECENT_SHOWN) : cards;
  return (
    <section data-slot="board-lane" data-lane={lane.id} aria-label={lane.label} className="flex min-h-0 min-w-0 flex-col rounded-xl bg-muted/40 p-2">
      <header className="flex items-center gap-2 px-1 pb-2">
        <span className="text-[12px] font-medium">{lane.label}</span>
        <span data-slot="board-count" className="rounded-full bg-background px-1.5 text-[11px] text-muted-foreground tabular-nums">{cards.length}</span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
        {shown.map((c) => <Card key={`${c.where}:${c.pid || ''}:${c.key || c.id}`} card={c} lane={lane.id} />)}
        {!cards.length && <p className="px-1 py-2 text-[12px] text-muted-foreground">{lane.empty}</p>}
        {capped && <p className="px-1 py-1 text-[11px] text-muted-foreground">{cards.length - RECENT_SHOWN} more, older</p>}
      </div>
    </section>
  );
}

export function BoardPage() {
  useSyncExternalStore(subscribeBoard, getBoardVersion, getBoardVersion);
  const railVersion = useSyncExternalStore(subscribeRail, getRailVersion, getRailVersion);
  const st = boardState();
  const lanes = useMemo(() => lanesNow(), [railVersion, st.at, st.peers, st.outside]);

  // Toasts land below the Board's header rather than on its buttons.
  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty('--toast-top', '84px');
    return () => root.removeProperty('--toast-top');
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const t = e.target;
      if (t instanceof Element && t.closest('input, textarea, [contenteditable="true"], [role="dialog"], [role="menu"]')) return;
      e.preventDefault();
      closeBoard();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const windows = st.peers.length;
  const outsideNote = st.outside && !st.outside.ok && !st.outside.unsupported ? st.outside.error : null;

  return (
    <div data-slot="board-page" className="@container flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="flex h-[38px] flex-none items-center gap-2 border-b border-border/60 px-4 text-sm">
        <LayoutDashboardIcon className="size-4 text-muted-foreground" />
        <span className="font-medium">Board</span>
        <span className="truncate text-[12px] text-muted-foreground">
          {windows ? `This window and ${windows} other${windows === 1 ? '' : 's'}` : 'This window'}
          {st.outside?.ok ? ', plus Claude Code outside Conn' : ''}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="icon-xs" aria-label="Refresh the board" title="Ask the other windows and Claude Code again" onClick={() => refreshBoard()}>
            <RefreshCwIcon />
          </Button>
          <Button variant="ghost" size="icon-xs" aria-label="Close the board" title="Back to the chat (Esc)" onClick={closeBoard}>
            <XIcon />
          </Button>
        </div>
      </div>
      {/* Columns follow the Board's own width, which the window's does not say:
          the right column can still be opened beside it. minmax(0, 1fr) lets a
          lane be narrower than its longest title, which then truncates. */}
      <div
        data-slot="board-lanes"
        className="grid min-h-0 flex-1 grid-cols-[repeat(4,minmax(0,1fr))] gap-2 p-3 @max-4xl:auto-rows-[minmax(16rem,1fr)] @max-4xl:grid-cols-[repeat(2,minmax(0,1fr))] @max-4xl:overflow-y-auto @max-xl:grid-cols-[minmax(0,1fr)]">
        {LANES.map((lane) => <Lane key={lane.id} lane={lane} cards={lanes[lane.id]} />)}
      </div>
      {outsideNote && (
        <p className="flex-none border-t px-4 py-1.5 text-[11px] text-muted-foreground">Claude Code sessions outside Conn: {outsideNote}</p>
      )}
    </div>
  );
}
