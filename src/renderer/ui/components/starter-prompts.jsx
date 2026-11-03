import { useEffect, useRef, useState } from 'react';
import { starterPrompts, readFacts } from '@/lib/starters';
import { Button } from '@/components/ui/button';

const FADE = 28;

// Read again when the window regains focus, which is when edits made in an
// editor or a terminal elsewhere have just become something to ask about.
function useFacts(dir) {
  const [read, setRead] = useState({ dir: undefined, facts: null });
  useEffect(() => {
    let live = true;
    const load = () => readFacts(window.conn, dir).then((facts) => { if (live) setRead({ dir, facts }); });
    load();
    window.addEventListener('focus', load);
    return () => { live = false; window.removeEventListener('focus', load); };
  }, [dir]);
  return read.dir === dir ? read.facts : null;
}

// Fades only the side that has more to scroll to.
function useEdges() {
  const ref = useRef(null);
  const [edges, setEdges] = useState({ start: false, end: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => setEdges({
      start: el.scrollLeft > 1,
      end: el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
    });
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => { el.removeEventListener('scroll', measure); ro.disconnect(); };
  });
  return [ref, edges];
}

export function StarterPrompts({ folder, onPick }) {
  const prompts = starterPrompts(useFacts(folder));
  const [ref, edges] = useEdges();
  if (!prompts.length) return null;

  const mask = `linear-gradient(to right, ${edges.start ? 'transparent' : 'black'}, black ${FADE}px, black calc(100% - ${FADE}px), ${edges.end ? 'transparent' : 'black'})`;
  return (
    <div
      ref={ref}
      role="group"
      aria-label="Starter prompts"
      data-starter-prompts
      style={{ maskImage: mask, WebkitMaskImage: mask }}
      className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {prompts.map((p) => (
        <Button
          key={p.text}
          variant="outline"
          size="sm"
          className="shrink-0 rounded-full text-muted-foreground"
          onClick={() => onPick(p.text)}>
          {p.text}
        </Button>
      ))}
    </div>
  );
}
