'use strict';
// Laid over a preview while an agent drives it. Everything the person does to
// the page lands here instead, so a scroll or a click cannot move the page out
// from under the agent; the button is how they get the page back on purpose.
const bar = document.getElementById('bar');
const who = document.getElementById('who');

document.getElementById('take').addEventListener('click', () => window.connOverlay.take());

window.connOverlay.onState(({ caption }) => { who.textContent = caption; });

// A scroll or click that went nowhere points at the one thing here that works.
const nudge = () => {
  bar.classList.remove('nudge');
  void bar.offsetWidth;
  bar.classList.add('nudge');
};
document.addEventListener('wheel', (e) => { e.preventDefault(); nudge(); }, { passive: false });
document.addEventListener('mousedown', (e) => { if (!e.target.closest('button')) { e.preventDefault(); nudge(); } });
