/* Toasts.

   The call shape is the one the rest of the shell already uses:

     toast('Local server detected', url, [
       { label: 'Open', primary: true, run },
       { label: 'Always', run },
       { label: 'Ignore' },
     ])

   sonner draws one action and one cancel, which covers most of these. Anything
   with more choices than that is rendered whole, because dropping a button
   would drop a decision somebody has to make. */
import { toast as sonner } from 'sonner';
import { Button } from '@/components/ui/button';

// Every toast is the top-right one. A caller passing a corner is ignored.
const PLACE = { position: 'top-right' };

// The title is the only hint most call sites give about what kind of news this
// is, and a check or a cross is what makes two stacked toasts distinguishable.
function say(title) {
  const t = String(title || '');
  if (/^could not\b/i.test(t)) return sonner.error;
  if (/^(opened|copied|saved|screenshot)\b/i.test(t)) return sonner.success;
  return sonner.info;
}

// An action with nothing to run is an acknowledgement, which is what a toast
// does by itself when it times out.
const isDismiss = (a) => !a.run;

function Card({ id, title, description, actions }) {
  return (
    <div className="flex w-[320px] flex-col gap-1.5 rounded-[10px] border bg-popover px-3.5 py-3 pr-7 text-[13px] text-popover-foreground shadow-[0_8px_24px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.04)]">
      <div className="font-semibold leading-tight">{title}</div>
      {description && (
        <div dir="rtl" title={description} className="truncate text-[12px] text-muted-foreground [unicode-bidi:plaintext]">
          {description}
        </div>
      )}
      <div className="mt-1.5 flex justify-end gap-1.5">
        {actions.map((a) => (
          <Button
            key={a.label}
            size="sm"
            variant={a.primary ? 'default' : 'ghost'}
            onClick={() => { sonner.dismiss(id); a.run?.(); }}>
            {a.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

// `options` goes to sonner as is. Its onDismiss is widened to every way out,
// because sonner leaves its own action and cancel buttons out of it.
export function toast(title, description, actions = [], options = {}) {
  const real = actions.filter((a) => !isDismiss(a));
  const { position: _corner, ...rest } = options;
  const gone = () => options.onDismiss?.();
  const show = say(title);

  if (real.length === 0) return show(title, { description, ...rest, ...PLACE });

  if (real.length === 1) {
    const [only] = real;
    const cancel = actions.find(isDismiss);
    return show(title, {
      description,
      ...rest,
      ...PLACE,
      action: { label: only.label, onClick: () => { only.run(); gone(); } },
      ...(cancel ? { cancel: { label: cancel.label, onClick: gone } } : {}),
    });
  }

  return sonner.custom(
    (id) => <Card id={id} title={title} description={description} actions={actions} />,
    { duration: 15000, ...rest, ...PLACE },
  );
}
