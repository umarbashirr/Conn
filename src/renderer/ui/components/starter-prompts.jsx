import { useEffect, useState } from 'react';
import { starterPrompts, readFacts } from '@/lib/starters';
import { Button } from '@/components/ui/button';

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

export function StarterPrompts({ folder, onPick }) {
  const prompts = starterPrompts(useFacts(folder));
  if (!prompts.length) return null;
  return (
    <div
      role="group"
      aria-label="Starter prompts"
      data-starter-prompts
      className="flex flex-wrap justify-center gap-2 pb-1">
      {prompts.map((p) => (
        <Button
          key={p.text}
          variant="outline"
          size="sm"
          className="rounded-full text-muted-foreground"
          onClick={() => onPick(p.text)}>
          {p.text}
        </Button>
      ))}
    </div>
  );
}
