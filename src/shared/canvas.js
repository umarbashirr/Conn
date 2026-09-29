'use strict';
// Where the design canvas keeps its frames, one JSON file each. The agent
// writes them, the board reads them, and main patches a frame's position when
// the person drags it, so all three have to agree on the folder.
const CANVAS_DIR = '.conn/canvas';

module.exports = { CANVAS_DIR };
