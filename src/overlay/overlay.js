'use strict';
// Laid over a preview while an agent drives it. Everything the person does to
// the page lands here instead, so a scroll or a click cannot move the page out
// from under the agent; Take control is how they get the page back on purpose.
//
// Once the page is theirs the view shrinks to the pill at the bottom of the
// page, so the page takes every click again and the pill hands it back.
const bar = document.getElementById('bar');
const who = document.getElementById('who');
const take = document.getElementById('take');
const give = document.getElementById('give');

take.addEventListener('click', () => window.connOverlay.take());
give.addEventListener('click', () => window.connOverlay.handBack());

window.connOverlay.onState(({ caption, mode }) => {
  const human = mode === 'human';
  document.body.dataset.mode = human ? 'human' : 'agent';
  who.textContent = human ? 'You have control' : caption;
  take.hidden = human;
  give.hidden = !human;
});

// A scroll or click that went nowhere shows the pill and points at it.
let hideAt = 0;
const nudge = () => {
  if (document.body.dataset.mode !== 'agent') return;
  bar.classList.add('shown');
  clearTimeout(hideAt);
  hideAt = setTimeout(() => bar.classList.remove('shown'), 2500);
  bar.classList.remove('nudge');
  void bar.offsetWidth;
  bar.classList.add('nudge');
};
document.addEventListener('wheel', (e) => { e.preventDefault(); nudge(); }, { passive: false });
document.addEventListener('mousedown', (e) => { if (!e.target.closest('button')) { e.preventDefault(); nudge(); } });
