import { useEffect, useState, useSyncExternalStore } from 'react';
import { CircleCheckIcon, CircleAlertIcon, GlobeIcon, LoaderCircleIcon, MinusIcon, PlusIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { resetZoom, stepZoom, zoomLevel } from '../../app.js';
import { browserState, getBrowserVersion, subscribeBrowser } from './browser-store';

// Zoom is written to the settings file, and the file is what everything else
// redraws from, so listening to it covers the menu and the keyboard too.
function useZoom() {
  const [zoom, setZoom] = useState(zoomLevel);
  useEffect(() => window.conn.settings.onChanged(() => setZoom(zoomLevel())), []);
  return zoom;
}

export default function StatusBar() {
  useSyncExternalStore(subscribeBrowser, getBrowserVersion, getBrowserVersion);
  const zoom = useZoom();

  const state = browserState;
  const Icon = state.error ? CircleAlertIcon : state.loading ? LoaderCircleIcon : state.live ? GlobeIcon : CircleCheckIcon;
  const label = state.error ? "Preview error" : state.loading ? "Loading preview" : state.live ? "Preview" : "Ready";

  return (
    <footer
      id="status"
      aria-label="Application status"
      className="flex h-9 shrink-0 items-center gap-3 border-t border-border/60 bg-[var(--ground)] px-3 text-xs text-muted-foreground">
      <div className="flex min-w-0 flex-1 items-center gap-2" role="status" aria-live="polite">
        <Icon aria-hidden="true" className={`size-3.5 shrink-0 ${state.loading ? 'animate-spin motion-reduce:animate-none' : ''} ${state.error ? 'text-destructive' : ''}`} />
        <span className="shrink-0">{label}</span>
        {state.live && !state.loading && (
          <span className="truncate text-muted-foreground/70" title={state.status || state.url}>
            <span aria-hidden="true" className="mr-2">·</span>{state.status || state.url}
          </span>
        )}
      </div>

      <Separator orientation="vertical" className="!h-4" />

      <div role="group" aria-label="Application zoom" className="flex shrink-0 items-center gap-1">
        <span className="mr-1 hidden sm:inline">Zoom</span>
        <Button variant="ghost" size="icon-xs" aria-label="Zoom out" title="Smaller (Ctrl+-)" onClick={() => stepZoom(-1)}>
          <MinusIcon />
        </Button>
        <Button
          variant="ghost"
          size="xs"
          data-default={zoom === 1 ? '' : undefined}
          aria-label={`Zoom ${Math.round(zoom * 100)}%, reset to 100%`}
          className="min-w-[6ch] tabular-nums"
          title="Back to 100% (Ctrl+0)"
          onClick={resetZoom}>
          {`${Math.round(zoom * 100)}%`}
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label="Zoom in" title="Bigger (Ctrl++)" onClick={() => stepZoom(1)}>
          <PlusIcon />
        </Button>
      </div>
    </footer>
  );
}
