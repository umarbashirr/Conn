import { useEffect, useState } from 'react';
import { CheckIcon, SquareTerminalIcon } from 'lucide-react';

import { runCommand } from '../../app.js';
import { ChatLink } from '@/components/chat-link';
import { CopyButton } from '@/components/copy-button';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function ShellBlock({ code, language, isIncomplete }) {
  const [sent, setSent] = useState(false);

  useEffect(() => {
    if (!sent) return undefined;
    const t = setTimeout(() => setSent(false), 1500);
    return () => clearTimeout(t);
  }, [sent]);

  const text = code.replace(/\n$/, '');
  const runnable = language !== 'console';

  const run = () => {
    runCommand('runInTerminal', text);
    runCommand('terminal', true);
    setSent(true);
  };

  return (
    <div data-slot="shell-block" data-language={language} className="relative my-3 rounded-md border bg-muted/40">
      <pre className={cn('wrap-anywhere whitespace-pre-wrap p-2.5 font-mono text-[12px] leading-relaxed', runnable ? 'pr-24' : 'pr-10')}>
        {text}
      </pre>
      <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5">
        {runnable && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label="Run in terminal"
            title="Run in a new terminal tab"
            disabled={isIncomplete}
            onClick={run}
            className="h-6 text-[11px] text-muted-foreground">
            {sent ? <CheckIcon /> : <SquareTerminalIcon />}
            {sent ? 'Sent' : 'Run'}
          </Button>
        )}
        <CopyButton text={text} label="Copy" />
      </div>
    </div>
  );
}

export const SHELL_RENDERER = { language: ['bash', 'sh', 'shell', 'zsh', 'console'], component: ShellBlock };

const URL_ONLY = /^https?:\/\/\S+$/;

export function InlineCode({ node: _node, className, children, ...rest }) {
  if (typeof children === 'string' && URL_ONLY.test(children)) {
    return (
      <ChatLink
        href={children}
        className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm font-normal decoration-dotted underline-offset-2 hover:decoration-solid">
        {children}
      </ChatLink>
    );
  }
  return (
    <code className={cn('rounded bg-muted px-1.5 py-0.5 font-mono text-sm', className)} data-streamdown="inline-code" {...rest}>
      {children}
    </code>
  );
}
