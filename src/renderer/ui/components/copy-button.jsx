import { useEffect, useState } from 'react';
import { CheckIcon, CopyIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function CopyButton({ text, label, className }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const name = copied ? 'Copied' : label;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={name}
      title={name}
      data-copied={copied || undefined}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        navigator.clipboard?.writeText(text);
        setCopied(true);
      }}
      className={cn('select-none text-muted-foreground', className)}>
      {copied
        ? <CheckIcon className="size-3.5 animate-in fade-in-0 zoom-in-50 duration-200" />
        : <CopyIcon className="size-3.5" />}
    </Button>
  );
}
