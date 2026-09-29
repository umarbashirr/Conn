import { CheckIcon, FunnelIcon, SquareIcon, TriangleAlertIcon } from 'lucide-react';

import { isExplore, statusOf } from '@/lib/subagents';
import { cn } from '@/lib/utils';

// Braille while it works, so a glance tells a live one from a finished one
// without reading anything. One waiting on you goes amber.
export function Spinner({ className }) {
  return <span aria-hidden className={cn('conn-braille inline-block w-3.5 text-center font-mono leading-none', className)} />;
}

export function SubagentGlyph({ item, className }) {
  const status = statusOf(item);
  const icon = cn('size-3.5 shrink-0', className);
  switch (status) {
    case 'running':
      return <Spinner className={cn(item.waiting ? 'text-amber-500' : 'text-primary', className)} />;
    case 'done':
      return isExplore(item)
        ? <FunnelIcon className={cn(icon, 'text-primary')} />
        : <CheckIcon className={cn(icon, 'text-muted-foreground')} />;
    case 'error':
      return <TriangleAlertIcon className={cn(icon, 'text-destructive')} />;
    case 'stopped':
      return <SquareIcon className={cn(icon, 'scale-75 text-muted-foreground')} />;
    default:
      throw new Error(`unhandled subagent status ${status}`);
  }
}
