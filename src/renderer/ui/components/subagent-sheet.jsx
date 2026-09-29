// One subagent, opened over the chat it belongs to. The chat stays where it
// was underneath, so closing the sheet puts the reader back where they left.
import { ArrowLeftIcon, Maximize2Icon, Minimize2Icon, XIcon } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { Conversation, ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation';
import { SubagentGlyph } from '@/components/subagent-glyph';
import { SubagentStream, useSubagentTranscript } from '@/components/subagent-stream';
import { Button } from '@/components/ui/button';
import { nameOf } from '@/lib/subagents';
import { cn } from '@/lib/utils';

export function SubagentSheet({ item, agent, Items, full, onToggleFull, onClose }) {
  useSubagentTranscript(agent, item, true);
  const ref = useRef(null);
  useEffect(() => ref.current?.focus({ preventScroll: true }), []);
  return (
    <div
      ref={ref}
      role="dialog"
      tabIndex={-1}
      aria-label={nameOf(item)}
      data-slot="subagent-sheet"
      data-full={full || undefined}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
      className={cn(
        'conn-rise absolute z-20 flex flex-col overflow-hidden bg-background outline-none',
        full ? 'inset-0' : 'inset-x-2 top-10 bottom-2 mx-auto max-w-3xl rounded-xl border shadow-lg',
      )}>
      <div className="flex shrink-0 items-center gap-1.5 border-b px-2 py-1.5">
        <Button variant="ghost" size="icon-xs" aria-label="Back to the chat" title="Back to the chat" onClick={onClose}>
          <ArrowLeftIcon />
        </Button>
        <SubagentGlyph item={item} />
        <span className="min-w-0 flex-1 truncate text-[13px]">{nameOf(item)}</span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={full ? 'Shrink' : 'Expand'}
          title={full ? 'Shrink' : 'Expand'}
          onClick={onToggleFull}>
          {full ? <Minimize2Icon /> : <Maximize2Icon />}
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label="Close" title="Close" onClick={onClose}>
          <XIcon />
        </Button>
      </div>
      <Conversation className="min-h-0 flex-1">
        <ConversationContent className="gap-3 p-3">
          <SubagentStream item={item} agent={agent} Items={Items} />
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
    </div>
  );
}
