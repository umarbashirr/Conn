/* The Worktrees tab: every checkout of the focused folder's repository, the
   main one first, each with how far it has moved from the main checkout's
   branch and how much it has not committed.

   The rail is for moving between chats; this is for the worktrees themselves:
   making one, opening it, and taking it away when the branch is done. It reads
   `git worktree list`, so worktrees made by `claude --worktree` or by hand in a
   terminal are here too.

   Buttons say what they do with `title` rather than a Tooltip, for the reason
   ChangesView gives: the preview is a native view over this document. */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { FolderOpenIcon, GitForkIcon, GitMergeIcon, GitPullRequestIcon, MessageSquarePlusIcon, PlusIcon, RotateCwIcon, Trash2Icon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { branchNameError } from '../../../shared/branch-name';
import { onProject, project, shortPath } from '../../project.js';
import { useLayout } from './Shell';
import { activeKind, subscribeTabs } from './tabs-store';
import { refreshWorktrees, useWorktrees } from './worktrees-store';

const subscribeTop = (fn) => {
  const offTabs = subscribeTabs(fn);
  const offFocus = onProject(fn);
  return () => { offTabs(); offFocus(); };
};
const onTop = () => activeKind(project.focused) === 'worktrees';
const focusedDir = () => project.focused || project.dir || '';

const ICON_BUTTON = 'size-7 rounded-md text-muted-foreground';

function startChatIn(dir) {
  window.connChat?.newChat(dir);
  requestAnimationFrame(() => document.querySelector('#agent-root [contenteditable="true"]')?.focus());
}

function Counts({ w, base }) {
  if (w.main) return <span className="text-muted-foreground text-xs">main checkout</span>;
  const parts = [];
  if (w.ahead != null) parts.push(<span key="a" title={`${w.ahead} commit${w.ahead === 1 ? '' : 's'} not on ${base}`}>↑{w.ahead}</span>);
  if (w.behind != null) parts.push(<span key="b" title={`${w.behind} commit${w.behind === 1 ? '' : 's'} on ${base} not here`}>↓{w.behind}</span>);
  if (w.dirty) parts.push(<span key="d" className="text-amber-500">{w.dirty} uncommitted</span>);
  if (!parts.length) return null;
  return <span className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">{parts}</span>;
}

function Row({ dir, w, base, here, onRemove }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [merging, setMerging] = useState(false);
  const [note, setNote] = useState('');

  // Both act on the branch, so both want something on it the base lacks.
  const ready = !w.main && !!w.branch && w.ahead > 0;
  const blocked = w.dirty ? 'Commit or discard the uncommitted files first' : '';

  const merge = async () => {
    setBusy(true);
    setError('');
    const res = await window.conn.project.mergeWorktree(dir, w.dir).catch(() => null);
    setBusy(false);
    setMerging(false);
    if (res?.ok) setNote(`Merged ${res.commits} commit${res.commits === 1 ? '' : 's'} into ${res.base}.`);
    else setError(res?.error || 'Could not merge.');
  };

  const pr = async () => {
    setBusy(true);
    setError('');
    setNote('Pushing and opening a pull request…');
    const res = await window.conn.project.worktreePr(dir, w.dir).catch(() => null);
    setBusy(false);
    if (res?.ok) setNote(res.existed ? 'A pull request was already open; opened it.' : 'Pull request opened in your browser.');
    else { setNote(''); setError(res?.error || 'Could not open a pull request.'); }
  };

  const remove = async () => {
    setBusy(true);
    setError('');
    const res = await onRemove(w, confirm === 'force');
    setBusy(false);
    if (res?.ok) return;
    if (res?.dirty) setConfirm('force');
    else { setConfirm(false); setError(res?.error || 'Could not remove it.'); }
  };

  return (
    <li className={cn('group flex flex-col gap-1 rounded-md px-2 py-1.5 hover:bg-secondary/60', here && 'bg-secondary')}>
      <div className="flex min-w-0 items-center gap-2">
        <GitForkIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-[13px]" title={w.dir}>
          {w.branch || (w.detached ? `detached at ${w.head}` : w.head)}
        </span>
        {w.prunable && <Badge variant="outline" className="text-[10px]">missing</Badge>}
        {w.open && !here && <Badge variant="secondary" className="text-[10px]">open</Badge>}
        {!w.prunable && (
          <span className="flex shrink-0 items-center opacity-70 group-hover:opacity-100">
            <Button variant="ghost" size="icon" className={ICON_BUTTON} title="Open this folder" onClick={() => window.conn.project.open({ dir: w.dir })}>
              <FolderOpenIcon className="size-3.5" />
            </Button>
            <Button variant="ghost" size="icon" className={ICON_BUTTON} title="Start a chat in this worktree" onClick={() => startChatIn(w.dir)}>
              <MessageSquarePlusIcon className="size-3.5" />
            </Button>
            {ready && (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  className={ICON_BUTTON}
                  disabled={busy || !!blocked}
                  title={blocked || `Merge ${w.branch} into ${base}`}
                  onClick={() => { setNote(''); setError(''); setMerging(true); }}>
                  <GitMergeIcon className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className={ICON_BUTTON}
                  disabled={busy}
                  title={`Push ${w.branch} and open a pull request into ${base}`}
                  onClick={pr}>
                  <GitPullRequestIcon className="size-3.5" />
                </Button>
              </>
            )}
            {!w.main && !confirm && (
              <Button variant="ghost" size="icon" className={ICON_BUTTON} title="Remove this worktree (the branch is kept)" onClick={() => setConfirm(true)}>
                <Trash2Icon className="size-3.5" />
              </Button>
            )}
          </span>
        )}
      </div>
      <div className="flex min-w-0 items-center gap-2 pl-5.5">
        <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">{shortPath(w.dir)}</span>
        <Counts w={w} base={base} />
      </div>
      {confirm && (
        <div className="flex items-center gap-2 pl-5.5 text-xs">
          <span className="min-w-0 flex-1 text-muted-foreground">
            {confirm === 'force'
              ? `${w.dirty || 'Some'} uncommitted file${w.dirty === 1 ? '' : 's'} will be lost.`
              : `Remove the folder? ${w.branch ? `Branch ${w.branch} stays.` : ''}`}
          </span>
          <Button variant="ghost" size="xs" disabled={busy} onClick={() => setConfirm(false)}>Cancel</Button>
          <Button variant="destructive" size="xs" disabled={busy} onClick={remove}>
            {confirm === 'force' ? 'Remove anyway' : 'Remove'}
          </Button>
        </div>
      )}
      {merging && (
        <div className="flex items-center gap-2 pl-5.5 text-xs">
          <span className="min-w-0 flex-1 text-muted-foreground">
            Merge {w.ahead} commit{w.ahead === 1 ? '' : 's'} from {w.branch} into {base}?
          </span>
          <Button variant="ghost" size="xs" disabled={busy} onClick={() => setMerging(false)}>Cancel</Button>
          <Button size="xs" disabled={busy} onClick={merge}>Merge</Button>
        </div>
      )}
      {note && (
        <div className="flex items-center gap-2 pl-5.5 text-xs">
          <span className="min-w-0 flex-1 text-emerald-600 dark:text-emerald-400">{note}</span>
          {/* Merged is the usual moment to be done with the folder. */}
          {note.startsWith('Merged') && !confirm && (
            <Button variant="ghost" size="xs" onClick={() => { setNote(''); setConfirm(true); }}>Remove worktree</Button>
          )}
        </div>
      )}
      {error && <p className="pl-5.5 text-destructive text-xs">{error}</p>}
    </li>
  );
}

function NewWorktree({ dir, taken, onMade }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const draft = name.trim();
  const problem = draft ? (branchNameError(draft) || (taken.includes(draft) ? 'A branch named that already exists.' : '')) : '';

  const submit = async (e) => {
    e?.preventDefault();
    if (busy || !draft || problem) return;
    setBusy(true);
    setError('');
    const res = await window.conn.project.worktree(dir, draft).catch(() => null);
    setBusy(false);
    if (!res?.ok) { setError(res?.error || 'Could not make the worktree.'); return; }
    setName('');
    onMade();
    startChatIn(res.dir);
  };

  return (
    <form className="flex flex-col gap-1 border-b p-2" onSubmit={submit}>
      <div className="flex items-center gap-1.5">
        <Input
          value={name}
          placeholder="New branch in its own worktree"
          aria-invalid={!!problem}
          className="h-7 text-[12px]"
          onChange={(e) => { setName(e.target.value); setError(''); }}
          // Said outright, as the browser's address bar does: a form inside
          // the shell does not get Enter as a submit.
          onKeyDown={(e) => { if (e.key === 'Enter') submit(e); }} />
        <Button type="submit" size="sm" className="h-7" disabled={busy || !draft || !!problem}>
          <PlusIcon className="size-3.5" />
          Create
        </Button>
      </div>
      {(problem || error) && <p className="text-destructive text-xs">{problem || error}</p>}
    </form>
  );
}

export default function WorktreesView() {
  const { rightOpen } = useLayout();
  const top = useSyncExternalStore(subscribeTop, onTop, onTop);
  const showing = rightOpen && top;
  const dir = useSyncExternalStore(onProject, focusedDir, focusedDir);
  const state = useWorktrees(dir, showing);
  const [branches, setBranches] = useState([]);

  // Branch names only matter to the create box, which refuses a taken one.
  const load = useCallback(async () => {
    if (!dir) return;
    refreshWorktrees(dir);
    const b = await window.conn.project.branches(dir).catch(() => null);
    setBranches(b?.branches || []);
  }, [dir]);

  useEffect(() => { if (showing) load(); }, [showing, load]);

  // No reload here: removing announces a project change, which reloads with
  // whichever folder is focused afterwards. Reloading from this closure would
  // ask about a folder that may have just been closed.
  const remove = (w, force) => window.conn.project.removeWorktree(dir, w.dir, force).catch(() => null);

  const { worktrees, base, error, loading } = state;
  const repo = worktrees.length > 0;

  return (
    <div id="worktrees-view" className="flex h-full min-h-0 flex-col" hidden={!showing || undefined}>
      {repo && (
        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
          <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
            {worktrees.length} worktree{worktrees.length === 1 ? '' : 's'}{base ? ` · compared with ${base}` : ''}
          </span>
          <Button variant="ghost" size="icon" className={ICON_BUTTON} title="Read the list again" onClick={load}>
            <RotateCwIcon className="size-3.5" />
          </Button>
        </div>
      )}
      {repo && <NewWorktree dir={dir} taken={branches} onMade={load} />}
      {repo ? (
        <ul className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {worktrees.map((w) => (
            <Row key={w.dir} dir={dir} w={w} base={base} here={w.dir === dir} onRemove={remove} />
          ))}
        </ul>
      ) : (
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon"><GitForkIcon /></EmptyMedia>
            <EmptyTitle>{loading ? 'Reading worktrees' : 'No worktrees here'}</EmptyTitle>
            <EmptyDescription>
              {loading ? '' : (error || 'Open a git repository to give each chat a branch of its own.')}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  );
}
