import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';

export const fileCount = (n) => (n === 1 ? '1 file' : `${n} files`);

export function undoneCaption({ files, skipped }) {
  const links = skipped === 1 ? ', 1 left alone because it is a link' : `, ${skipped} left alone because they are links`;
  return `Edits from here on undone · ${fileCount(files)}${skipped > 0 ? links : ''}`;
}

export function useEditsOffer(item, agent, paused) {
  const [hot, setHot] = useState(false);
  const [offer, setOffer] = useState(null);
  const ask = hot && !paused && !agent.busy && !!item.forkAt;
  useEffect(() => {
    if (!ask) return undefined;
    let live = true;
    setOffer(null);
    agent.editsSince(item.id).then((o) => { if (live) setOffer(o); });
    return () => { live = false; };
  }, [ask, item.id, item.forkAt, item.undone, agent.editsSince]);
  const cool = () => { setHot(false); setOffer(null); };
  const bind = {
    onPointerEnter: () => setHot(true),
    onPointerLeave: cool,
    onFocus: () => setHot(true),
    onBlur: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) cool(); },
  };
  return { offer: ask ? offer : null, bind };
}

export function UndoEditsDialog({ offer, undo, onClose }) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState(null);
  const one = offer.files.length === 1;
  const confirm = async () => {
    setWorking(true);
    setError(null);
    const res = await undo();
    if (!res?.error) onClose();
    else { setError(res.error); setWorking(false); }
  };

  return (
    <Dialog open onOpenChange={(next) => { if (!next && !working) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Undo edits from this message?</DialogTitle>
          <DialogDescription>
            {`Puts ${one ? 'this file' : 'these files'} back the way ${one ? 'it was' : 'they were'} before this message. `}
            Edits from every later message are undone too, and so are changes you made to {one ? 'this file' : 'these files'} since.
            The conversation stays as it is.
          </DialogDescription>
        </DialogHeader>

        <ul className="max-h-48 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-xs">
          {offer.files.map((f) => <li key={f} className="truncate" title={f}>{f}</li>)}
        </ul>
        <p className="text-muted-foreground text-xs">+{offer.insertions} −{offer.deletions}</p>
        {error && <p className="text-destructive text-xs">Could not undo: {error}</p>}

        <DialogFooter>
          <Button variant="ghost" disabled={working} onClick={onClose}>Cancel</Button>
          <Button variant="destructive" disabled={working} onClick={confirm}>Undo edits</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
