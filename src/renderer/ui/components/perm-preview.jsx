import { DiffView, FileDiffs } from '@/components/diff-view';

export function PermPreview({ preview }) {
  if (preview.kind === 'command') {
    return (
      <div className="mt-2 flex flex-col gap-1">
        {preview.description && <div className="text-muted-foreground text-xs">{preview.description}</div>}
        <pre
          tabIndex={0}
          aria-label="Command"
          className="max-h-[15lh] overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/40 px-3 py-2 font-mono text-[11px] leading-relaxed">
          {preview.command}
        </pre>
      </div>
    );
  }
  return (
    <div tabIndex={0} aria-label="Changes" className="mt-2 max-h-64 overflow-y-auto rounded-md">
      {preview.files ? <FileDiffs files={preview.files} /> : <DiffView hunks={preview.hunks} />}
    </div>
  );
}

export function KeyHint({ children }) {
  return (
    <kbd aria-hidden="true" className="ml-1 rounded border border-current/25 px-1 font-mono text-[10px] leading-4 opacity-60">
      {children}
    </kbd>
  );
}
