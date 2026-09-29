import { CopyButton } from '@/components/copy-button';
import { linkHint, openLink, wantsExternal } from '@/lib/links';
import { cn } from '@/lib/utils';

// Streamdown's own link asks in a dialog where to go. Here a click decides:
// plain opens the Browser pane, the modifier opens the system browser.
export function ChatLink({ href, children, className, node: _node, ...rest }) {
  const open = (e, external) => {
    e.preventDefault();
    if (href) openLink(href, external);
  };
  return (
    <span className="group/link">
      <a
        {...rest}
        href={href}
        title={href ? linkHint(href) : undefined}
        className={cn('wrap-anywhere font-medium text-primary underline', className)}
        onClick={(e) => open(e, wantsExternal(e))}
        onAuxClick={(e) => { if (e.button === 1) open(e, true); }}>
        {children}
      </a>
      {href && (
        <CopyButton
          text={href}
          label="Copy link"
          className="ml-0.5 size-5 align-text-bottom opacity-0 group-hover/link:opacity-100 focus-visible:opacity-100 data-[copied]:opacity-100" />
      )}
    </span>
  );
}
