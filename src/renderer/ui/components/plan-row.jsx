import { useState } from 'react';
import { CheckIcon, ChevronRightIcon, CircleDotIcon, CircleIcon, ListChecksIcon } from 'lucide-react';

import { MessageResponse } from '@/components/ai-elements/message';
import { Fold } from '@/components/fold';
import { Button } from '@/components/ui/button';
import { planDone } from '@/lib/plan';
import { cn } from '@/lib/utils';

const MARK = {
  completed: CheckIcon,
  in_progress: CircleDotIcon,
  pending: CircleIcon,
};

function Entry({ entry }) {
  const { status } = entry;
  const Icon = MARK[status];
  const done = status === 'completed';
  const doing = status === 'in_progress';
  return (
    <li data-plan-status={status} className="flex min-w-0 items-start gap-1.5 py-0.5">
      <Icon className={cn('mt-[3px] size-3.5 shrink-0', doing ? 'text-foreground' : 'text-muted-foreground')} />
      <span
        className={cn(
          'min-w-0 break-words text-[13px]',
          doing ? 'text-foreground' : 'text-muted-foreground',
          done && 'line-through',
        )}>
        {doing && entry.activeForm ? entry.activeForm : entry.content}
      </span>
    </li>
  );
}

export function PlanRow({ item }) {
  const [open, setOpen] = useState(true);
  const { entries, explanation } = item;

  return (
    <div data-plan-row className="rounded-md">
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="h-7 w-full justify-start gap-1.5 px-1.5 font-normal">
        <ChevronRightIcon
          className={cn('size-3 shrink-0 text-muted-foreground/50 transition-transform', open && 'rotate-90')} />
        <ListChecksIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-[13px] text-foreground/90">Plan</span>
        <span className="truncate text-[13px] text-muted-foreground">
          {planDone(entries)} of {entries.length} done
        </span>
      </Button>
      <Fold open={open} className="ml-3 border-l pb-1 pl-3">
        {explanation && (
          <MessageResponse className="mb-1 text-[13px] text-muted-foreground">{explanation}</MessageResponse>
        )}
        <ul className="flex min-w-0 flex-col">
          {entries.map((entry, i) => <Entry key={i} entry={entry} />)}
        </ul>
      </Fold>
    </div>
  );
}
