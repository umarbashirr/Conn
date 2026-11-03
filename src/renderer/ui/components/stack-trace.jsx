// A stack trace where the frames are the reader's own code first. Framework
// frames fold into one dimmed row, because the part of a trace that matters is
// the three lines in files they wrote.
import { useState } from 'react';
import { ChevronRightIcon } from 'lucide-react';

import { Fold } from '@/components/fold';
import { foldFrames, resolveFile, segmentStack } from '@/lib/stacks';
import { cn } from '@/lib/utils';

function AppFrame({ frame, project }) {
  const rel = resolveFile(frame.file, project);
  const where = `${rel ?? frame.file}:${frame.line}`;
  return (
    <div className="flex gap-2 whitespace-pre-wrap break-words">
      <span className="shrink-0 text-muted-foreground/60">at</span>
      {frame.fn && <span className="text-foreground/80">{frame.fn}</span>}
      {rel ? (
        <button
          type="button"
          data-slot="stack-frame"
          title={`Open ${rel} at line ${frame.line}`}
          onClick={() => window.connOpenFile?.(rel, frame.line)}
          className="cursor-pointer text-left text-sky-600 underline-offset-2 hover:underline dark:text-sky-400">
          {where}
        </button>
      ) : (
        <span className="text-muted-foreground">{where}</span>
      )}
    </div>
  );
}

function FrameworkFold({ frames }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-muted-foreground/60">
      <button
        type="button"
        data-slot="stack-fold"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex cursor-pointer items-center gap-1 hover:text-muted-foreground">
        <ChevronRightIcon className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')} />
        {frames.length} framework {frames.length === 1 ? 'frame' : 'frames'}
      </button>
      <Fold open={open} className="pl-4">
        {frames.map((f, i) => <div key={i} className="whitespace-pre-wrap break-words">{f.raw}</div>)}
      </Fold>
    </div>
  );
}

export function StackText({ text, project, className }) {
  return (
    <div className={cn(
      'flex max-h-72 flex-col gap-px overflow-auto rounded-md bg-muted/50 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground',
      className,
    )}>
      {segmentStack(text).map((seg, i) => (seg.type === 'text'
        ? <div key={i} className="whitespace-pre-wrap break-words">{seg.text}</div>
        : foldFrames(seg.frames).map((row, j) => (row.type === 'app'
          ? <AppFrame key={`${i}.${j}`} frame={row.frame} project={project} />
          : <FrameworkFold key={`${i}.${j}`} frames={row.frames} />))))}
    </div>
  );
}
