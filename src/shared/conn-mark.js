/* The mark. A prompt that runs into a node: the shell, then the thing it is
   connected to. The title bar, the app icon and the site all draw this. */
'use strict';

const VIEW = '0 0 24 24';
/* A prompt aimed at a node. No stem: a line out of the point turns the mark into a Y. */
const MARK = 'M3.6 5.2 12.1 12 3.6 18.8';
const NODE = { cx: 19.05, cy: 12, r: 2.7 };

module.exports = { VIEW, MARK, NODE };
