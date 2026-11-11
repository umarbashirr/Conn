// The turn outline in the gutter left of the chat column, and its ticks on the
// scrollbar. Both are drawn from lib/outline.js. The outline is the quiet one
// of the two side panels: no card, muted rows, the turn you are reading marked.
// It shows only when a chat has turns worth finding and the gutter has room;
// the ticks show at any width.
import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStickToBottomContext } from 'use-stick-to-bottom';

import { chatOutline, OUTLINE_MIN_TURNS, summaryOf, toneOf } from '@/lib/outline';
import { cn } from '@/lib/utils';

// Same sizes as the overview panel on the right, so the two sit as a pair.
const PANEL_REM = 12;
const MAX_REM = 16;
const MARGIN_REM = 1;
// The turn you are reading is the last one to start above this line.
const READ_LINE = 0.3;
// The chat pane is zoomed to the chat text size; this is chrome, like the rail.
const UNSCALED = { zoom: 'calc(1 / var(--chat-scale, 1))' };

const DOT = {
  waiting: 'bg-amber-500',
  error: 'bg-rose-500',
  edit: 'bg-emerald-500',
  pr: 'bg-violet-500',
};
const TICK = {
  waiting: 'bg-amber-500',
  error: 'bg-rose-500',
  edit: 'bg-emerald-500/80',
};

// Asks the transcript to draw back to `id` if it is above the rows on screen
// (the transcript keeps only the latest rows until asked), then scrolls to it.
export const SHOW_TURN = 'conn:show-turn';

const rowOf = (content, id) => content?.querySelector(`[data-turn="${CSS.escape(id)}"]`);
const topOf = (content, row) => row.offsetTop - content.offsetTop;

function useGutter(anchor) {
  const [fit, setFit] = useState({ fits: false, width: 0 });
  useLayoutEffect(() => {
    const root = anchor.current?.parentElement;
    const column = root?.querySelector('[data-chat-column]');
    if (!root || !column) return undefined;
    const measure = () => {
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
      const room = column.getBoundingClientRect().left - root.getBoundingClientRect().left - 2 * MARGIN_REM * rem;
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

// Which turn is being read, and where each drawn turn sits on the scroll track
// as a fraction of it. Read on scroll and on resize, one frame at a time.
function usePlaces(turns) {
  const { scrollRef, contentRef } = useStickToBottomContext();
  const [state, setState] = useState({ current: null, marks: [] });
  const ids = turns.map((t) => t.id).join(' ');

  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return undefined;
    let frame = 0;
    const read = () => {
      frame = 0;
      // The pin's breathing room is padding below the content, not transcript.
      const natural = el.scrollHeight - (parseFloat(el.style.paddingBottom) || 0);
      const line = el.scrollTop + el.clientHeight * READ_LINE;
      let current = null;
      const marks = [];
      for (const id of ids ? ids.split(' ') : []) {
        const row = rowOf(content, id);
        if (!row) continue;
        const top = topOf(content, row);
        // The last turn to start above the line, or the first drawn if none has.
        if (top <= line || current === null) current = id;
        marks.push({ id, at: natural > 0 ? top / natural : 0 });
      }
      setState((prev) => (prev.current === current && JSON.stringify(prev.marks) === JSON.stringify(marks) ? prev : { current, marks }));
    };
    const soon = () => { if (!frame) frame = requestAnimationFrame(read); };
    read();
    el.addEventListener('scroll', soon, { passive: true });
    const watch = new ResizeObserver(soon);
    watch.observe(el);
    watch.observe(content);
    return () => {
      el.removeEventListener('scroll', soon);
      watch.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [scrollRef, contentRef, ids]);
  return state;
}

function useJump() {
  const { scrollRef, contentRef, stopScroll } = useStickToBottomContext();
  return useCallback((id) => {
    const go = (tries) => {
      const el = scrollRef.current;
      const content = contentRef.current;
      const row = rowOf(content, id);
      if (!row) {
        // Not drawn yet: ask once, then give the transcript a few frames.
        if (tries === 0) window.dispatchEvent(new CustomEvent(SHOW_TURN, { detail: { id } }));
        if (tries < 10) requestAnimationFrame(() => go(tries + 1));
        return;
      }
      // Off the bottom lock first, or the next reply drags the view away.
      stopScroll();
      const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
      el.scrollTo({ top: Math.max(0, topOf(content, row) - 12), behavior: calm ? 'auto' : 'smooth' });
    };
    go(0);
  }, [scrollRef, contentRef, stopScroll]);
}

function Marks({ turn }) {
  const dots = [
    turn.waiting && 'waiting',
    turn.errors > 0 && 'error',
    turn.files > 0 && 'edit',
    turn.prs > 0 && 'pr',
  ].filter(Boolean);
  if (!dots.length) return null;
  return (
    <span className="flex shrink-0 items-center gap-0.5" aria-hidden="true">
      {dots.map((d) => <span key={d} className={cn('size-1.5 rounded-full', DOT[d], d === 'waiting' && 'animate-pulse')} />)}
    </span>
  );
}

function Outline({ turns, current, onJump, width }) {
  const list = useRef(null);
  // Keep the turn being read in view inside the outline's own scroll, without
  // scrollIntoView, which would move the chat as well.
  useEffect(() => {
    const box = list.current;
    const row = current && box?.querySelector(`[data-outline-turn="${CSS.escape(current)}"]`);
    if (!row) return;
    if (row.offsetTop < box.scrollTop) box.scrollTop = row.offsetTop - 4;
    else if (row.offsetTop + row.offsetHeight > box.scrollTop + box.clientHeight) {
      box.scrollTop = row.offsetTop + row.offsetHeight - box.clientHeight + 4;
    }
  }, [current]);

  return (
    <nav
      aria-label="Turns in this chat"
      data-slot="chat-outline"
      style={{ ...UNSCALED, width }}
      className="conn-rise absolute top-3 bottom-3 left-4 z-10 flex flex-col">
      <div className="flex h-6 shrink-0 items-center gap-1.5 px-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
        Turns <span className="tabular-nums">{turns.length}</span>
      </div>
      <div ref={list} className="relative min-h-0 overflow-y-auto">
        {turns.map((turn, i) => {
          const here = turn.id === current;
          const summary = summaryOf(turn);
          return (
            <button
              key={turn.id}
              type="button"
              data-outline-turn={turn.id}
              aria-current={here ? 'location' : undefined}
              title={summary ? `${turn.text}\n${summary}` : turn.text}
              onClick={() => onJump(turn.id)}
              className={cn(
                'flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-[12px] text-muted-foreground/80 outline-none transition-colors',
                'hover:bg-accent/70 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50',
                here && 'bg-accent/60 text-foreground',
              )}>
              <span className="w-4 shrink-0 text-right font-mono text-[10px] tabular-nums text-muted-foreground/50">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate">{turn.text}</span>
              <Marks turn={turn} />
            </button>
          );
        })}
      </div>
    </nav>
  );
}

// On the scrollbar's track, a tick for each drawn turn that did something worth
// finding: an edit, an error, a card waiting. A grey tick for every other turn
// read as a rendering glitch. Not clickable: the track is still the scrollbar.
function Ticks({ turns, marks, current }) {
  const byId = useMemo(() => new Map(turns.map((t) => [t.id, t])), [turns]);
  return (
    <div aria-hidden="true" data-slot="chat-ticks" className="pointer-events-none absolute inset-y-1 right-0 z-10 w-1.5">
      {marks.map(({ id, at }) => {
        const turn = byId.get(id);
        if (!turn || toneOf(turn) === 'plain') return null;
        return (
          <span
            key={id}
            data-tick={toneOf(turn)}
            style={{ top: `${(at * 100).toFixed(2)}%` }}
            className={cn('absolute right-0.5 h-0.5 rounded-full', TICK[toneOf(turn)], id === current ? 'w-1.5' : 'w-1')} />
        );
      })}
    </div>
  );
}

export function ChatOutline({ items }) {
  const anchor = useRef(null);
  const deferred = useDeferredValue(items);
  const turns = useMemo(() => chatOutline(deferred), [deferred]);
  const enough = turns.length >= OUTLINE_MIN_TURNS;
  const { fits, width } = useGutter(anchor);
  const { current, marks } = usePlaces(enough ? turns : []);
  const jump = useJump();

  return (
    <>
      <span ref={anchor} hidden />
      {enough && fits && <Outline turns={turns} current={current} onJump={jump} width={width} />}
      {enough && <Ticks turns={turns} marks={marks} current={current} />}
    </>
  );
}
