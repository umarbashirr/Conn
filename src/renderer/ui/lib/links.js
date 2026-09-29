// A link in Conn opens in Conn's own browser, beside the chat. The modifier
// click is the way out to the system browser, and mail is never a page, so it
// always goes out.
import { navigate } from '../shell/browser-store.js';

const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = MAC ? 'Cmd' : 'Ctrl';

// A middle click is the other way every browser opens a link somewhere else.
export const wantsExternal = (e) => e.button === 1 || (MAC ? e.metaKey : e.ctrlKey);

export function linkTarget(href, external) {
  const protocol = URL.canParse(href) ? new URL(href).protocol : '';
  if (protocol === 'mailto:') return 'external';
  if (protocol === 'http:' || protocol === 'https:') return external ? 'external' : 'browser';
  return null;
}

export function linkHint(href) {
  const target = linkTarget(href, false);
  switch (target) {
    case 'browser': return `Open in Conn browser · ${MOD}+click to open externally`;
    case 'external': return 'Open in your mail app';
    case null: return undefined;
    default: throw new Error(`unhandled link target ${target}`);
  }
}

export function openLink(href, external) {
  const target = linkTarget(href, external);
  switch (target) {
    case 'browser': return navigate(href);
    case 'external': return window.conn.links.openExternal(href);
    case null: return undefined;
    default: throw new Error(`unhandled link target ${target}`);
  }
}
