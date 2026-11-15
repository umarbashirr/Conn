import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  CrosshairIcon, FileIcon, PencilIcon, SquareIcon, Trash2Icon, TriangleAlertIcon, Undo2Icon,
} from 'lucide-react';

import { CopyButton } from '@/components/copy-button';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { drawMarks, sizeLabel } from '@/lib/attachments';
// The preview pane is a native view sitting above this document, so it has to
// move out of the way while a dialog is up.
import { parkPreview } from '../../app.js';

const PathRow = ({ label, path }) => (
  <div className="flex items-center gap-2 rounded-md bg-muted/50 px-2.5 py-1.5">
    <span className="shrink-0 text-muted-foreground text-xs">{label}</span>
    <span className="min-w-0 flex-1 truncate font-mono text-xs" title={path}>{path}</span>
    <CopyButton text={path} label="Copy the path" />
  </div>
);

const Field = ({ label, children, mono }) => (
  <div className="flex gap-3 text-xs">
    <span className="w-16 shrink-0 text-muted-foreground">{label}</span>
    <span className={cn('min-w-0 flex-1 break-words', mono && 'font-mono')}>{children}</span>
  </div>
);

// The picture at the size it was shrunk to, which is also the size the agent
// sees. A filename tells you nothing about which screenshot you grabbed.
function Body({ item, marks, setMarks }) {
  if (item.kind === 'image' && setMarks) return <Markup item={item} marks={marks} setMarks={setMarks} />;
  if (item.kind === 'image') {
    return (
      <div className="flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted/40 p-2">
        {/* Pinned to the viewport rather than to the dialog: a percentage cap
            resolves against an auto height and does nothing. The subtraction is
            the header, the path row and the padding around them, so a tall
            picture ends up scaled instead of scrolled. */}
        <img src={item.preview} alt={item.name} className="max-h-[calc(82vh-9rem)] w-auto max-w-full object-contain" />
      </div>
    );
  }

  if (item.kind === 'element' && item.hit.area) {
    const { hit, shotPath } = item;
    return (
      <div className="flex flex-col gap-2.5">
        <Field label="box" mono>{hit.rect.w}×{hit.rect.h} at {hit.rect.x},{hit.rect.y}</Field>
        {hit.contains.length > 0 && (
          <Field label="contains">
            {hit.contains.map((c) => `${c.role === 'generic' ? c.tag : c.role} ${c.name}`.trim()).join(', ')}
          </Field>
        )}
        {shotPath && <PathRow label="shot" path={shotPath} />}
      </div>
    );
  }

  if (item.kind === 'element') {
    const { hit, shotPath } = item;
    return (
      <div className="flex flex-col gap-2.5">
        <Field label="element">{hit.role === 'generic' ? hit.tag : hit.role}</Field>
        {(hit.name || hit.text) && <Field label="text">{hit.name || hit.text}</Field>}
        <Field label="css" mono>{hit.css}</Field>
        <Field label="ref" mono>{hit.ref}</Field>
        {hit.rect && (
          <Field label="box" mono>{hit.rect.w}×{hit.rect.h} at {hit.rect.x},{hit.rect.y}</Field>
        )}
        {shotPath && <PathRow label="shot" path={shotPath} />}
      </div>
    );
  }

  if (item.kind === 'error') {
    return (
      <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-destructive text-sm">
        <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
        <span>{item.error}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2.5 rounded-xl border border-border bg-card px-3 py-2.5 shadow-xs">
        <FileIcon className="size-5 text-muted-foreground" />
        <div className="min-w-0">
          <div className="truncate text-sm">{item.name}</div>
          <div className="text-muted-foreground text-xs">{sizeLabel(item.size)}</div>
        </div>
      </div>
      <p className="text-muted-foreground text-xs">
        Files go across as a path. The agent opens this one itself when you send the message.
      </p>
    </div>
  );
}

// Pen and box over the picture, so a big screenshot can say which part it is
// about. Drawn over the unmarked picture: the burnt-in copy is made when the
// dialog closes, which keeps every mark undoable until then.
const TOOLS = [
  { id: 'pen', label: 'Pen', Icon: PencilIcon },
  { id: 'box', label: 'Box', Icon: SquareIcon },
];

function Markup({ item, marks, setMarks }) {
  const canvas = useRef(null);
  const [tool, setTool] = useState('pen');
  const [live, setLive] = useState(null);
  const src = item.base?.preview || item.preview;
  const shown = live ? [...marks, live] : marks;

  useLayoutEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    drawMarks(ctx, shown, c.width, c.height);
  });

  // The pointer in the picture's own pixels, whatever size it is drawn at.
  const at = (e) => {
    const r = canvas.current.getBoundingClientRect();
    return [
      Math.round(((e.clientX - r.left) / r.width) * canvas.current.width),
      Math.round(((e.clientY - r.top) / r.height) * canvas.current.height),
    ];
  };

  const down = (e) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = at(e);
    setLive(tool === 'box' ? { tool, from: p, to: p } : { tool, points: [p] });
  };
  const move = (e) => {
    if (!live) return;
    const p = at(e);
    setLive(live.tool === 'box' ? { ...live, to: p } : { ...live, points: [...live.points, p] });
  };
  const up = () => {
    if (!live) return;
    const tiny = live.tool === 'box'
      && Math.abs(live.to[0] - live.from[0]) < 4 && Math.abs(live.to[1] - live.from[1]) < 4;
    if (!tiny) setMarks([...marks, live]);
    setLive(null);
  };

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex items-center gap-1">
        {TOOLS.map(({ id, label, Icon }) => (
          <Button
            key={id}
            variant={tool === id ? 'secondary' : 'ghost'}
            size="sm"
            aria-pressed={tool === id}
            onClick={() => setTool(id)}
            className="h-7 gap-1.5 px-2 text-xs">
            <Icon className="size-3.5" />{label}
          </Button>
        ))}
        <span className="flex-1" />
        <Button
          variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs"
          disabled={!marks.length} onClick={() => setMarks(marks.slice(0, -1))}>
          <Undo2Icon className="size-3.5" />Undo
        </Button>
        <Button
          variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs"
          disabled={!marks.length} onClick={() => setMarks([])}>
          <Trash2Icon className="size-3.5" />Clear
        </Button>
      </div>
      <div className="flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted/40 p-2">
        {/* The canvas has the picture's own size and is stretched over it, so
            marks land on the same pixels however small the dialog draws it. */}
        <div className="relative inline-block max-w-full">
          <img
            src={src} alt={item.name} draggable={false}
            className="block max-h-[calc(82vh-12rem)] w-auto max-w-full select-none object-contain" />
          <canvas
            ref={canvas}
            width={item.width}
            height={item.height}
            aria-label="Draw on the picture"
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
            className="absolute inset-0 size-full cursor-crosshair touch-none" />
        </div>
      </div>
    </div>
  );
}

// A line in your own words, travelling with the thing it is about. The element
// picker opens this dialog on what it just attached and lands the caret here,
// so pointing at something and saying what is wrong with it is one gesture
// rather than a trip back to the message box.
function Note({ item, onNote }) {
  const field = useRef(null);
  const fresh = !item.note;

  useEffect(() => {
    if (fresh) field.current?.focus();
    // Only on arrival. Re-focusing on every keystroke would fight the caret.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  // Labelled like the read-only rows above it, so a note already written still
  // announces itself as the note rather than as a box of unexplained text.
  return (
    <div className="flex items-center gap-3 text-xs">
      <span className="w-16 shrink-0 text-muted-foreground">note</span>
      <Input
        ref={field}
        value={item.note || ''}
        onChange={(e) => onNote(item.id, e.target.value)}
        // Enter has nothing left to confirm, the note is already saved, so it
        // means the same thing here as it does anywhere else: done.
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
        placeholder="Anything the agent should know about this"
        className="h-8 flex-1 text-sm" />
    </div>
  );
}

const subtitle = (item) => {
  if (item.kind === 'image') return `${item.width}×${item.height} · ${sizeLabel(item.size)}`;
  if (item.kind === 'file') return sizeLabel(item.size);
  if (item.kind === 'element') return 'picked in the preview';
  return 'could not be attached';
};

export function AttachmentPreview({ item, onNote, onMarks, onOpenChange }) {
  const open = !!item;
  // The marks being drawn, handed over only when the dialog closes: burning
  // them in and writing a file on every stroke would be wasted work.
  const [marks, setMarks] = useState([]);
  const [markedId, setMarkedId] = useState(null);
  if (item && item.id !== markedId) {
    setMarkedId(item.id);
    setMarks(item.marks || []);
  }
  const canMark = !!onMarks && item?.kind === 'image';

  const openChange = (next) => {
    if (!next && canMark && marks !== (item.marks || []) && (marks.length || item.marks?.length)) {
      onMarks(item, marks);
    }
    onOpenChange(next);
  };

  useEffect(() => {
    parkPreview(open);
    return () => parkPreview(false);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={openChange}>
      <DialogContent className="flex max-h-[82vh] max-w-3xl flex-col gap-3 p-4 sm:max-w-3xl">
        {item && (
          <>
            <DialogHeader className="gap-0 text-left">
              <DialogTitle className="flex items-center gap-2 truncate pr-6 text-sm">
                {item.kind === 'element' && <CrosshairIcon className="size-4 shrink-0 text-muted-foreground" />}
                <span className="truncate">{item.kind === 'element' ? (item.hit.area ? 'Area of the page' : 'Element from the page') : item.name}</span>
              </DialogTitle>
              <DialogDescription className="text-xs">{subtitle(item)}</DialogDescription>
            </DialogHeader>

            <Body item={item} marks={marks} setMarks={canMark ? setMarks : null} />

            {onNote && item.kind !== 'error' && <Note item={item} onNote={onNote} />}

            {item.path && <PathRow label="file" path={item.path} />}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
