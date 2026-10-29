// What the agent thought on its way to the answer: open while it is being
// written, one line once it is done, and one click to read it again.
import { useEffect, useRef, useState } from 'react';
import { BrainIcon, ChevronRightIcon } from 'lucide-react';

import { MessageResponse } from '@/components/ai-elements/message';
import { Shimmer } from '@/components/ai-elements/shimmer';
import { Fold } from '@/components/fold';
import { Button } from '@/components/ui/button';
import { clock, useTick } from '@/lib/clock';
import { thoughtLabel } from '@/lib/reasoning';
import { cn } from '@/lib/utils';

export function ReasoningRow({ item }) {
  const streaming = !!item.streaming;
  const [open, setOpen] = useState(streaming);
  // It folds by itself when it ends, unless the reader has already opened or
  // shut it, and then it stays the way they left it.
  const touched = useRef(false);
  useEffect(() => { if (!touched.current) setOpen(streaming); }, [streaming]);
  useTick(streaming);
  const held = streaming ? Date.now() - item.at : 0;

  return (
    <div className="rounded-md">
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={open}
        onClick={() => { touched.current = true; setOpen((v) => !v); }}
        className="h-7 w-full justify-start gap-1.5 px-1.5 font-normal">
        <ChevronRightIcon
          className={cn('size-3 shrink-0 text-muted-foreground/50 transition-transform', open && 'rotate-90')} />
        <BrainIcon className="size-3.5 shrink-0 text-muted-foreground" />
        {streaming
          ? <Shimmer as="span" className="shrink-0 text-[13px]">Thinking</Shimmer>
          : <span className="shrink-0 text-[13px] text-muted-foreground">{thoughtLabel(item)}</span>}
        {held >= 2000 && (
          <span className="conn-in ml-auto shrink-0 pl-2 font-mono text-[11px] tabular-nums text-muted-foreground/70">
            {clock(held)}
          </span>
        )}
      </Button>
      <Fold open={open} className="ml-3 border-l pb-1 pl-3">
        <MessageResponse
          className={cn('text-[13px] text-muted-foreground', streaming && 'conn-streaming')}
          isAnimating={streaming}>
          {item.text}
        </MessageResponse>
      </Fold>
    </div>
  );
}
