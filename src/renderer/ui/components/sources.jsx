import { useState } from 'react';
import { ChevronRightIcon, GlobeIcon } from 'lucide-react';

import { ChatLink } from '@/components/chat-link';
import { Fold } from '@/components/fold';
import { sourceLabel } from '@/lib/sources';
import { cn } from '@/lib/utils';

// No favicons: fetching one would tell its site that this chat read it.
export function SourceList({ sources, className }) {
  return (
    <ul data-slot="source-list" className={cn('flex flex-col gap-1', className)}>
      {sources.map((s) => (
        <li key={s.url} className="flex min-w-0 items-start gap-1.5 text-[13px]">
          <GlobeIcon className="mt-[3px] size-3 shrink-0 text-muted-foreground/70" />
          <span className="line-clamp-2 min-w-0">
            <ChatLink href={s.url} className="font-normal">{sourceLabel(s)}</ChatLink>
            {s.title && <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">{s.host}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function Sources({ sources }) {
  const [open, setOpen] = useState(false);
  return (
    <div data-sources className="conn-in mt-1 text-xs">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">
        <ChevronRightIcon className={cn('size-3 shrink-0 text-muted-foreground/50 transition-transform', open && 'rotate-90')} />
        Used {sources.length} {sources.length === 1 ? 'source' : 'sources'}
      </button>
      <Fold open={open} className="pt-1 pl-4"><SourceList sources={sources} /></Fold>
    </div>
  );
}
