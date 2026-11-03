// A test run as the thing it is: suites with counts, and a failed test that
// opens onto its error. The raw output stays one fold away.
import { useState } from 'react';
import { CheckIcon, ChevronRightIcon, MinusIcon, XIcon } from 'lucide-react';

import { Fold } from '@/components/fold';
import { StackText } from '@/components/stack-trace';
import { ToolOutput } from '@/components/tool-row';
import { Button } from '@/components/ui/button';
import { parseStack } from '@/lib/stacks';
import { testSummary } from '@/lib/test-runs';
import { cn } from '@/lib/utils';

export function TestSummary({ run }) {
  return (
    <span
      data-slot="test-summary"
      className={cn('font-mono text-[11px]', run.failed ? 'text-destructive' : 'text-muted-foreground/75')}>
      {testSummary(run)}
    </span>
  );
}

const MARK = {
  passed: <CheckIcon className="size-3 shrink-0 text-emerald-600 dark:text-emerald-400" />,
  failed: <XIcon className="size-3 shrink-0 text-destructive" />,
  skipped: <MinusIcon className="size-3 shrink-0 text-muted-foreground/60" />,
};

function TestLine({ test, project }) {
  const [open, setOpen] = useState(false);
  const body = test.error;
  return (
    <div>
      <Button
        variant="ghost"
        size="xs"
        data-slot="test-line"
        data-status={test.status}
        aria-expanded={body ? open : undefined}
        onClick={() => body && setOpen((v) => !v)}
        className={cn('h-5 w-full justify-start gap-1.5 px-1 font-normal', !body && 'cursor-default')}>
        {body
          ? <ChevronRightIcon className={cn('size-3 shrink-0 text-muted-foreground/50 transition-transform', open && 'rotate-90')} />
          : <span className="size-3 shrink-0" />}
        {MARK[test.status]}
        <span className={cn('truncate font-mono text-[11px]', test.status === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>
          {test.name}
        </span>
      </Button>
      {body && (
        <Fold open={open} className="pt-1 pb-1 pl-7">
          {parseStack(body)
            ? <StackText text={body} project={project} className="text-destructive" />
            : <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-2 font-mono text-[11px] leading-relaxed text-destructive">{body}</pre>}
        </Fold>
      )}
    </div>
  );
}

function SuiteLine({ suite, project }) {
  const [open, setOpen] = useState(suite.failed > 0);
  const counts = [
    suite.passed && `${suite.passed} passed`,
    suite.failed && `${suite.failed} failed`,
    suite.skipped && `${suite.skipped} skipped`,
  ].filter(Boolean);
  const expandable = suite.tests.length > 0;
  return (
    <div>
      <Button
        variant="ghost"
        size="xs"
        data-slot="test-suite"
        aria-expanded={expandable ? open : undefined}
        onClick={() => expandable && setOpen((v) => !v)}
        className={cn('h-6 w-full justify-start gap-1.5 px-1 font-normal', !expandable && 'cursor-default')}>
        {expandable
          ? <ChevronRightIcon className={cn('size-3 shrink-0 text-muted-foreground/50 transition-transform', open && 'rotate-90')} />
          : <span className="size-3 shrink-0" />}
        {suite.failed ? MARK.failed : MARK.passed}
        <span className={cn('truncate font-mono text-xs', suite.failed ? 'text-destructive' : 'text-foreground/85')}>{suite.name}</span>
        <span className="ml-auto shrink-0 pl-2 font-mono text-[11px] text-muted-foreground/75">{counts.join(' · ')}</span>
      </Button>
      {expandable && (
        <Fold open={open} className="pl-4">
          {suite.tests.map((t, i) => <TestLine key={i} test={t} project={project} />)}
        </Fold>
      )}
    </div>
  );
}

export function RawOutput({ text, error, project }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2">
      <Button
        data-slot="raw-output"
        aria-expanded={open}
        variant="ghost"
        size="xs"
        onClick={() => setOpen((v) => !v)}
        className="h-5 gap-1 px-1 text-[11px] font-normal text-muted-foreground">
        <ChevronRightIcon className={cn('size-3 shrink-0 text-muted-foreground/50 transition-transform', open && 'rotate-90')} />
        Raw output
      </Button>
      <Fold open={open}>
        <ToolOutput text={text} error={error} project={project} className="mt-1" />
      </Fold>
    </div>
  );
}

export function TestResults({ run, project }) {
  return (
    <div data-slot="test-results" className="flex flex-col gap-px">
      {run.suites.map((s) => <SuiteLine key={s.name} suite={s} project={project} />)}
    </div>
  );
}
