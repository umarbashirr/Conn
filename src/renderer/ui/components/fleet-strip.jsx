// A shell left running in the background, a dev server say, keeps going long
// after the row that started it has scrolled away. Subagents have the Working
// pill; these share one chip, since a timer each for a whole session's worth
// of servers only ever counts up.
import { Button } from '@/components/ui/button';

const nameOf = (a) => a.description || a.input?.description || 'command';

export function FleetStrip({ shells, onShow }) {
  if (!shells.length) return null;
  return (
    <div className="conn-rise mx-auto flex w-full max-w-3xl items-center gap-1.5 px-4 pb-1.5">
      <span className="mr-0.5 shrink-0 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/75">running</span>
      <Button
        variant="outline"
        size="xs"
        onClick={() => onShow?.(shells[0])}
        title={shells.map(nameOf).join('\n')}
        className="conn-in h-auto shrink-0 gap-2 rounded-full bg-card py-1 pr-2.5 pl-2.5 font-normal">
        <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500" />
        <span>{shells.length} in the background</span>
      </Button>
    </div>
  );
}
