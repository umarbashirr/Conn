/* Where a menu, popover or dialog portals to. Unset is this document's body.
   The composer floating over a full-width page lives in a window of its own,
   and sets this to that window's body so its menus open beside it. */
import { createContext } from 'react';

export const PortalHost = createContext(undefined);
