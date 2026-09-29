import { cn } from '@/lib/utils';

// The icons live here as raw path data rather than as lucide-react components,
// because the composer has to stamp the same badge as a plain DOM node and
// React is not involved in that half. One definition, two renderers, no chance
// of a skill looking like one thing in the box and another in the transcript.
const ICON = {
  skill: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
  path: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v6h6"/>',
  element: '<circle cx="12" cy="12" r="8"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3"/>',
  browser: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15 15 0 0 1 0 20a15 15 0 0 1 0-20"/>',
  canvas: '<circle cx="13.5" cy="6.5" r="1"/><circle cx="17.5" cy="10.5" r="1"/><circle cx="8.5" cy="7.5" r="1"/><circle cx="6.5" cy="12.5" r="1"/><path d="M12 2a10 10 0 0 0 0 20c1 0 1.6-.8 1.6-1.7 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1a1.6 1.6 0 0 1 1.6-1.7h2A5.6 5.6 0 0 0 22 11c0-5-4.5-9-10-9z"/>',
};

const iconOf = (token) => ICON[token.icon] || ICON[token.kind] || '';

const SVG_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
  + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

export const tokenClass = (kind) => `conn-token tok-${kind}`;

const escape = (s) => String(s).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
));

// The composer's copy. contenteditable="false" is what makes it one atom: the
// caret cannot land inside it and one backspace takes the whole thing.
export function tokenElement(doc, token) {
  const el = doc.createElement('span');
  el.className = tokenClass(token.kind);
  el.contentEditable = 'false';
  el.dataset.raw = token.raw;
  el.dataset.kind = token.kind;
  el.title = token.title || token.raw;
  el.innerHTML = `<svg ${SVG_ATTRS}>${iconOf(token)}</svg><span>${escape(token.label)}</span>`;
  return el;
}

export function TokenBadge({ kind, icon, label, title, className }) {
  return (
    <span className={cn(tokenClass(kind), className)} title={title}>
      {/* the same path data the composer stamps, so the two cannot drift */}
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: iconOf({ kind, icon }) }} />
      <span>{label}</span>
    </span>
  );
}
