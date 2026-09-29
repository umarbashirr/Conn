// What one subagent was sent and what it has done since, drawn with the
// chat's own item renderer. The sheet over the chat and the Agents tab both
// show this, so an agent reads the same wherever it is opened.
import { useEffect, useState } from 'react';
import { ArrowLeftRightIcon } from 'lucide-react';

import { MessageResponse } from '@/components/ai-elements/message';
import { Shimmer } from '@/components/ai-elements/shimmer';
import { activityOf, isLive } from '@/lib/subagents';
import { cn } from '@/lib/utils';

const PEEK_MS = 3000;

/* A replayed chat has the rows but reads a transcript only when one is opened,
   and being on screen is opening it. A background agent streams nothing until
   it is done, so while one is on screen its transcript is read again every few
   seconds, and once more when it stops being watched so the steps it finished
   on are not left out. */
export function useSubagentTranscript(agent, item, showing) {
  const pending = showing && item?.loaded === false ? item : null;
  useEffect(() => {
    if (pending) agent.openAgent(pending);
  }, [pending?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const watching = showing && item && isLive(item) && item.background && !item.children?.length ? item : null;
  useEffect(() => {
    if (!watching) return undefined;
    agent.peekAgent(watching);
    const timer = setInterval(() => agent.peekAgent(watching), PEEK_MS);
    return () => { clearInterval(timer); agent.peekAgent(watching); };
  }, [watching?.id]); // eslint-disable-line react-hooks/exhaustive-deps
}

function SentByParent({ prompt }) {
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      data-slot="sent-by-parent"
      aria-expanded={open}
      onClick={() => setOpen((v) => !v)}
      title={open ? 'Show less' : 'Show all of it'}
      className="w-full rounded-lg border bg-muted/40 px-3 py-2 text-left">
      <span className="mb-1 flex items-center gap-1.5 text-muted-foreground text-xs">
        <ArrowLeftRightIcon className="size-3" />
        Sent by parent
      </span>
      <span className={cn(
        'block whitespace-pre-wrap break-words text-[13px] leading-relaxed',
        !open && 'line-clamp-3 [mask-image:linear-gradient(to_bottom,black_60%,transparent)]',
      )}>
        {prompt}
      </span>
    </button>
  );
}

export function SubagentStream({ item, agent, Items }) {
  const steps = item.children?.length ? item.children : item.peek || [];
  const live = isLive(item);
  return (
    <>
      {item.input?.prompt && <SentByParent prompt={item.input.prompt} />}
      {item.loaded === 'loading' && (
        <Shimmer as="div" className="px-2 py-1 font-mono text-[11px]">reading its transcript…</Shimmer>
      )}
      <Items items={steps} agent={agent} />
      {live && item.background && !item.children?.length && (
        <div className="px-2 text-muted-foreground text-xs">
          {item.peek?.length
            ? 'Running in the background. Read from its transcript every few seconds.'
            : 'Running in the background. Its steps show up here once it writes its first one.'}
        </div>
      )}
      {item.report && (
        <div className="conn-in rounded-md bg-muted/45 px-2.5 py-2 text-[12.5px] leading-relaxed">
          <span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground/75">
            what it came back with
          </span>
          <MessageResponse>{item.report}</MessageResponse>
        </div>
      )}
      {live && (
        <div data-slot="subagent-activity" className="px-2 text-[13px]">
          <Shimmer as="span">{activityOf(item)}</Shimmer>
        </div>
      )}
    </>
  );
}
