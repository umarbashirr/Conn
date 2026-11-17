/* Where the composer goes when the chat is not on screen. At full width the
   chat collapses to nothing, so the shell puts a strip under the right column
   and hands it down here, and the chat portals its one composer into it. Null
   means the composer stays in the chat. */
import { createContext } from 'react';

export const ComposerDock = createContext(null);
