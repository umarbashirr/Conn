// A tool call is one line until you want more. The ai-elements Tool card puts a
// border, a badge and a wrench around every step, which turns a transcript into
// a stack of boxes.
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIcon, AppWindowIcon, ArrowLeftIcon, ArrowRightIcon, ArrowRightLeftIcon, BracesIcon, CameraIcon,
  ChevronRightIcon, ChevronsUpDownIcon, CircleAlertIcon, FilePenIcon, ListIcon, FilePlusIcon, FolderSearchIcon,
  GlobeIcon, HighlighterIcon, HourglassIcon, InfoIcon, KeyboardIcon, LogsIcon, MonitorSmartphoneIcon,
  MousePointer2Icon, MousePointerClickIcon, MoveVerticalIcon, PanelRightIcon, RotateCwIcon, ScanTextIcon,
  SearchIcon, ShieldCheckIcon, ShieldXIcon, SparklesIcon, SquareIcon, SquarePlusIcon, SquareTerminalIcon, SquareXIcon,
  TextCursorInputIcon, TextIcon, UsersIcon, VideoIcon, WrenchIcon,
} from 'lucide-react';

import { Shimmer } from '@/components/ai-elements/shimmer';
import { Fold } from '@/components/fold';
import { Button } from '@/components/ui/button';
import { clock, useTick } from '@/lib/clock';
import { bucketOf, cutText, imageSrc, toolImages, toolLabel, toolName, toolSummary } from '@/lib/tools';
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

export function ToolRow({ name, input, state, at, right, thumb = null, defaultOpen = false, children }) {
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
          ? <Shimmer as="span" className="shrink-0 text-[13px]">{toolName(name)}</Shimmer>
          : <span className={cn('shrink-0 text-[13px]', failed ? 'text-destructive' : 'text-foreground/90')}>{toolName(name)}</span>}
        {summary && (
          <span className="truncate font-mono text-muted-foreground text-xs">{summary}</span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2 pl-2">
          {held >= 2000 && (
            <span className="conn-in font-mono text-[11px] tabular-nums text-muted-foreground/70">
              {clock(held)}
            </span>
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
  const [open, setOpen] = useState(false);
  const failed = items.filter((i) => i.state === 'output-error').length;
  const shot = items.flatMap((it) => toolImages(it.output)).at(-1);

  return (
    <div className="rounded-md">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen((v) => !v)}
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
        {!open && shot && <Thumb block={shot} className="ml-auto" />}
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

export function ToolOutput({ text, error }) {
  const [all, setAll] = useState(false);
  const { shown, hidden } = cutText(text);
  return (
    <div className="mt-2">
      <Pre className={cn(error && 'text-destructive')}>{all ? text : shown}</Pre>
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
