/* Above the chat box, when the agent in this chat stopped because you had
   the browser: a way to give it back, and to tell the agent it can carry on,
   in one press. The agent was told to stop and wait, so handing the page
   back alone leaves it waiting; "and continue" says so for you. */
import { useSyncExternalStore } from 'react';
import { BotIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { stoppedForYou } from '@/lib/control';
import { getControlVersion, handBack, heldTabs, subscribeControl } from '../shell/control-store';

export const CARRY_ON = 'I handed the browser back to you. Carry on from where you stopped.';

export function HandBackStrip({ items, busy, onContinue }) {
  useSyncExternalStore(subscribeControl, getControlVersion, getControlVersion);
  if (busy || !heldTabs().length || !stoppedForYou(items)) return null;
  return (
    <div data-slot="hand-back-strip" className="conn-rise mx-auto flex w-full max-w-3xl items-center gap-1.5 px-4 pb-1.5">
      <BotIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">You have the browser, so the agent stopped and is waiting.</span>
      <Button size="xs" onClick={async () => { await handBack(); onContinue?.(); }}>Hand back and continue</Button>
      <Button size="xs" variant="outline" onClick={() => handBack()}>Hand back</Button>
    </div>
  );
}
