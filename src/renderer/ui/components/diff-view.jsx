// File edits read as diffs, not as JSON with two long strings in it.

import { lineDiff } from '@/lib/diff';

// Collapse long runs of untouched lines the way a patch does.
function trimContext(rows, keep = 3) {
  const changed = rows.map((r) => r[0] !== ' ');
  const near = rows.map((_, i) =>
    changed.slice(Math.max(0, i - keep), i + keep + 1).some(Boolean));
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    if (near[i]) out.push(rows[i]);
    else if (out.length && out[out.length - 1][0] !== '~') out.push(['~', '']);
  }
  return out;
}

const ROW = {
  '+': 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  '-': 'bg-rose-500/10 text-rose-700 dark:text-rose-300',
  ' ': 'text-muted-foreground',
  '~': 'text-muted-foreground/50 select-none',
};

export function DiffView({ hunks, max = 400 }) {
  return (
    <div className="flex flex-col gap-2">
      {hunks.map((h, hi) => {
        const rows = trimContext(lineDiff(h.before ?? '', h.after ?? ''));
        const shown = rows.slice(0, max);
        return (
          <div key={hi} className="overflow-x-auto rounded-md bg-muted/40 py-1 font-mono text-[11px] leading-relaxed">
            {shown.map(([kind, text], i) => (
              <div key={i} className={`flex ${ROW[kind]}`}>
                <span className="w-6 shrink-0 select-none pl-2 opacity-60">
                  {kind === '~' ? '' : kind === ' ' ? '' : kind}
                </span>
                <span className="whitespace-pre pr-3">{kind === '~' ? '⋯' : text || ' '}</span>
              </div>
            ))}
            {rows.length > max && (
              <div className="px-3 py-1 text-muted-foreground/60">
                {rows.length - max} more lines
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function fileHeader({ path, kind, movePath }) {
  if (movePath) return { text: `${path} → ${movePath}`, note: 'moved' };
  if (kind === 'add') return { text: path, note: 'added' };
  if (kind === 'delete') return { text: path, note: 'deleted' };
  return { text: path, note: '' };
}

export function FileDiffs({ files, max }) {
  return (
    <div className="flex flex-col gap-3">
      {files.map((f, i) => {
        const { text, note } = fileHeader(f);
        // One plain update is already named by the row above it.
        const showHeader = files.length > 1 || !!note;
        return (
          <div key={i} className="flex flex-col gap-1">
            {showHeader && (
              <div className="flex items-baseline gap-2 px-1 text-xs">
                <span className="break-all font-mono text-foreground/85" title={text}>{text}</span>
                {note && <span className="shrink-0 text-muted-foreground">{note}</span>}
              </div>
            )}
            <DiffView hunks={f.hunks ?? []} max={max} />
          </div>
        );
      })}
    </div>
  );
}
