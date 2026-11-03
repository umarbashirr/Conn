// Where the transcript's "bottom" is. `following` is the end of the transcript.
// `pinned` is the user message that started the current turn, held near the top
// of the view while its reply still fits below it. Whether the reader has
// scrolled away (free) stays use-stick-to-bottom's escape state, so a reader who
// scrolls up while pinned is free, and the scroll button brings them back to the
// pin.
//
// Geometry is in scroll-content pixels: `anchorTop` is the message's offset in
// the transcript, `natural` the transcript's height without any room added
// below it, `viewport` the scroller's visible height.

export const PEEK = 48;

export const following = { kind: 'following' };
export const pinned = (id) => ({ kind: 'pinned', id });

export const pinTop = (anchorTop) => Math.max(0, anchorTop - PEEK);

// The empty space the transcript needs below its end for the scroll's end to put
// the message at its pin. Negative once the turn is taller than the view.
export const room = ({ anchorTop, natural, viewport }) => pinTop(anchorTop) + viewport - natural;

export function settle(mode, geo) {
  if (mode.kind !== 'pinned') return mode;
  return geo && room(geo) >= 0 ? mode : following;
}

// Opening a chat. A last turn that fits is pinned the way a fresh send is. A
// longer one lands with its message at the pin too, but free, so the reply
// below waits for the reader instead of the view jumping to its end.
export function land(id, geo) {
  if (!geo) return { mode: following, free: false };
  return room(geo) >= 0 ? { mode: pinned(id), free: false } : { mode: following, free: true };
}
