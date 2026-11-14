import { VIEW, MARK, NODE } from '../../../shared/conn-mark';

/* The prompt is currentColor, so the title bar and a button can tint it. The
   node is the site's orange (#ff5a1f), as on the app icon. It is filled and the
   prompt is a stroke, which is what keeps the two apart at 16px. */
export function ConnMark({ className }) {
  return (
    <svg viewBox={VIEW} className={className} aria-hidden="true">
      <path
        d={MARK}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.35"
        strokeLinecap="round"
        strokeLinejoin="round" />
      <circle cx={NODE.cx} cy={NODE.cy} r={NODE.r} fill="#ff5a1f" />
    </svg>
  );
}
