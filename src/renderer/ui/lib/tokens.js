// Four things in a prompt are not prose: the skill it starts with, a file it
// points at, a part of Conn it names with a $, and whatever was clipped to it.
// Splitting them out of the string happens here and nowhere else, so the
// composer and the transcript can never disagree about what counts as a token.
//
// A string goes in and a string comes back out unchanged. That round trip is
// the whole contract: everything upstream — the per-chat drafts, the queue,
// the text a stopped turn parks back in the box — still passes plain text.
import { ATTACHED, HEAD_KIND, attachedLabel, basename } from '../../../shared/attachments.js';
import { MENTIONS } from './conn-mentions.js';

// Only at the very start, which is how the CLI reads a slash command too.
const SKILL = /^\/([a-zA-Z0-9][\w:.-]*)/;

// Preceded by a space or an opening bracket, so an email address in the middle
// of a sentence is left alone. For a path the last character cannot be
// punctuation, or "look at @src/app.js." would swallow the full stop. A $
// names only a row of MENTIONS, whole, so $5, $HOME and $browserUrl stay text.
// A skill mid-sentence is a slash and a name after a space, and the name may
// not run on into another slash or end on a full stop, so /usr/bin and
// "see /tmp/x." stay text.
// A path may not run straight on into an @, another word or a slash, so an
// npm package such as @posthog/wizard@latest stays text rather than becoming
// two file badges. A full stop only ends one when a word does not follow it.
const INLINE = new RegExp(`(^|[\\s([])(?:@([\\w.\\-/]*[\\w\\-/])(?![@\\w/-]|\\.\\w)|\\$(${Object.keys(MENTIONS).join('|')})(?![\\w-])|\\/([a-zA-Z0-9](?:[\\w:.-]*\\w)?)(?![\\w/@-]|[:.]\\w))`, 'g');

const mention = (name) => ({ type: 'token', kind: 'conn', raw: `$${name}`, label: MENTIONS[name].label, title: MENTIONS[name].note, icon: name });

export function parse(input) {
  const nodes = [];
  let rest = String(input ?? '');
  const text = (t) => { if (t) nodes.push({ type: 'text', text: t }); };

  // Attachments are always the head of the message, one block each.
  for (let m; (m = ATTACHED.exec(rest));) {
    const kind = HEAD_KIND[m[1]];
    nodes.push({
      type: 'token',
      kind,
      icon: kind === 'element' ? undefined : m[1].split(' ')[1],
      raw: m[0],
      label: attachedLabel(m[1], m[2], m[3]),
      title: m[0].trim(),
      // What the person wrote against it. Often the whole point of the
      // message, so it is drawn beside the badge rather than hidden in it.
      note: /\n {2}note: ([^\n]+)/.exec(m[3])?.[1],
    });
    rest = rest.slice(m[0].length);
  }

  const skill = SKILL.exec(rest);
  if (skill) {
    nodes.push({ type: 'token', kind: 'skill', raw: skill[0], label: skill[1], title: `the ${skill[1]} skill` });
    rest = rest.slice(skill[0].length);
  }

  // One pass over the whole rest, never re-matching a slice: a slice starts a
  // fresh ^, which let a word glued to a badge (wizard@latest) pass for one
  // that follows a space.
  let from = 0;
  INLINE.lastIndex = 0;
  for (let m; (m = INLINE.exec(rest));) {
    const at = m.index + m[1].length;
    text(rest.slice(from, at));
    const node = m[2] !== undefined
      ? { type: 'token', kind: 'path', raw: `@${m[2]}`, label: basename(m[2]), title: m[2] }
      : m[4] !== undefined
        ? { type: 'token', kind: 'skill', raw: `/${m[4]}`, label: m[4], title: `the ${m[4]} skill` }
        : mention(m[3]);
    nodes.push(node);
    from = at + node.raw.length;
    INLINE.lastIndex = from;
  }

  text(rest.slice(from));
  return nodes;
}

export const serialize = (nodes) =>
  nodes.map((n) => (n.type === 'text' ? n.text : n.raw)).join('');

// A token built from a pick rather than found in a string. The label is what
// the badge shows; raw is what the agent receives, which for a file is the
// path in full however little of it is on screen.
export function tokenFor(kind, raw) {
  const [node] = parse(raw).filter((n) => n.type === 'token' && n.kind === kind);
  return node || { type: 'token', kind, raw, label: raw, title: raw };
}

// What is being typed at the caret, if it is the start of a token. `before` is
// the run of loose text to the left of the caret, never a finished token: a
// caret parked after an @path badge is sitting next to something already
// decided, not halfway through typing it.
//
// A slash counts anywhere after a space too, and as often as you like: a
// skill stays where it was typed, and a second one is offered beside the
// first. The agent reads them in place.
export function pendingToken(before, atStart) {
  const head = /^\/([\w:.-]*)$/.exec(before);
  if (head && atStart) return { kind: 'skill', query: head[1], length: head[0].length, head: true };
  const mid = /[\s([]\/([\w:.-]*)$/.exec(before);
  if (mid) return { kind: 'skill', query: mid[1], length: mid[1].length + 1, head: false };

  const at = /(?:^|[\s([])@([\w.\-/]*)$/.exec(before);
  if (at) return { kind: 'path', query: at[1], length: at[1].length + 1 };

  const dollar = /(?:^|[\s([])\$([a-z]*)$/.exec(before);
  if (dollar) return { kind: 'conn', query: dollar[1], length: dollar[1].length + 1 };

  return null;
}

// The parts of Conn a message names, typed by hand or picked.
export const mentionsIn = (text) => new Set(parse(text).filter((n) => n.kind === 'conn').map((n) => n.raw.slice(1)));
