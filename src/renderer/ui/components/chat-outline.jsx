// The turn outline in the gutter left of the chat column, and its ticks on the
// scrollbar. Both are drawn from lib/outline.js. The outline is the quiet one
// of the two side panels: a stack of thin bars, the turn you are reading the
// longest, and the message shown beside a bar while it is hovered.
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

// Each turn is a bar. The bar is coloured by what the turn did, and the one
// you are reading is longer and solid.
const BAR = {
  waiting: 'bg-amber-500',
  error: 'bg-rose-500',
  edit: 'bg-emerald-500',
  pr: 'bg-violet-500',
};
const toneBar = (turn) => (turn.waiting ? 'waiting' : turn.errors > 0 ? 'error' : turn.prs > 0 ? 'pr' : turn.files > 0 ? 'edit' : null);

// Widths in px, by distance from the hovered bar: the hovered one stretches
// and its neighbours lean after it, so moving down the stack ripples.
const REST = 14;
const HERE = 22;
const GROW = [34, 26, 20];

function widthOf(i, hover, here) {
  const base = here ? HERE : REST;
  if (hover == null) return base;
  const d = Math.abs(i - hover);
  return d < GROW.length ? Math.max(base, GROW[d]) : base;
}

function Outline({ turns, current, onJump, width }) {
  const list = useRef(null);
  const [hover, setHover] = useState(null);
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
      className="conn-rise pointer-events-none absolute top-3 bottom-3 left-4 z-10 flex flex-col justify-center">
      <div
        ref={list}
        className="pointer-events-auto relative flex max-h-full min-h-0 flex-col overflow-y-auto overflow-x-hidden py-6 [scrollbar-width:none]"
        onMouseLeave={() => setHover(null)}>
        {turns.map((turn, i) => {
          const here = turn.id === current;
          const summary = summaryOf(turn);
          const tone = toneBar(turn);
          const open = hover === i;
          return (
            <button
              key={turn.id}
              type="button"
              data-outline-turn={turn.id}
              aria-current={here ? 'location' : undefined}
              aria-label={summary ? `${turn.text}. ${summary}` : turn.text}
              onClick={() => onJump(turn.id)}
              onMouseEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              className="group/turn relative flex h-3 w-full shrink-0 items-center rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
              <span
                aria-hidden="true"
                style={{ width: widthOf(i, hover, here) }}
                className={cn(
                  'h-[3px] shrink-0 rounded-full transition-[width,background-color,opacity] duration-200 ease-[cubic-bezier(.2,.8,.2,1)]',
                  tone ? BAR[tone] : 'bg-foreground',
                  here || open ? 'opacity-100' : tone ? 'opacity-70' : 'opacity-25',
                  tone === 'waiting' && 'animate-pulse',
                )} />
              {/* The message itself, drawn the way the chat draws it. */}
              <span
                className={cn(
                  'pointer-events-none absolute top-1/2 left-10 z-10 max-w-[calc(100%-2.5rem)] -translate-y-1/2 origin-left rounded-xl bg-secondary px-3 py-1.5 text-left text-[12px] text-foreground shadow-sm transition-[opacity,transform] duration-200 ease-[cubic-bezier(.2,.8,.2,1)]',
                  open ? 'translate-x-0 scale-100 opacity-100' : '-translate-x-1 scale-95 opacity-0',
                )}>
                <span className="block truncate">{turn.text}</span>
                {summary && <span className="block truncate text-[10.5px] text-muted-foreground">{summary}</span>}
              </span>
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
