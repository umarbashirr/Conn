/* The rules behind **Always**. A permission card's Always hands Claude the rule
   it suggested, and Claude keeps it in a settings file from then on. This page
   lists every rule in the three files Claude reads for the focused folder, and
   takes one back with a click. The other CLIs are told "allow always" and keep
   that themselves, somewhere this page does not read. */
import { useCallback, useEffect, useState } from 'react';
import { RotateCwIcon, Trash2Icon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useProject } from '../useProject';

const SCOPES = {
  local: { label: 'This folder, this machine', note: '.claude/settings.local.json' },
  project: { label: 'This folder, shared', note: '.claude/settings.json, usually committed' },
  user: { label: 'Every folder', note: '~/.claude/settings.json' },
};
const KIND = {
  allow: { word: 'allow', tone: 'text-emerald-600 dark:text-emerald-400' },
  ask: { word: 'ask', tone: 'text-amber-600 dark:text-amber-400' },
  deny: { word: 'deny', tone: 'text-destructive' },
};

function Rule({ r, busy, onRemove }) {
  return (
    <li className="flex min-w-0 items-center gap-2 py-1.5">
      <span className={cn('w-10 shrink-0 font-mono text-[11px]', KIND[r.kind].tone)}>{KIND[r.kind].word}</span>
      <code className="min-w-0 flex-1 truncate font-mono text-[12px]" title={r.rule}>{r.rule}</code>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
        aria-label={`Remove ${r.kind} rule ${r.rule}`}
        title="Remove this rule"
        disabled={busy}
        onClick={() => onRemove(r)}>
        <Trash2Icon className="size-3.5" />
      </Button>
    </li>
  );
}

export function PermissionRules() {
  const info = useProject();
  const project = info.focused || info.dir || '';
  const [state, setState] = useState({ loading: true, rules: [], errors: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const res = await window.conn.rules.list(project || null).catch(() => null);
    setState({ loading: false, rules: res?.rules || [], errors: res?.errors || [] });
  }, [project]);

  useEffect(() => { load(); }, [load]);

  const remove = async (r) => {
    setBusy(true);
    setError('');
    const res = await window.conn.rules.remove(project || null, { scope: r.scope, kind: r.kind, rule: r.rule }).catch(() => null);
    setBusy(false);
    if (!res?.ok) setError(res?.error || 'Could not remove that rule.');
    load();
  };

  const scopes = Object.keys(SCOPES).filter((s) => project || s === 'user');

  return (
    <div className="mb-9">
      <div className="flex items-center gap-2">
        <h3 className="flex-1 font-medium text-base">Saved permission rules</h3>
        <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" aria-label="Read the rules again" title="Read the rules again" onClick={load}>
          <RotateCwIcon className="size-3.5" />
        </Button>
      </div>
      <p className="mt-1.5 text-[13px] text-muted-foreground leading-relaxed">
        What <strong className="font-medium text-foreground">Always</strong> on a permission card saved for Claude, and any rules you wrote
        yourself{info.name ? <>, for <span className="text-foreground">{info.name}</span></> : ''}. Removing one means Claude asks again
        next time. Codex, Cursor, Grok, OpenCode and Copilot keep their own Always rules, which are not listed here.
      </p>
      {error && <p className="mt-2 text-destructive text-xs">{error}</p>}
      {state.errors.map((e) => <p key={e} className="mt-2 text-destructive text-xs">{e}</p>)}
      <div className="mt-3 flex flex-col gap-3">
        {scopes.map((scope) => {
          const rules = state.rules.filter((r) => r.scope === scope);
          return (
            <div key={scope} className="rounded-xl border bg-card px-4 py-2.5 shadow-xs">
              <div className="flex items-baseline gap-2">
                <span className="text-[13px] font-medium">{SCOPES[scope].label}</span>
                <span className="truncate font-mono text-[11px] text-muted-foreground">{SCOPES[scope].note}</span>
              </div>
              {rules.length ? (
                <ul className="mt-1 divide-y divide-border/60">
                  {rules.map((r) => <Rule key={`${r.kind}:${r.rule}`} r={r} busy={busy} onRemove={remove} />)}
                </ul>
              ) : (
                <p className="py-1.5 text-muted-foreground text-xs">{state.loading ? 'Reading…' : 'No rules.'}</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
