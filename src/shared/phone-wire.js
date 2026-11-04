'use strict';
// What one phone link frame may carry. The gate enforces these and the phone
// shapes its frames to fit them, so the two ends cannot drift.

const MAX_FRAME_BYTES = 1_000_000; // the gate's maxPayload; a larger frame closes the socket
const MAX_PHOTOS = 4;
const PHOTO_MEDIA = Object.freeze(['image/jpeg', 'image/png']);

module.exports = { MAX_FRAME_BYTES, MAX_PHOTOS, PHOTO_MEDIA };
