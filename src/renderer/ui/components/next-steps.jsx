import { CornerDownRightIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';

/* Chips under a finished turn. Picking one fills the box rather than sending:
   the words can be edited, and nothing runs that the person did not read. The
   first one also answers Tab in an empty box, which the hint on it says. */
export function NextSteps({ steps, onPick }) {
  if (!steps.length) return null;
  return (
    <div
      role="group"
      aria-label="Suggested next steps"
      data-next-steps
      className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-1.5 px-4 pb-2">
      {steps.map((s, i) => (
        <Button
          key={s.text}
          variant="outline"
          size="sm"
          title={i === 0 ? 'Tab in an empty box fills this in' : undefined}
          className="h-7 max-w-full gap-1.5 rounded-full px-3 font-normal text-muted-foreground text-xs hover:text-foreground"
          onClick={() => onPick(s)}>
          {i === 0 && <CornerDownRightIcon className="size-3 opacity-60" />}
          <span className="truncate">{s.text}</span>
          {i === 0 && <kbd className="ml-0.5 rounded border px-1 font-sans text-[10px] opacity-60">Tab</kbd>}
        </Button>
      ))}
    </div>
  );
}
