/* Run pipeline: pick a saved pipeline and a folder, answer its question, and
   start it. A file with a mistake in it is listed with the reason, so a typo
   in the YAML reads as a typo and not as a pipeline that went missing. */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { CopyIcon, GitForkIcon, WorkflowIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { onProject, project } from '../../project.js';
import { closeRunDialog, getRunsVersion, runsState, startRun, subscribeRuns } from '../shell/pipeline-store';
import { toast } from '../shell/toast';

const folderName = (dir) => String(dir || '').split(/[/\\]/).filter(Boolean).pop() || dir;

function useOpenFolders() {
  const [, bump] = useState(0);
  useEffect(() => onProject(() => bump((n) => n + 1)), []);
  return { dirs: (project.projects || []).map((p) => p.dir), focused: project.focused || project.dir };
}

export function PipelineDialog() {
  useSyncExternalStore(subscribeRuns, getRunsVersion, getRunsVersion);
  const open = runsState().dialog;
  const { dirs, focused } = useOpenFolders();
  const [dir, setDir] = useState(null);
  const [list, setList] = useState(null);
  const [userDir, setUserDir] = useState('');
  const [chosen, setChosen] = useState(null);
  const [input, setInput] = useState('');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState(null);

  const folder = dir && dirs.includes(dir) ? dir : focused;

  const load = async (at = folder) => {
    const res = await window.conn.pipelines.list(at).catch((e) => ({ pipelines: [], error: e.message }));
    setList(res.pipelines || []);
    setUserDir(res.userDir || '');
    setChosen((cur) => {
      const ok = (res.pipelines || []).filter((p) => p.ok);
      return ok.find((p) => p.id === cur)?.id || ok[0]?.id || null;
    });
  };

  useEffect(() => {
    if (!open) return;
    setError(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, folder]);

  const pick = (list || []).find((p) => p.id === chosen && p.ok) || null;
  const needsInput = !!pick?.pipeline.input;
  const ready = !!pick && !!folder && (!needsInput || input.trim()) && !starting;

  const start = async () => {
    if (!ready) return;
    setStarting(true);
    setError(null);
    const res = await startRun({ pipeline: pick.pipeline, input, dir: folder });
    setStarting(false);
    if (res?.error) { setError(res.error); return; }
    setInput('');
    closeRunDialog();
    window.connChat?.board?.(true);
    toast(`${pick.pipeline.name} started`, pick.pipeline.worktree ? 'It runs in a new worktree. Follow it on the Board.' : 'Follow it on the Board.');
  };

  const example = async () => {
    const res = await window.conn.pipelines.example().catch((e) => ({ error: e.message }));
    if (res?.error) { setError(res.error); return; }
    toast('Example pipeline saved', res.file);
    load();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) closeRunDialog(); }}>
      <DialogContent data-slot="pipeline-dialog" className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><WorkflowIcon className="size-4" />Run a pipeline</DialogTitle>
          <DialogDescription>
            Each stage runs in a chat of its own, in order. A stage with a gate waits for you to Continue.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-[12px]">
            <span className="text-muted-foreground">Folder</span>
            <select
              aria-label="Folder"
              className="h-8 rounded-md border bg-background px-2 text-[13px]"
              value={folder || ''}
              onChange={(e) => setDir(e.target.value)}>
              {dirs.map((d) => <option key={d} value={d}>{folderName(d)} · {d}</option>)}
            </select>
          </label>

          <div className="flex flex-col gap-1">
            <span className="text-[12px] text-muted-foreground">Pipeline</span>
            <div role="radiogroup" aria-label="Pipeline" className="flex max-h-64 flex-col gap-1 overflow-y-auto">
              {list && !list.length && (
                <div className="rounded-lg border border-dashed p-3 text-[12px] text-muted-foreground">
                  <p>No pipelines yet. Put YAML files in <code>.conn/pipelines/</code> in a project, or in <code>{userDir || '~/.conn/pipelines'}</code> for every project.</p>
                  <Button size="sm" variant="outline" className="mt-2" onClick={example}>Create an example</Button>
                </div>
              )}
              {(list || []).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={p.id === chosen}
                  aria-label={p.ok ? p.pipeline.name : p.name}
                  disabled={!p.ok}
                  data-slot="pipeline-option"
                  onClick={() => p.ok && setChosen(p.id)}
                  className={cn(
                    'flex flex-col gap-0.5 rounded-lg border px-3 py-2 text-left',
                    p.id === chosen && 'border-foreground/40 bg-secondary/60',
                    !p.ok && 'cursor-not-allowed opacity-80',
                  )}>
                  <span className="flex items-center gap-2 text-[13px] font-medium">
                    {p.ok ? p.pipeline.name : p.name}
                    <span className="rounded border px-1 text-[10px] font-normal text-muted-foreground">{p.scope === 'project' ? 'this project' : 'yours'}</span>
                    {p.ok && p.pipeline.worktree && (
                      <span className="flex items-center gap-0.5 text-[10px] font-normal text-muted-foreground"><GitForkIcon className="size-2.5" />new worktree</span>
                    )}
                  </span>
                  {p.ok ? (
                    <>
                      {p.pipeline.description && <span className="text-[12px] text-muted-foreground">{p.pipeline.description}</span>}
                      <span className="text-[11px] text-muted-foreground">
                        {p.pipeline.stages.map((s) => `${s.title}${s.gate ? ' (gate)' : ''}`).join(' → ')}
                      </span>
                    </>
                  ) : (
                    <span className="text-[12px] text-destructive">{p.error}</span>
                  )}
                  <span className="truncate font-mono text-[10px] text-muted-foreground/80" title={p.file}>{p.file}</span>
                </button>
              ))}
            </div>
            {list?.length > 0 && (
              <button
                type="button"
                className="flex w-fit items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                title="Copy the folder your own pipelines live in"
                onClick={() => { navigator.clipboard?.writeText(userDir); toast('Copied', userDir); }}>
                <CopyIcon className="size-3" />Your pipelines live in {userDir}
              </button>
            )}
          </div>

          {needsInput && (
            <label className="flex flex-col gap-1 text-[12px]">
              <span className="text-muted-foreground">{pick.pipeline.input}</span>
              <Textarea
                aria-label={pick.pipeline.input}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); start(); } }}
                className="min-h-20 text-[13px]"
                placeholder="Ctrl+Enter starts it" />
            </label>
          )}
          {error && <p role="alert" className="text-[12px] text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={closeRunDialog}>Cancel</Button>
          <Button disabled={!ready} onClick={start}>{starting ? 'Starting…' : 'Start'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
