// A tool call is one line until you want more. The ai-elements Tool card puts a
// border, a badge and a wrench around every step, which turns a transcript into
// a stack of boxes.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIcon, AppWindowIcon, ArrowLeftIcon, ArrowRightIcon, ArrowRightLeftIcon, BracesIcon, CameraIcon,
  ChevronRightIcon, ChevronsUpDownIcon, CircleAlertIcon, FilePenIcon, ListChecksIcon, ListIcon, FilePlusIcon, FolderSearchIcon,
  GlobeIcon, HighlighterIcon, HourglassIcon, InfoIcon, KeyboardIcon, LogsIcon, MonitorSmartphoneIcon,
  MousePointer2Icon, MousePointerClickIcon, MoveVerticalIcon, PanelRightIcon, RotateCwIcon, ScanTextIcon,
  SearchIcon, ShieldCheckIcon, ShieldXIcon, SparklesIcon, SquareIcon, SquarePlusIcon, SquareTerminalIcon, SquareXIcon,
  TextCursorInputIcon, TextIcon, UsersIcon, VideoIcon, WrenchIcon,
} from 'lucide-react';

import { Shimmer } from '@/components/ai-elements/shimmer';
import { Fold } from '@/components/fold';
import { CopyButton } from '@/components/copy-button';
import { StackText } from '@/components/stack-trace';
import { Button } from '@/components/ui/button';
import { clipSpans, parseAnsi, plainText } from '@/lib/ansi';
import { inputFields } from '@/lib/fields';
import { clock, useTick } from '@/lib/clock';
import { runSpan, callSpan } from '@/lib/runs';
import { parseStack } from '@/lib/stacks';
import { ROW_TEXT_LIMIT, bucketOf, imageSrc, toolImages, toolLabel, toolName, toolSummary, toolTitle } from '@/lib/tools';
import { cn } from '@/lib/utils';

const ICONS = {
  Bash: SquareTerminalIcon,
  Read: FolderSearchIcon,
  Glob: FolderSearchIcon,
  Grep: SearchIcon,
  Edit: FilePenIcon,
  MultiEdit: FilePenIcon,
  NotebookEdit: FilePenIcon,
  Write: FilePlusIcon,
  WebFetch: GlobeIcon,
  WebSearch: SearchIcon,
  Skill: SparklesIcon,
  ExitPlanMode: ListChecksIcon,
  browser_navigate: GlobeIcon,
  browser_snapshot: ScanTextIcon,
  browser_text: TextIcon,
  browser_click: MousePointerClickIcon,
  browser_fill: TextCursorInputIcon,
  browser_type: TextCursorInputIcon,
  browser_press: KeyboardIcon,
  browser_select: ChevronsUpDownIcon,
  browser_hover: MousePointer2Icon,
  browser_scroll: MoveVerticalIcon,
  browser_screenshot: CameraIcon,
  browser_record: VideoIcon,
  browser_console: LogsIcon,
  browser_network: ActivityIcon,
  browser_evaluate: BracesIcon,
  browser_wait: HourglassIcon,
  browser_viewport: MonitorSmartphoneIcon,
  browser_back: ArrowLeftIcon,
  browser_forward: ArrowRightIcon,
  browser_reload: RotateCwIcon,
  browser_state: InfoIcon,
  browser_show: PanelRightIcon,
  browser_highlight: HighlighterIcon,
  browser_tabs: AppWindowIcon,
  browser_tab_new: SquarePlusIcon,
  browser_tab_select: ArrowRightLeftIcon,
  browser_tab_close: SquareXIcon,
  // An Agent call draws as its own container, but the tools for looking in on
  // one still land here.
  Agent: UsersIcon,
  Task: UsersIcon,
  TaskOutput: UsersIcon,
  TaskStop: SquareIcon,
};

// A screenshot shrunk to a glance, so a folded row still shows the page it saw.
export function Thumb({ block, className }) {
  return (
    <img
      alt=""
      loading="lazy"
      src={imageSrc(block)}
      className={cn('h-5 w-8 shrink-0 rounded-[3px] border object-cover object-top', className)} />
  );
}

// The answer a card got, kept on the row of the call it held up, and small,
// so a past decision does not read as one still to make.
export function PermMark({ perm }) {
  const denied = perm.decided === 'deny';
  const always = perm.decided === 'always';
  const Icon = denied ? ShieldXIcon : ShieldCheckIcon;
  return (
    <span
      data-slot="perm-mark"
      title={always ? `You chose Always for ${toolName(toolLabel(perm.tool))} in this chat` : undefined}
      className={cn('flex items-center gap-1 text-[11px]', denied ? 'text-destructive' : 'text-muted-foreground/75')}>
      <Icon className="size-3" />
      {always ? 'always allowed' : denied ? 'denied' : 'allowed'}
    </span>
  );
}

export function ToolRow({ name, input, state, at, end, right, thumb = null, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  // The input arrives after the row does, so a row can turn into a diff a beat
  // later. Follow defaultOpen until the reader takes over.
  const touched = useRef(false);
  useEffect(() => { if (!touched.current) setOpen(defaultOpen); }, [defaultOpen]);
  // A browser tool this table has not met yet is still a page, not a wrench.
  const Icon = ICONS[name] || (name.startsWith('browser_') ? GlobeIcon : WrenchIcon);
  const running = state === 'input-available' || state === 'input-streaming';
  const failed = state === 'output-error';
  const summary = toolSummary(name, input);

  // A shimmering word is a state, not a clock: it sweeps at the same rate
  // whether the call has been out for two seconds or ninety, and a build that
  // takes a minute reads exactly like a call that will never come back. So a
  // running row counts. Not straight away — most calls are done inside a
  // second and a timer that flashes up and vanishes on every one of them is
  // its own kind of noise.
  useTick(running);
  const held = running && at ? Date.now() - at : 0;
  const took = running ? null : callSpan({ at, end });
  const title = toolTitle(name, state);

  return (
    <div className={cn('rounded-md', failed && 'bg-destructive/5')}>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => { touched.current = true; setOpen((v) => !v); }}
        className="group h-7 w-full justify-start gap-1.5 px-1.5 font-normal">
        <ChevronRightIcon
          className={cn('size-3 shrink-0 text-muted-foreground/50 transition-transform', open && 'rotate-90')} />
        {failed
          ? <CircleAlertIcon className="size-3.5 shrink-0 text-destructive" />
          : <Icon className="size-3.5 shrink-0 text-muted-foreground" />}
        {running
          ? <Shimmer as="span" className="shrink-0 text-[13px]">{title}</Shimmer>
          : <span className={cn('shrink-0 text-[13px]', failed ? 'text-destructive' : 'text-foreground/90')}>{title}</span>}
        {summary && (
          <span className="truncate font-mono text-muted-foreground text-xs">{summary}</span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2 pl-2">
          {held >= 2000 && (
            <span className="conn-in font-mono text-[11px] tabular-nums text-muted-foreground/70">
              {clock(held)}
            </span>
          )}
          {took && (
            <span className="font-mono text-[11px] tabular-nums text-muted-foreground/50">{clock(took)}</span>
          )}
          {right}
          {!open && thumb && <Thumb block={thumb} />}
        </span>
      </Button>
      <Fold open={open} className="px-2 pt-1 pb-2">{children}</Fold>
    </div>
  );
}

const PLURAL = {
  command: 'commands', file: 'files', search: 'searches', fetch: 'fetches', skill: 'skills', step: 'steps',
};

// The three that are looking for something, which is what earns the run a
// verb. Running a command is its own kind of work and gets its own clause.
const LOOKED = ['file', 'search', 'fetch'];

// "Explored 20 files, 5 searches" carries the same three numbers as "20 reads,
// 5 searches" with a verb in front, and the verb is the part that gets read.
// Counting calls describes the transcript; naming the act describes the work.
function summarise(items) {
  const counts = new Map();
  for (const it of items) {
    const key = bucketOf(it);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const say = (k, one = k) => `${counts.get(k)} ${counts.get(k) === 1 ? one : PLURAL[k]}`;

  // Edits lead, because "edited" and "explored" are different kinds of work
  // and burying the edits inside "explored" makes a writing turn look like
  // a reading one.
  const parts = [];
  const lead = (word) => (parts.length ? word : word[0].toUpperCase() + word.slice(1));
  const looked = LOOKED.filter((k) => counts.has(k));
  if (counts.has('edit')) {
    const n = counts.get('edit');
    const files = [...new Set(items
      .filter((it) => bucketOf(it) === 'edit')
      .map((it) => toolSummary(toolLabel(it.name), it.input))
      .filter(Boolean))];
    // Twelve edits of one file should name that file, not pretend they
    // were twelve different ones.
    parts.push(files.length === 1
      ? `Edited ${files[0]}${n > 1 ? ` × ${n}` : ''}`
      : `Edited ${n} ${n === 1 ? 'file' : 'files'}`);
  }
  if (looked.length) {
    const bits = looked.map((k) => say(k, k === 'search' ? 'search' : k === 'fetch' ? 'fetch' : 'file'));
    parts.push(`${lead('explored')} ${bits.join(', ')}`);
  }
  if (counts.has('command')) parts.push(`${lead('ran')} ${say('command')}`);
  if (counts.has('browser')) {
    const n = counts.get('browser');
    parts.push(`${lead('used')} the browser ${n === 1 ? 'once' : `${n} times`}`);
  }
  if (counts.has('skill')) parts.push(`${lead('loaded')} ${say('skill')}`);
  if (counts.has('step')) parts.push(say('step'));
  return parts.join(', ');
}

// Nineteen commands in a row were nineteen lines of transcript, and reading
// them cost more than the answer they added up to. What is running stays a row
// you can read; everything it already did collapses to one line saying how
// much of what, one click from being rows again. The summary line itself never
// animates: it is rewritten every time a call lands, and a line that fades on
// each rewrite is a line that never sits still. Opening it is a different
// matter, because that is the reader's own doing and they should see where the
// rows came from.
export function ToolStrip({ items, children }) {
  const failed = items.filter((i) => i.state === 'output-error').length;
  const [open, setOpen] = useState(failed > 0);
  // A failure that lands after the strip folded opens it once, so the failed
  // row is seen. After that, or after any click, the reader decides.
  const settled = useRef(failed > 0);
  useEffect(() => {
    if (failed > 0 && !settled.current) { settled.current = true; setOpen(true); }
  }, [failed]);
  const total = runSpan(items);
  const shot = items.flatMap((it) => toolImages(it.output)).at(-1);

  return (
    <div className="rounded-md">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => { settled.current = true; setOpen((v) => !v); }}
        title={open ? 'Fold these back into one line' : 'Show each call'}
        className="h-7 w-full justify-start gap-1.5 px-1.5 font-normal">
        <ChevronRightIcon
          className={cn('size-3 shrink-0 text-muted-foreground/50 transition-transform', open && 'rotate-90')} />
        {/* Holds the icon column, so the summary starts where every tool
            name beside it does. A run that is only edits gets the pen, so
            it does not wear the same mark as a run of reads. */}
        {items.every((it) => bucketOf(it) === 'edit')
          ? <FilePenIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
          : <ListIcon className="size-3.5 shrink-0 text-muted-foreground/70" />}
        <span className="truncate text-[13px] text-muted-foreground">
          {open ? `${items.length} before this` : summarise(items)}
        </span>
        {failed > 0 && (
          <span className="shrink-0 font-mono text-[11px] text-destructive">
            {failed} failed
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2 pl-2">
          {total && (
            <span className="font-mono text-[11px] tabular-nums text-muted-foreground/50">{clock(total)}</span>
          )}
          {!open && shot && <Thumb block={shot} />}
        </span>
      </Button>

      <Fold open={open} className="ml-3 flex flex-col gap-px border-l pl-1.5">{children}</Fold>
    </div>
  );
}

export function Pre({ children, className }) {
  return (
    <pre className={cn(
      'max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground',
      className,
    )}>
      {children}
    </pre>
  );
}

// Theme-aware: each colour has a shade that reads on a light page and one that
// reads on a dark one. Black and white are greys, since a true black or white
// would vanish on one of the two.
const ANSI_FG = [
  'text-zinc-500 dark:text-zinc-400', 'text-red-600 dark:text-red-400', 'text-emerald-600 dark:text-emerald-400',
  'text-amber-600 dark:text-amber-400', 'text-blue-600 dark:text-blue-400', 'text-fuchsia-600 dark:text-fuchsia-400',
  'text-cyan-600 dark:text-cyan-400', 'text-zinc-600 dark:text-zinc-300',
  'text-zinc-500 dark:text-zinc-500', 'text-red-500 dark:text-red-300', 'text-emerald-500 dark:text-emerald-300',
  'text-amber-500 dark:text-amber-300', 'text-blue-500 dark:text-blue-300', 'text-fuchsia-500 dark:text-fuchsia-300',
  'text-cyan-500 dark:text-cyan-300', 'text-zinc-700 dark:text-zinc-100',
];

function Spans({ spans }) {
  return spans.map((sp, i) => (
    sp.fg === null && !sp.bold && !sp.dim
      ? sp.text
      : <span key={i} className={cn(sp.fg !== null && ANSI_FG[sp.fg], sp.bold && 'font-semibold', sp.dim && 'opacity-60')}>{sp.text}</span>
  ));
}

// A trace is worth reading as one wherever it turns up in a failure, and in
// the output of a command, which is where a script's crash lands.
export function ToolOutput({ text, error, className, project, stack = error }) {
  const [all, setAll] = useState(false);
  const spans = useMemo(() => parseAnsi(text), [text]);
  const { spans: shown, hidden } = useMemo(() => clipSpans(spans, ROW_TEXT_LIMIT), [spans]);
  const body = all ? spans : shown;
  const plain = stack ? plainText(body) : '';
  return (
    <div className={cn('mt-2', className)}>
      <div className="group/out relative">
        {stack && parseStack(plain)
          ? <StackText text={plain} project={project} className={cn('pr-8', error && 'text-destructive')} />
          : <Pre className={cn('pr-8', error && 'text-destructive')}><Spans spans={body} /></Pre>}
        <CopyButton
          text={plainText(spans)}
          label="Copy output"
          className="absolute top-1 right-1 size-6 bg-muted/70 opacity-60 hover:opacity-100 focus-visible:opacity-100" />
      </div>
      {hidden > 0 && !all && (
        <div className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
          {hidden.toLocaleString('en-US')} more {hidden === 1 ? 'character' : 'characters'}
          <Button variant="ghost" size="xs" onClick={() => setAll(true)} className="h-5 px-1.5 text-[11px]">
            Show all
          </Button>
        </div>
      )}
    </div>
  );
}

// Key, then value. Short values sit beside their key; long or multi-line text
// gets its own wrapped block, and nested values read as compact JSON.
export function InputFields({ input }) {
  const fields = inputFields(input);
  if (!fields.length) return null;
  return (
    <dl data-slot="tool-fields" className="flex flex-col gap-1 rounded-md bg-muted/50 p-2 font-mono text-[11px] leading-relaxed">
      {fields.map((f) => (
        <div key={f.key} className={cn('flex min-w-0 gap-2', f.kind === 'block' && 'flex-col gap-0.5')}>
          <dt className="shrink-0 text-muted-foreground/70">{f.key}</dt>
          <dd className={cn(
            'min-w-0 break-words text-foreground/80',
            f.kind === 'block' && 'max-h-48 overflow-auto whitespace-pre-wrap rounded bg-background/50 p-1.5',
          )}>
            {f.text}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function InputFold({ input }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2">
      <Button
        data-slot="tool-input"
        aria-expanded={open}
        variant="ghost"
        size="xs"
        onClick={() => setOpen((v) => !v)}
        className="h-5 gap-1 px-1 text-[11px] font-normal text-muted-foreground">
        <ChevronRightIcon className={cn('size-3 shrink-0 text-muted-foreground/50 transition-transform', open && 'rotate-90')} />
        Input
      </Button>
      <Fold open={open} className="pt-1">
        <InputFields input={input} />
      </Fold>
    </div>
  );
}
