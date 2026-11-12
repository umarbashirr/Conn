(() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reduced) document.documentElement.classList.add('motion');

  const header = document.querySelector('.site-header');
  const onScroll = () => header.toggleAttribute('data-scrolled', scrollY > 8);
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  const STEPS = [
    { at: 0, phase: 'change' },
    { at: 900, phase: 'change' },
    { at: 2000, phase: 'change' },
    { at: 3000, phase: 'change' },
    { at: 3900, phase: 'change', add: ['fixed'] },
    { at: 5000, phase: 'look', pulse: 'loading' },
    { at: 6300, phase: 'verify', add: ['clicking', 'picked'] },
    { at: 7500, phase: 'verify', pulse: 'shot' },
    { at: 8600, phase: 'done' },
  ];
  const LOOP_MS = 13500;
  const FLAGS = ['fixed', 'clicking', 'picked', 'pressed', 'loading', 'shot'];

  const demo = document.querySelector('[data-demo]');
  if (demo && !reduced) {
    const items = [...demo.querySelectorAll('[data-at]')];
    const toggle = demo.querySelector('[data-demo-toggle]');
    const label = demo.querySelector('[data-demo-label]');
    let timers = [];
    let paused = false;
    let visible = true;

    const clear = () => {
      for (const id of timers) clearTimeout(id);
      timers = [];
    };

    const pulse = (name, ms) => {
      demo.classList.add(name);
      timers.push(setTimeout(() => demo.classList.remove(name), ms));
    };

    const show = (index) => {
      const step = STEPS[index];
      demo.dataset.phase = step.phase;
      for (const el of items) el.classList.toggle('on', Number(el.dataset.at) <= index);
      for (const name of step.add ?? []) demo.classList.add(name);
      if (step.pulse) pulse(step.pulse, step.pulse === 'shot' ? 500 : 450);
      if (index === 6) timers.push(setTimeout(() => pulse('pressed', 160), 950));
    };

    const run = () => {
      clear();
      demo.classList.add('playing');
      demo.classList.remove(...FLAGS);
      STEPS.forEach((step, i) => timers.push(setTimeout(show, step.at, i)));
      timers.push(setTimeout(run, LOOP_MS));
    };

    const finish = () => {
      clear();
      demo.classList.remove('playing', ...FLAGS);
      demo.dataset.phase = 'done';
      for (const el of items) el.classList.add('on');
    };

    const sync = () => {
      const shouldRun = !paused && visible && !document.hidden;
      if (shouldRun && !demo.classList.contains('playing')) run();
      if (!shouldRun && demo.classList.contains('playing')) finish();
    };

    toggle.hidden = false;
    toggle.setAttribute('aria-pressed', 'false');
    toggle.addEventListener('click', () => {
      paused = !paused;
      toggle.setAttribute('aria-pressed', String(paused));
      label.textContent = paused ? 'Play' : 'Pause';
      sync();
    });

    new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      sync();
    }, { threshold: 0.15 }).observe(demo);
    document.addEventListener('visibilitychange', sync);
  }

  const tabs = [...document.querySelectorAll('[data-modes] [role="tab"]')];
  const select = (tab) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
    }
  };
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', (event) => {
      const moves = { ArrowRight: 1, ArrowLeft: -1, Home: -i, End: tabs.length - 1 - i };
      if (!(event.key in moves)) return;
      event.preventDefault();
      const next = tabs[(i + moves[event.key] + tabs.length) % tabs.length];
      select(next);
      next.focus();
    });
  });

  document.querySelectorAll('[data-type] .tl').forEach((line, i) => line.style.setProperty('--i', i));

  if (!reduced) {
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('in');
        io.unobserve(entry.target);
      }
    }, { threshold: 0.25, rootMargin: '0px 0px -40px 0px' });
    document.querySelectorAll('.reveal').forEach((el) => io.observe(el));
  }
})();
