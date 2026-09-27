import { useEffect, useMemo, useRef, useState } from 'react';
import { BINDINGS, WHERE, chordError, conflictWith, defaultKeybindings, eventToAccel, formatChord, keyOf } from '@/lib/keys';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

// Recording has to win over the chord it is replacing, and over the native
// menu, which would otherwise run the old shortcut while the new one is
// being pressed. Escape steps back without saving. Binding Escape itself is
// a button, because the key is how you leave the recorder.
function useRecording(recording, onCommit, onCancel) {
  const commit = useRef(onCommit);
  const cancel = useRef(onCancel);
  commit.current = onCommit;
  cancel.current = onCancel;
  useEffect(() => {
    if (!recording) return undefined;
    window.conn.keys.capture(true);
    const onKey = (e) => {
      if (e.repeat) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        cancel.current();
        return;
      }
      const accel = eventToAccel(e);
      if (!accel) return;
      commit.current(recording.id, accel);
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.conn.keys.capture(false);
    };
  }, [recording]);
}

export function KeyboardPage({ settings, set }) {
  const overrides = settings?.keybindings;
  const [query, setQuery] = useState('');
  const [recording, setRecording] = useState(null);
  const [notice, setNotice] = useState(null);

  const cancel = () => { setRecording(null); setNotice(null); };

  const commit = (id, accel) => {
    const row = BINDINGS.find((b) => b.id === id);
    if (!row) return;
    if (accel) {
      const why = chordError(accel, row.scope);
      if (why) { setNotice({ id, text: why }); return; }
      const other = conflictWith(overrides, id, accel);
      if (other) { setNotice({ id, text: `Already used by ${other.label}.` }); return; }
    }
    setNotice(null);
    setRecording(null);
    if (keyOf(overrides, id) === accel) return;
    set({ keybindings: { [id]: accel } });
  };

  useRecording(recording, commit, cancel);

  const q = query.trim().toLowerCase();
  const groups = useMemo(() => {
    const shown = BINDINGS.filter((row) => {
      if (!q) return true;
      const chord = formatChord(keyOf(overrides, row.id)).toLowerCase();
      return row.label.toLowerCase().includes(q)
        || row.category.toLowerCase().includes(q)
        || chord.includes(q);
    });
    const out = [];
    for (const row of shown) {
      const last = out[out.length - 1];
      if (!last || last.name !== row.category) out.push({ name: row.category, rows: [row] });
      else last.rows.push(row);
    }
    return out;
  }, [q, overrides]);

  const changed = BINDINGS.some((row) => keyOf(overrides, row.id) !== row.keys);

  return (
    <div className="mb-9">
      <h3 className="font-medium text-base">Keyboard</h3>
      <p className="mt-1.5 text-[13px] text-muted-foreground leading-relaxed">
        Every command the window can run from the keyboard. Click a shortcut and press the new
        keys. Escape cancels. The same chord cannot be used twice.
      </p>

      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={cancel}
        placeholder="Search shortcuts"
        className="mt-4 h-8 max-w-sm text-[13px]" />

      {groups.map((group) => (
        <div key={group.name} className="mt-6">
          <h4 className="mb-1 font-medium text-[13px] text-muted-foreground">{group.name}</h4>
          <div className="divide-y divide-border/60">
            {group.rows.map((row) => {
              const keys = keyOf(overrides, row.id);
              const custom = keys !== row.keys;
              const armed = recording?.id === row.id;
              return (
                <div key={row.id} className="flex items-center gap-4 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px]">{row.label}</div>
                    <div className="text-[12px] text-muted-foreground">{WHERE[row.scope]}</div>
                    {notice?.id === row.id && (
                      <div className="text-[12px] text-destructive">{notice.text}</div>
                    )}
                  </div>
                  {armed && (
                    <Button type="button" variant="ghost" size="xs" onClick={() => commit(row.id, '')}>
                      Clear
                    </Button>
                  )}
                  {armed && row.scope === 'composer' && (
                    <Button type="button" variant="ghost" size="xs" onClick={() => commit(row.id, 'Escape')}>
                      Use Escape
                    </Button>
                  )}
                  {custom && !armed && (
                    <Button type="button" variant="ghost" size="xs" onClick={() => commit(row.id, row.keys)}>
                      Reset
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant={armed ? 'default' : 'outline'}
                    size="sm"
                    className="min-w-28 justify-center font-mono text-[12px] font-normal"
                    onClick={() => {
                      if (armed) cancel();
                      else { setNotice(null); setRecording(row); }
                    }}>
                    {armed ? 'Press keys…' : (formatChord(keys) || 'None')}
                  </Button>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {!groups.length && (
        <p className="mt-6 text-[13px] text-muted-foreground">No shortcuts match.</p>
      )}

      <div className="mt-8 flex items-center gap-4 border-t border-border/60 pt-4">
        <div className="min-w-0 flex-1">
          <div className="text-[13px]">Reset shortcuts</div>
          <div className="text-[12px] text-muted-foreground">Puts every shortcut on this page back. Nothing else in settings changes.</div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!changed}
          onClick={() => { cancel(); set({ keybindings: defaultKeybindings() }); }}>
          Reset
        </Button>
      </div>
    </div>
  );
}
