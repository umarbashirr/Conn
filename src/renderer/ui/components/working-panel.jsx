// The floor of the chat: what is still working, and the way back down. The
// row that started a subagent scrolls away while it is still going, so the
// pill sits where the reader is already looking and says how many are.
import { useEffect, useState } from 'react';
import { XIcon } from 'lucide-react';

import { ConversationScrollButton } from '@/components/ai-elements/conversation';
import { Shimmer } from '@/components/ai-elements/shimmer';
import { Spinner, SubagentGlyph } from '@/components/subagent-glyph';
import { Button } from '@/components/ui/button';
import { activityOf, nameOf } from '@/lib/subagents';
import { cn } from '@/lib/utils';

function WorkingPanel({ agents, onOpen, onStopAll, onClose }) {
  const stoppable = agents.some((a) => a.taskId && a.status === 'running');
  return (
    <div data-slot="working-panel" className="conn-rise pointer-events-auto rounded-xl border bg-popover shadow-lg">
      <div className="flex items-center gap-1 border-b py-1 pr-1 pl-3">
        <span className="flex-1 text-[13px] text-muted-foreground">Working</span>
        <Button
          variant="ghost"
          size="xs"
          disabled={!stoppable}
          title={stoppable ? 'Stop every agent still working' : 'None of these can be stopped on its own'}
          onClick={onStopAll}>
          Stop All
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label="Close" title="Close" onClick={onClose}>
          <XIcon />
        </Button>
      </div>
      <div className="max-h-56 overflow-y-auto py-1">
        {agents.map((a) => (
          <button
            key={a.id}
            type="button"
            data-subagent={a.id}
            onClick={() => onOpen(a)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-secondary/60">
            <SubagentGlyph item={a} />
            <span className="max-w-[45%] shrink-0 truncate text-[13px]">{nameOf(a)}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
              <Shimmer as="span">{activityOf(a)}</Shimmer>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function ChatFloor({ agents, onOpen, onStopAll }) {
  const [open, setOpen] = useState(false);
  useEffect(() => { if (!agents.length) setOpen(false); }, [agents.length]);

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 mx-auto flex w-full max-w-3xl flex-col gap-2 px-4">
      {open && (
        <WorkingPanel
          agents={agents}
          onOpen={(a) => { setOpen(false); onOpen(a); }}
          onStopAll={onStopAll}
          onClose={() => setOpen(false)} />
      )}
      <div className={cn('flex items-center gap-2', !agents.length && 'justify-center')}>
        {agents.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            data-slot="working-pill"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="conn-rise pointer-events-auto h-9 gap-2 rounded-full bg-background px-3 font-normal dark:bg-background">
            <Spinner className="text-primary" />
            Working
            <span className="tabular-nums text-muted-foreground">{agents.length}</span>
          </Button>
        )}
        <ConversationScrollButton className="pointer-events-auto static translate-x-0" />
      </div>
    </div>
  );
}
