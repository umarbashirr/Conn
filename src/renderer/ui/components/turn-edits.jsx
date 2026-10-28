import { useState } from 'react';

import { DiffView } from '@/components/diff-view';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { tail } from '@/lib/tools';
import { hunksOf } from '@/lib/turns';

const nameOf = (p) => p.split('/').pop();
const folderOf = (p) => p.slice(0, p.length - nameOf(p).length);

const Counts = ({ added, removed }) => (
  <span className="flex shrink-0 items-center gap-1.5">
    {added > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{added}</span>}
    {removed > 0 && <span className="text-rose-600 dark:text-rose-400">-{removed}</span>}
  </span>
);

export function TurnEdits({ turn, transcript }) {
  const [shown, setShown] = useState(null);
  return (
    <>
      <div data-turn-edits={turn.userId} className="conn-in mt-1 flex flex-col items-start gap-0.5 font-mono text-xs">
        {turn.files.map((f) => (
          <button
            key={f.path}
            type="button"
            data-turn-file={f.path}
            title={f.path}
            onClick={() => setShown(f)}
            className="flex max-w-full items-center gap-2 rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">
            {/* The folder gives way first, so a long name keeps the name. */}
            <span className="flex min-w-0">
              <span className="truncate">{folderOf(tail(f.path))}</span>
              <span className="shrink-0">{nameOf(f.path)}</span>
            </span>
            <Counts added={f.added} removed={f.removed} />
          </button>
        ))}
      </div>
      {shown && <FileDialog file={shown} transcript={transcript} onClose={() => setShown(null)} />}
    </>
  );
}

function FileDialog({ file, transcript, onClose }) {
  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="flex max-h-[80vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="break-all font-mono text-sm">{file.path}</DialogTitle>
          <DialogDescription className="flex items-center gap-1.5 font-mono text-xs">
            This turn <Counts added={file.added} removed={file.removed} />
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto">
          <DiffView hunks={hunksOf(transcript, file.calls, file.path)} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
