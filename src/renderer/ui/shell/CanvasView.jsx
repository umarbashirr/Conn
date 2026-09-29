/* The Canvas tab: an unlimited board where the agent draws frames, and the ways
   to take them out.

   Frames are drawn as DOM, not onto a <canvas>. Layout is the browser's own
   flexbox and text wrapping, which is what the exports are written in, and
   text stays sharp at any zoom because the board is scaled with a transform
   rather than redrawn. Labels, outlines and handles sit in a layer above in
   screen space, so they stay the same size however far you zoom.

   Gestures are one state machine: idle, pan, move, resize or marquee. */
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  CopyIcon,
  DownloadIcon,
  Maximize2Icon,
  Minimize2Icon,
  PaletteIcon,
  Trash2Icon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { runCommand } from '../../app.js';
import { onProject, project } from '../../project.js';
import { unreachable } from './canvas-schema.js';
import { pathFill, styleOf } from './canvas-style.js';
import { fit, frameAt, handleAt, HANDLES, LABEL, overlaps, rectFrom, resize, toBoard, zoomAt } from './canvas-geometry.js';
import {
  activate,
  CANVAS_DIR,
  canvasState,
  deactivate,
  deleteSelection,
  duplicateSelection,
  EXPORTS,
  exportFrames,
  getCanvasVersion,
  persist,
  preview,
  select,
  setViewport,
  subscribeCanvas,
} from './canvas-store';
import { useLayout } from './Shell';
import { activeKind, subscribeTabs } from './tabs-store';

const ICON_BUTTON = 'size-7 rounded-md text-muted-foreground';
const DANGER_BUTTON = 'size-7 rounded-md text-destructive';
const DRAG_SLOP = 3;
const ZOOM_STEP = 1.25;
const GRID = 24;
const CURSOR = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };

function useCanvas() {
  useSyncExternalStore(subscribeCanvas, getCanvasVersion, getCanvasVersion);
  return canvasState;
}

// Whether this tab is the one on screen, asked the way ChangesView asks.
const subscribeTop = (fn) => {
  const offTabs = subscribeTabs(fn);
  const offFocus = onProject(fn);
  return () => { offTabs(); offFocus(); };
};
const onTop = () => activeKind(project.focused) === 'canvas';

const HOME = { x: 48, y: 48 + LABEL, zoom: 1 };
const viewport = () => canvasState.viewport ?? HOME;

// ------------------------------------------------------------------ frames

function NodeView({ node, parent }) {
  const style = styleOf(node, parent);
  switch (node.type) {
    case 'frame':
    case 'group':
      return <div style={style}>{node.children?.map((c, i) => <NodeView key={i} node={c} parent={node} />)}</div>;
    case 'rect':
    case 'ellipse':
    case 'line':
      return <div style={style} />;
    case 'text':
      return <div style={style}>{node.text}</div>;
    case 'vector':
      return (
        <svg style={style} viewBox={node.viewBox}>
          {node.paths.map((p, i) => (
            <path key={i} d={p.d} fill={pathFill(p)} stroke={p.stroke} strokeWidth={p.strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
          ))}
        </svg>
      );
    default:
      return unreachable(node);
  }
}

// Redrawn when the agent edits the frame or it is resized, not when it moves.
const FrameContent = memo(function FrameContent({ frame, width, height }) {
  return <NodeView node={{ ...frame, width, height }} parent={null} />;
});

function FrameView({ item }) {
  return (
    <div data-frame={item.file} className="absolute shadow-[0_1px_3px_rgba(0,0,0,0.12)]" style={{ left: item.x, top: item.y }}>
      <FrameContent frame={item.frame} width={item.width} height={item.height} />
    </div>
  );
}

// ------------------------------------------------------------------ overlay

function Overlay({ board, v, selection, marquee }) {
  const one = selection.length === 1 ? board.find((f) => f.file === selection[0]) : null;
  const box = (f) => ({ left: v.x + f.x * v.zoom, top: v.y + f.y * v.zoom, width: f.width * v.zoom, height: f.height * v.zoom });
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {board.map((f) => {
        const b = box(f);
        const picked = selection.includes(f.file);
        return (
          <div key={f.file}>
            <div
              className={`absolute flex items-center gap-1 truncate text-[11px] leading-none ${f.error ? 'text-destructive' : picked ? 'text-primary' : 'text-muted-foreground'}`}
              style={{ left: b.left, top: b.top - LABEL + 4, maxWidth: Math.max(b.width, 60), height: LABEL - 6 }}
              title={f.error || undefined}>
              {f.error && <TriangleAlertIcon className="size-3 shrink-0" />}
              <span className="truncate">{f.name}</span>
            </div>
            {(picked || f.error) && (
              <div className={`absolute border ${f.error ? 'border-destructive' : 'border-primary'} ${picked ? 'border-2' : 'border-dashed'}`} style={{ ...b, margin: -1 }} />
            )}
          </div>
        );
      })}
      {one && Object.entries(HANDLES).map(([h, [fx, fy]]) => {
        const b = box(one);
        return (
          <div
            key={h}
            data-handle={h}
            className="absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-[2px] border border-primary bg-background"
            style={{ left: b.left + b.width * fx, top: b.top + b.height * fy }} />
        );
      })}
      {marquee && (
        <div
          className="absolute border border-primary bg-primary/10"
          style={{ left: v.x + marquee.x * v.zoom, top: v.y + marquee.y * v.zoom, width: marquee.width * v.zoom, height: marquee.height * v.zoom }} />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ board

function Board({ boardRef, zoomBy, fitTo }) {
  const s = useCanvas();
  const v = viewport();
  const gesture = useRef(null);
  const space = useRef(false);
  const [marquee, setMarquee] = useState(null);
  const [cursor, setCursor] = useState('default');

  useEffect(() => {
    const el = boardRef.current;
    const onWheel = (e) => {
      e.preventDefault();
      const cur = viewport();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        const dy = Math.max(-60, Math.min(60, e.deltaY));
        setViewport(zoomAt(cur, e.clientX - r.left, e.clientY - r.top, cur.zoom * Math.exp(-dy * 0.005)));
      } else {
        setViewport({ ...cur, x: cur.x - e.deltaX, y: cur.y - e.deltaY });
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [boardRef]);

  const local = (e) => {
    const r = boardRef.current.getBoundingClientRect();
    return { sx: e.clientX - r.left, sy: e.clientY - r.top };
  };

  const onPointerDown = (e) => {
    boardRef.current.focus();
    const { sx, sy } = local(e);
    const cur = viewport();
    if (e.button === 1 || (e.button === 0 && space.current)) {
      gesture.current = { kind: 'pan', sx, sy, from: cur };
      setCursor('grabbing');
    } else if (e.button === 0) {
      const one = s.selection.length === 1 ? s.board.find((f) => f.file === s.selection[0]) : null;
      const handle = one && handleAt(one, cur, sx, sy);
      const p = toBoard(cur, sx, sy);
      const hit = !handle && frameAt(s.board, p, cur.zoom);
      if (handle) {
        gesture.current = { kind: 'resize', sx, sy, handle, from: { file: one.file, x: one.x, y: one.y, width: one.width, height: one.height }, moved: false };
      } else if (hit) {
        // A press on one of several selected frames may be the start of moving
        // them all, so narrowing to that one waits for a release without a drag.
        const narrow = !e.shiftKey && s.selection.length > 1 && s.selection.includes(hit.file) ? hit.file : null;
        if (e.shiftKey) select(s.selection.includes(hit.file) ? s.selection.filter((f) => f !== hit.file) : [...s.selection, hit.file]);
        else if (!s.selection.includes(hit.file)) select([hit.file]);
        const from = canvasState.board.filter((f) => canvasState.selection.includes(f.file)).map((f) => ({ file: f.file, x: f.x, y: f.y, width: f.width, height: f.height }));
        gesture.current = { kind: 'move', sx, sy, from, moved: false, narrow };
      } else {
        const base = e.shiftKey ? s.selection : [];
        if (!e.shiftKey) select([]);
        gesture.current = { kind: 'marquee', start: p, base };
      }
    } else {
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e) => {
    const { sx, sy } = local(e);
    const cur = viewport();
    const g = gesture.current;
    if (!g) {
      const one = s.selection.length === 1 ? s.board.find((f) => f.file === s.selection[0]) : null;
      const handle = one && handleAt(one, cur, sx, sy);
      setCursor(space.current ? 'grab' : handle ? CURSOR[handle] : 'default');
      return;
    }
    switch (g.kind) {
      case 'pan':
        setViewport({ ...g.from, x: g.from.x + sx - g.sx, y: g.from.y + sy - g.sy });
        return;
      case 'move':
      case 'resize': {
        if (!g.moved && Math.hypot(sx - g.sx, sy - g.sy) < DRAG_SLOP) return;
        g.moved = true;
        const dx = (sx - g.sx) / cur.zoom;
        const dy = (sy - g.sy) / cur.zoom;
        preview(g.kind === 'move'
          ? g.from.map((f) => ({ ...f, x: f.x + dx, y: f.y + dy }))
          : [{ file: g.from.file, ...resize(g.from, g.handle, dx, dy) }]);
        return;
      }
      case 'marquee': {
        const r = rectFrom(g.start, toBoard(cur, sx, sy));
        setMarquee(r);
        select([...new Set([...g.base, ...s.board.filter((f) => overlaps(f, r)).map((f) => f.file)])]);
        return;
      }
      default:
        unreachable(g.kind);
    }
  };

  const onPointerUp = () => {
    const g = gesture.current;
    gesture.current = null;
    setMarquee(null);
    setCursor(space.current ? 'grab' : 'default');
    if (!g) return;
    switch (g.kind) {
      case 'pan':
      case 'marquee':
        return;
      case 'move':
        if (g.moved) persist(g.from.map((f) => f.file));
        else if (g.narrow) select([g.narrow]);
        return;
      case 'resize':
        if (g.moved) persist([g.from.file]);
        return;
      default:
        unreachable(g.kind);
    }
  };

  const onKeyDown = (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === ' ') {
      e.preventDefault();
      if (!space.current) setCursor('grab');
      space.current = true;
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      deleteSelection();
    } else if (e.key === 'Escape') {
      select([]);
    } else if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      select(s.board.map((f) => f.file));
    } else if (e.shiftKey && e.code === 'Digit1') {
      fitTo(s.board);
    } else if (e.shiftKey && e.code === 'Digit2') {
      fitTo(s.board.filter((f) => s.selection.includes(f.file)), 4);
    } else if (e.shiftKey && e.code === 'Digit0') {
      zoomBy(1 / viewport().zoom);
    } else if (!mod && (e.key === '=' || e.key === '+')) {
      zoomBy(ZOOM_STEP);
    } else if (!mod && e.key === '-') {
      zoomBy(1 / ZOOM_STEP);
    } else {
      return;
    }
    e.stopPropagation();
  };

  const onKeyUp = (e) => {
    if (e.key !== ' ') return;
    space.current = false;
    if (!gesture.current) setCursor('default');
  };

  const grid = GRID * v.zoom;
  return (
    <div
      ref={boardRef}
      tabIndex={0}
      data-canvas-board=""
      className="relative min-h-0 flex-1 touch-none select-none overflow-hidden bg-muted/40 outline-none"
      style={{
        cursor,
        backgroundImage: grid >= 8 ? 'radial-gradient(circle, color-mix(in oklab, var(--muted-foreground) 30%, transparent) 1px, transparent 1px)' : undefined,
        backgroundSize: `${grid}px ${grid}px`,
        backgroundPosition: `${v.x}px ${v.y}px`,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onBlur={() => { space.current = false; }}>
      <div data-canvas-world="" className="absolute top-0 left-0 origin-top-left" style={{ transform: `translate(${v.x}px, ${v.y}px) scale(${v.zoom})` }}>
        {s.board.map((f) => <FrameView key={f.file} item={f} />)}
      </div>
      <Overlay board={s.board} v={v} selection={s.selection} marquee={marquee} />
    </div>
  );
}

// ------------------------------------------------------------------ header

function ZoomMenu({ zoomBy, fitTo }) {
  const s = useCanvas();
  const picked = s.board.filter((f) => s.selection.includes(f.file));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 w-14 px-2 font-mono text-muted-foreground text-xs tabular-nums" title="Zoom">
          {`${Math.round(viewport().zoom * 100)}%`}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuItem onSelect={() => zoomBy(ZOOM_STEP)}>Zoom in<DropdownMenuShortcut>+</DropdownMenuShortcut></DropdownMenuItem>
        <DropdownMenuItem onSelect={() => zoomBy(1 / ZOOM_STEP)}>Zoom out<DropdownMenuShortcut>−</DropdownMenuShortcut></DropdownMenuItem>
        <DropdownMenuItem onSelect={() => zoomBy(1 / viewport().zoom)}>Zoom to 100%<DropdownMenuShortcut>Shift+0</DropdownMenuShortcut></DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!s.board.length} onSelect={() => fitTo(s.board)}>Zoom to fit<DropdownMenuShortcut>Shift+1</DropdownMenuShortcut></DropdownMenuItem>
        <DropdownMenuItem disabled={!picked.length} onSelect={() => fitTo(picked, 4)}>Zoom to selection<DropdownMenuShortcut>Shift+2</DropdownMenuShortcut></DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ExportMenu({ disabled, what }) {
  const groups = [['code', 'Code'], ['figma', 'Figma']];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 gap-1.5 px-2 text-xs" disabled={disabled} title={`Export ${what}`}>
          <DownloadIcon />
          Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="text-muted-foreground text-xs">{`Exports ${what}`}</DropdownMenuLabel>
        {groups.map(([group, label]) => (
          <div key={group}>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-muted-foreground text-xs">{label}</DropdownMenuLabel>
            {EXPORTS.filter((e) => e.group === group).map((e) => (
              <DropdownMenuItem key={e.id} onSelect={() => exportFrames(e.id)}>{e.label}</DropdownMenuItem>
            ))}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Errors({ records }) {
  const broken = records.filter((r) => r.error);
  if (!broken.length) return null;
  return (
    <div data-canvas-errors="" className="max-h-28 shrink-0 overflow-y-auto border-b px-3 py-1.5 text-destructive text-xs">
      {broken.map((r) => (
        <div key={r.file} className="flex items-start gap-2 py-0.5">
          <TriangleAlertIcon className="mt-px size-3.5 shrink-0" />
          <span className="break-words">{r.frame ? `${r.error} Showing the last version that worked.` : r.error}</span>
        </div>
      ))}
    </div>
  );
}

function Nothing() {
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyMedia variant="icon"><PaletteIcon /></EmptyMedia>
        <EmptyTitle>Nothing on the canvas yet</EmptyTitle>
        <EmptyDescription>
          {`Describe a screen and the agent draws it here as a frame. Each frame is a file in ${CANVAS_DIR}/, redrawn as the agent edits it.`}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button size="sm" onClick={() => window.connChat?.design?.()}>
          <PaletteIcon />
          Design a UI
        </Button>
      </EmptyContent>
    </Empty>
  );
}

export default function CanvasView() {
  const s = useCanvas();
  const { rightOpen, previewFull } = useLayout();
  const top = useSyncExternalStore(subscribeTop, onTop, onTop);
  const showing = rightOpen && top;
  const boardRef = useRef(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    if (!showing) return undefined;
    activate();
    return deactivate;
  }, [showing]);

  const hasBoard = s.records.length > 0;
  useLayoutEffect(() => {
    const el = boardRef.current;
    if (!el) return undefined;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasBoard]);

  const fitTo = useCallback((frames, max = 1) => {
    if (frames.length && size.w) setViewport(fit(frames, size.w, size.h, max));
  }, [size]);
  const zoomBy = useCallback((k) => {
    const v = viewport();
    setViewport(zoomAt(v, size.w / 2, size.h / 2, v.zoom * k));
  }, [size]);

  // Before paint, so the board never flashes at the default viewport first.
  useLayoutEffect(() => {
    if (!s.viewport && s.board.length && size.w) fitTo(s.board);
  }, [s.viewport, s.board, size, fitTo]);

  const picked = s.selection.length;
  const what = picked ? (picked === 1 ? 'the selected frame' : `${picked} selected frames`) : 'every frame';

  return (
    <div id="canvas-view" className="flex h-full min-h-0 flex-col" hidden={!showing || undefined}>
      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-2.5">
        <PaletteIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-[11.5px] text-muted-foreground">
          {s.board.length ? `${s.board.length} ${s.board.length === 1 ? 'frame' : 'frames'}${picked ? `, ${picked} selected` : ''}` : 'No frames yet'}
        </span>

        <span className="flex-1" />

        {picked > 0 && (
          <>
            <Button variant="ghost" size="icon" className={ICON_BUTTON} title="Duplicate" onClick={duplicateSelection}><CopyIcon /></Button>
            <Button variant="ghost" size="icon" className={ICON_BUTTON} title="Move to the trash (Delete)" onClick={deleteSelection}><Trash2Icon /></Button>
          </>
        )}
        <ZoomMenu zoomBy={zoomBy} fitTo={fitTo} />
        <ExportMenu disabled={!s.board.length} what={what} />

        <Button
          variant="ghost"
          size="icon"
          className={ICON_BUTTON}
          title={previewFull ? 'Back to the chat (Ctrl+Shift+F)' : 'Canvas at full width (Ctrl+Shift+F)'}
          onClick={() => runCommand('previewFull')}>
          {previewFull ? <Minimize2Icon /> : <Maximize2Icon />}
        </Button>
        <Button variant="ghost" size="icon" className={DANGER_BUTTON} title="Hide the canvas" onClick={() => runCommand('canvas', false)}>
          <XIcon />
        </Button>
      </div>

      <Errors records={s.records} />
      {hasBoard ? <Board boardRef={boardRef} zoomBy={zoomBy} fitTo={fitTo} /> : <Nothing />}
    </div>
  );
}
