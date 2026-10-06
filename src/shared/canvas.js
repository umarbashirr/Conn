'use strict';
// Where the design canvas keeps its frames, one JSON file each. Every chat
// draws on a board of its own, a folder under .conn/canvas/ named by an id the
// chat carries for life. The agent writes the files, the board reads them, and
// main patches a frame's position when the person drags it, so all three build
// the folder with boardDir and can never disagree about it.
const CANVAS_DIR = '.conn/canvas';

// Short and lower case, so it is safe as a folder name and easy for an agent
// to copy out of a brief.
const CANVAS_ID = /^[a-z0-9]{6,32}$/;

// 36^8 ids is plenty for the boards one folder will ever hold.
const newCanvasId = () => Math.random().toString(36).slice(2, 10).padEnd(8, '0');

// Relative to the folder the chat runs in.
const boardDir = (id) => `${CANVAS_DIR}/${id}`;

module.exports = { CANVAS_DIR, CANVAS_ID, newCanvasId, boardDir };
