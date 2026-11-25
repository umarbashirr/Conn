/* The pipeline runs strip at the top of the Board: one card per run, its
   stages in order, and the one button that run needs now. Continue past a
   gate, Stop a running one, Retry where it stopped, or put away a finished
   one. A stage opens its chat. */
import { useSyncExternalStore } from 'react';
import { CheckIcon, CircleIcon, LoaderCircleIcon, PauseIcon, XIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { relative } from '../shell/rail-store';
import { continueRun, getRunsVersion, openStage, removeRun, retryRun, runsState, stopRun, subscribeRuns } from '../shell/pipeline-store';

// How many finished runs stay on the strip. The ones still going always do.
const FINISHED_SHOWN = 3;

const STATUS = {
  running: 'Running',
  waiting: 'Waiting for you',
  done: 'Finished',
  failed: 'Failed',
  stopped: 'Stopped',
};

function StageMark({ status }) {
  if (status === 'done') return <CheckIcon className="size-3 text-[hsl(var(--success))]" />;
  if (status === 'running') return <LoaderCircleIcon className="size-3 animate-spin text-[hsl(var(--success))]" />;
  if (status === 'gated') return <PauseIcon className="size-3 text-amber-500" />;
  if (status === 'failed') return <XIcon className="size-3 text-destructive" />;
  return <CircleIcon className="size-2.5 text-muted-foreground/50" />;
}

function RunCard({ run }) {
  const failedStage = run.stages.find((s) => s.status === 'failed');
  return (
    <div
      data-slot="pipeline-run"
      data-status={run.status}
      aria-label={`${run.name} run`}
      className={cn('flex w-72 shrink-0 flex-col gap-1.5 rounded-lg border bg-card px-3 py-2 shadow-xs', run.status === 'waiting' && 'border-amber-500/60')}>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{run.name}</span>
        {Number.isFinite(run.at || run.startedAt) && (
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums" title={`Started ${new Date(run.startedAt).toLocaleString()}`}>{relative(run.at || run.startedAt)}</span>
        )}
      </div>
      {run.input && <p className="truncate text-[12px] text-foreground/75" title={run.input}>{run.input}</p>}
      <ol className="flex flex-wrap items-center gap-1">
        {run.stages.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              data-slot="pipeline-stage"
              data-stage={s.id}
              data-status={s.status}
              disabled={!s.chat && !s.session}
              title={s.error || (s.chat || s.session ? `Open ${s.title}` : `${s.title} has not started`)}
              onClick={() => openStage(run, s)}
              className="flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] hover:bg-secondary/60 disabled:cursor-default disabled:hover:bg-transparent">
              <StageMark status={s.status} />
              {s.title}
            </button>
          </li>
        ))}
      </ol>
      <div className="flex items-center gap-1.5">
        <span data-slot="pipeline-status" className={cn('min-w-0 flex-1 truncate text-[11px]', run.status === 'failed' ? 'text-destructive' : 'text-muted-foreground')} title={failedStage?.error || ''}>
          {STATUS[run.status] || run.status}
          {failedStage?.error ? `: ${failedStage.error}` : ''}
        </span>
        {run.status === 'waiting' && <Button size="xs" data-action="continue" onClick={() => continueRun(run.id)}>Continue</Button>}
        {(run.status === 'running' || run.status === 'waiting') && <Button size="xs" variant="outline" data-action="stop" onClick={() => stopRun(run.id)}>Stop</Button>}
        {(run.status === 'failed' || run.status === 'stopped') && <Button size="xs" variant="outline" data-action="retry" onClick={() => retryRun(run.id)}>Retry</Button>}
        {(run.status === 'done' || run.status === 'failed' || run.status === 'stopped') && (
          <Button size="icon-xs" variant="ghost" data-action="remove" aria-label={`Put away the ${run.name} run`} title="Put this run away" onClick={() => removeRun(run.id)}>
            <XIcon />
          </Button>
        )}
      </div>
    </div>
  );
}

export function PipelineRuns() {
  useSyncExternalStore(subscribeRuns, getRunsVersion, getRunsVersion);
  const runs = runsState().runs;
  const going = runs.filter((r) => r.status === 'running' || r.status === 'waiting');
  const over = runs.filter((r) => !going.includes(r)).slice(0, FINISHED_SHOWN);
  const shown = [...going, ...over];
  if (!shown.length) return null;
  return (
    <section data-slot="pipeline-runs" aria-label="Pipeline runs" className="flex flex-none flex-col gap-1.5 px-3 pt-3">
      <span className="text-[12px] font-medium">Pipelines</span>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {shown.map((r) => <RunCard key={r.id} run={r} />)}
      </div>
    </section>
  );
}
