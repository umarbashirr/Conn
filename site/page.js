(() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const gsap = window.gsap;
  const ScrollTrigger = window.ScrollTrigger;
  const animated = !reduced && gsap && ScrollTrigger;
  const root = document.documentElement;
  if (!reduced) root.classList.add('motion');
  if (animated) {
    root.classList.add('gsap');
    gsap.registerPlugin(ScrollTrigger);
  }

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  const header = $('.site-header');
  const onScroll = () => header.toggleAttribute('data-scrolled', scrollY > 8);
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ---------- hero demo: one GSAP timeline ---------- */
  const demo = $('[data-demo]');
  if (demo && animated) {
    const q = (s) => $(s, demo);
    const d = (name) => q(`[data-d="${name}"]`);
    const typed = q('[data-typed]');
    const ph = q('[data-ph]');
    const page = q('.page');
    const btn = q('[data-su-button]');
    const cursor = q('[data-cursor]');
    const size = q('[data-size]');
    const browseN = q('[data-browse-n]');
    const browseT = q('[data-browse-t]');
    const PROMPT = 'The Create account button is shorter than the email field. Fix it and check it in the browser.';
    const rows = $$('[data-d]', demo).filter((el) => el.dataset.d !== 'hmr');
    const flags = ['playing', 'typing', 'can-send', 'has-web', 'show-web'];
    const flag = (name, on) => () => demo.classList.toggle(name, on);
    const phase = (p) => () => { demo.dataset.phase = p; };
    const pop = { autoAlpha: 1, y: 0, duration: 0.45, ease: 'power3.out' };

    const tl = gsap.timeline({ paused: true, repeat: -1, repeatDelay: 2.5 });
    tl.call(() => {
      demo.classList.remove(...flags);
      demo.classList.add('playing');
      demo.dataset.phase = 'change';
      typed.textContent = '';
      ph.style.display = '';
      browseN.textContent = '1 time';
      browseT.textContent = '0:01';
      size.textContent = '264×39';
    })
      .set(rows, { autoAlpha: 0, y: 8 })
      .set([d('hmr'), '[data-toast]', '[data-agent-chip]', '[data-pick-box]', '[data-size]', cursor, '[data-flash]'], { autoAlpha: 0 })
      .set(btn, { height: 34, scale: 1 })
      .set('[data-load]', { scaleX: 0, autoAlpha: 1 })
      .set('[data-thread]', { y: 0 })

      // 1. type the prompt and send it
      .call(flag('typing', true), [], 0.4)
      .call(() => { ph.style.display = 'none'; }, [], 0.4)
      .to({ n: 0 }, {
        n: PROMPT.length, duration: 2.2, ease: 'none',
        onUpdate() { typed.textContent = PROMPT.slice(0, Math.round(this.targets()[0].n)); demo.classList.toggle('can-send', true); },
      }, 0.4)
      .to('[data-send]', { scale: 0.85, duration: 0.1, yoyo: true, repeat: 1 }, '+=0.25')
      .call(() => { typed.textContent = ''; ph.style.display = ''; demo.classList.remove('typing', 'can-send'); })
      .to(d('user'), pop)
      .to(d('working'), pop, '<0.2')

      // 2. think, explain, read, edit
      .to(d('think'), pop, '+=0.5')
      .to(d('say1'), pop, '+=0.4')
      .to(d('read'), pop, '+=0.5')
      .to(d('edit'), pop, '+=0.5')
      .to(d('hmr'), { autoAlpha: 1, duration: 0.3 }, '+=0.3')

      // 3. Conn spots the dev server and offers to open it
      .call(phase('look'), [], '+=0.4')
      .fromTo('[data-toast]', { autoAlpha: 0, y: -10, scale: 0.97 }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.4, ease: 'back.out(1.6)' })
      .to('[data-toast-open]', { scale: 0.92, duration: 0.1, yoyo: true, repeat: 1 }, '+=0.6')
      .to('[data-toast]', { autoAlpha: 0, y: -6, duration: 0.2 })
      .call(flag('has-web', true))
      .call(flag('show-web', true))
      .to(d('browse'), pop, '<')
      .to('[data-agent-chip]', { autoAlpha: 1, duration: 0.3 }, '<')
      .to('[data-load]', { scaleX: 1, duration: 0.6, ease: 'power2.inOut' }, '<')
      .to('[data-load]', { autoAlpha: 0, duration: 0.2 })

      // 4. click the button and check it
      .call(phase('verify'), [], '+=0.2')
      .add(() => {
        const p = page.getBoundingClientRect();
        const b = btn.getBoundingClientRect();
        const scale = p.width / page.offsetWidth || 1;
        gsap.fromTo(cursor,
          { x: page.offsetWidth * 0.82, y: page.offsetHeight * 0.92, autoAlpha: 0 },
          { x: (b.left - p.left) / scale + btn.offsetWidth * 0.6, y: (b.top - p.top) / scale + btn.offsetHeight * 0.55, autoAlpha: 1, duration: 0.9, ease: 'power3.inOut' });
      })
      .call(() => { browseN.textContent = '2 times'; browseT.textContent = '0:02'; }, [], '+=0.95')
      .to(btn, { scale: 0.97, duration: 0.08, yoyo: true, repeat: 1 })
      .to('[data-pick-box]', { autoAlpha: 1, duration: 0.25 })
      .to('[data-size]', { autoAlpha: 1, duration: 0.25 }, '<')
      .to(btn, { height: 40, duration: 0.6, ease: 'expo.out' }, '+=0.3')
      .call(() => { size.textContent = '264×44'; }, [], '<0.15')
      .call(() => { browseN.textContent = '3 times'; browseT.textContent = '0:03'; }, [], '+=0.4')
      .fromTo('[data-flash]', { autoAlpha: 0.85 }, { autoAlpha: 0, duration: 0.5, ease: 'power2.out' })
      .to(d('shot'), pop, '<')
      .to(cursor, { autoAlpha: 0, duration: 0.3 }, '+=0.3')
      .to('[data-agent-chip]', { autoAlpha: 0, duration: 0.3 }, '<')
      .to(d('working'), { autoAlpha: 0, duration: 0.2 })
      .to(d('say2'), pop)
      .call(phase('done'));

    const toggle = q('[data-demo-toggle]');
    const label = q('[data-demo-label]');
    let paused = false;
    let visible = false;
    const sync = () => {
      const run = !paused && visible && !document.hidden;
      if (run) tl.play(); else tl.pause();
    };
    toggle.hidden = false;
    toggle.setAttribute('aria-pressed', 'false');
    toggle.addEventListener('click', () => {
      paused = !paused;
      toggle.setAttribute('aria-pressed', String(paused));
      label.textContent = paused ? 'Play' : 'Pause';
      sync();
    });
    ScrollTrigger.create({ trigger: demo, start: 'top 90%', end: 'bottom top', onToggle: (s) => { visible = s.isActive; sync(); } });
    document.addEventListener('visibilitychange', sync);
  }

  /* ---------- permission mode tabs ---------- */
  const tabs = $$('[data-modes] [role="tab"]');
  const thumb = $('[data-mode-thumb]');
  const moveThumb = (i, instant) => {
    if (!thumb) return;
    if (animated && !instant) gsap.to(thumb, { xPercent: i * 100, duration: 0.45, ease: 'expo.out' });
    else if (animated) gsap.set(thumb, { xPercent: i * 100 });
    else thumb.style.transform = `translateX(${i * 100}%)`;
  };
  const select = (tab) => {
    tabs.forEach((t, i) => {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      const panel = document.getElementById(t.getAttribute('aria-controls'));
      panel.hidden = !on;
      if (on) {
        moveThumb(i);
        if (animated) gsap.from(panel.children, { y: 10, autoAlpha: 0, duration: 0.4, stagger: 0.06, ease: 'power2.out' });
      }
    });
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
  moveThumb(Math.max(0, tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true')), true);

  /* ---------- card spotlight (works without GSAP) ---------- */
  for (const card of $$('.card')) {
    card.addEventListener('pointermove', (e) => {
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${e.clientX - r.left}px`);
      card.style.setProperty('--my', `${e.clientY - r.top}px`);
    });
  }

  if (!animated) return;

  /* ---------- hero entrance ---------- */
  const title = $('[data-hero-title]');
  const splitWords = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) {
        const frag = document.createDocumentFragment();
        for (const part of child.textContent.split(/(\s+)/)) {
          if (!part) continue;
          if (/^\s+$/.test(part)) frag.append(part);
          else {
            const w = document.createElement('span');
            w.className = 'word';
            w.textContent = part;
            frag.append(w);
          }
        }
        child.replaceWith(frag);
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        splitWords(child);
      }
    }
  };
  title.setAttribute('aria-label', title.textContent);
  splitWords(title);
  $$('.word', title).forEach((w) => w.setAttribute('aria-hidden', 'true'));

  const intro = gsap.timeline({ defaults: { ease: 'expo.out' } });
  intro
    .from($$('.word', title), { yPercent: 60, autoAlpha: 0, filter: 'blur(8px)', duration: 1.1, stagger: 0.06, clearProps: 'filter' })
    .to('[data-hero]', { autoAlpha: 1, duration: 0 }, 0)
    .from('[data-hero]', { y: 16, autoAlpha: 0, duration: 0.9, stagger: 0.08 }, 0.15)
    .from('.demo-stage', { y: 80, autoAlpha: 0, duration: 1.4 }, 0.35)
    .from('.hero-glow', { autoAlpha: 0, scale: 0.85, duration: 2, ease: 'power2.out' }, 0);

  /* demo tilts back as it arrives, flattens as you scroll */
  gsap.fromTo('.demo-stage',
    { rotateX: 22, scale: 0.92 },
    { rotateX: 0, scale: 1, ease: 'none',
      scrollTrigger: { trigger: '.demo', start: 'top 95%', end: 'top 25%', scrub: 0.6 } });
  gsap.to('.hero-grid', { yPercent: 30, ease: 'none', scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true } });

  /* ---------- marquee ---------- */
  const track = $('.marquee-track');
  if (track) {
    for (const li of [...track.children]) {
      const copy = li.cloneNode(true);
      copy.setAttribute('aria-hidden', 'true');
      track.append(copy);
    }
    const loop = gsap.to(track, { xPercent: -50, duration: 28, ease: 'none', repeat: -1 });
    const marquee = track.parentElement;
    marquee.addEventListener('pointerenter', () => gsap.to(loop, { timeScale: 0.2, duration: 0.6 }));
    marquee.addEventListener('pointerleave', () => gsap.to(loop, { timeScale: 1, duration: 0.6 }));
    ScrollTrigger.create({ trigger: marquee, onToggle: (s) => (s.isActive ? loop.play() : loop.pause()) });
  }

  /* ---------- generic reveals ---------- */
  ScrollTrigger.batch('[data-reveal]', {
    start: 'top 85%',
    once: true,
    onEnter: (els) => gsap.fromTo(els, { y: 28, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.9, stagger: 0.08, ease: 'expo.out' }),
  });
  ScrollTrigger.batch('[data-card]', {
    start: 'top 88%',
    once: true,
    onEnter: (els) => gsap.fromTo(els, { y: 40, autoAlpha: 0, scale: 0.97 }, { y: 0, autoAlpha: 1, scale: 1, duration: 1, stagger: 0.09, ease: 'expo.out' }),
  });

  /* ---------- features deck: each card sinks back as the next slides over ---------- */
  const deck = $$('[data-stack]');
  deck.forEach((card, i) => {
    card.style.setProperty('--i', i);
    const shade = document.createElement('span');
    shade.className = 'stack-shade';
    card.append(shade);
    gsap.from(card.querySelector('.card-copy'), {
      y: 40, autoAlpha: 0, duration: 0.9, ease: 'expo.out',
      scrollTrigger: { trigger: card, start: 'top 80%', once: true },
    });
    gsap.from(card.querySelectorAll('.pick, .modes, .mini'), {
      y: 50, autoAlpha: 0, scale: 0.96, duration: 1, stagger: 0.08, ease: 'expo.out',
      scrollTrigger: { trigger: card, start: 'top 75%', once: true },
    });
    const next = deck[i + 1];
    if (!next) return;
    const depth = deck.length - 1 - i;
    gsap.timeline({
      scrollTrigger: { trigger: next, start: 'top 75%', end: `top ${96 + (i + 1) * 22}px`, scrub: true },
    })
      .to(card, { scale: 1 - depth * 0.05, ease: 'none' }, 0)
      .to(shade, { opacity: 0.35, ease: 'none' }, 0);
  });

  /* ---------- loop steps: staggered + progress line scrubbed ---------- */
  gsap.fromTo('.step', { y: 40, autoAlpha: 0 }, {
    y: 0, autoAlpha: 1, duration: 0.9, stagger: 0.15, ease: 'expo.out',
    scrollTrigger: { trigger: '[data-steps]', start: 'top 80%', once: true },
  });
  gsap.fromTo('[data-steps-fill]', { scaleX: 0 }, {
    scaleX: 1, ease: 'none',
    scrollTrigger: { trigger: '[data-steps]', start: 'top 75%', end: 'bottom 45%', scrub: 0.5 },
  });
  gsap.from('.step-icon', {
    scale: 0, rotate: -45, duration: 0.7, stagger: 0.15, ease: 'back.out(2)', delay: 0.2,
    scrollTrigger: { trigger: '[data-steps]', start: 'top 80%', once: true },
  });

  /* ---------- point-at-it card: cursor glides to the button ---------- */
  const pick = $('[data-pick]');
  if (pick) {
    const tl = gsap.timeline({ repeat: -1, repeatDelay: 1.2, paused: true });
    tl.set('.pick-btn i, .pick-btn b, .pick-chip', { autoAlpha: 0 })
      .set('.pick-text', { autoAlpha: 0 })
      .fromTo('.pick-cursor', { x: 120, y: 60 }, { x: 0, y: 0, duration: 1, ease: 'power3.inOut' })
      .to('.pick-btn i', { autoAlpha: 1, duration: 0.25 })
      .to('.pick-btn b', { autoAlpha: 1, y: 0, duration: 0.25 }, '<0.1')
      .fromTo('.pick-chip', { y: 10, autoAlpha: 0, scale: 0.9 }, { y: 0, autoAlpha: 1, scale: 1, duration: 0.5, ease: 'back.out(2)' }, '+=0.3')
      .to('.pick-text', { autoAlpha: 1, duration: 0.5 }, '+=0.1')
      .to({}, { duration: 2 });
    ScrollTrigger.create({ trigger: pick, start: 'top 85%', end: 'bottom top', onToggle: (s) => (s.isActive ? tl.play() : tl.pause()) });
  }

  /* ---------- terminal typing ---------- */
  const lines = $$('[data-type] .tl');
  if (lines.length) {
    gsap.set(lines, { autoAlpha: 0 });
    const typing = gsap.timeline({ scrollTrigger: { trigger: '[data-type]', start: 'top 75%', once: true } });
    lines.forEach((line) => {
      const prompt = line.querySelector('.t-p');
      if (prompt) {
        typing.set(line, { autoAlpha: 1, clipPath: 'inset(0 100% 0 0)' })
          .to(line, { clipPath: 'inset(0 0% 0 0)', duration: Math.min(1, line.textContent.length * 0.035), ease: `steps(${line.textContent.length})` });
      } else {
        typing.to(line, { autoAlpha: 1, duration: 0.2 }, '+=0.15');
      }
    });
    gsap.from('[data-type]', { y: 40, autoAlpha: 0, rotateY: -8, duration: 1.1, ease: 'expo.out', scrollTrigger: { trigger: '[data-type]', start: 'top 85%', once: true } });
  }

  /* ---------- stat count-up ---------- */
  for (const el of $$('[data-count]')) {
    const target = Number(el.dataset.count);
    const counter = { v: target === 0 ? 9 : 0 };
    gsap.to(counter, {
      v: target, duration: 1.4, ease: 'power3.out',
      scrollTrigger: { trigger: el, start: 'top 90%', once: true },
      onUpdate: () => { el.textContent = Math.round(counter.v); },
    });
  }

  /* ---------- final section glow breathes on scroll ---------- */
  gsap.fromTo('.final-glow', { scale: 0.6, autoAlpha: 0.3 }, {
    scale: 1.1, autoAlpha: 1, ease: 'none',
    scrollTrigger: { trigger: '.final', start: 'top bottom', end: 'center center', scrub: true },
  });
  gsap.from('.final-mark', { rotate: -90, scale: 0.4, autoAlpha: 0, duration: 1.2, ease: 'expo.out', scrollTrigger: { trigger: '.final', start: 'top 70%', once: true } });

  /* ---------- magnetic primary buttons (fine pointers only) ---------- */
  if (matchMedia('(pointer: fine)').matches) {
    for (const btn of $$('.dl-button, .btn-primary, .nav-download')) {
      const xTo = gsap.quickTo(btn, 'x', { duration: 0.5, ease: 'power3.out' });
      const yTo = gsap.quickTo(btn, 'y', { duration: 0.5, ease: 'power3.out' });
      btn.addEventListener('pointermove', (e) => {
        const r = btn.getBoundingClientRect();
        xTo((e.clientX - r.left - r.width / 2) * 0.18);
        yTo((e.clientY - r.top - r.height / 2) * 0.25);
      });
      btn.addEventListener('pointerleave', () => { xTo(0); yTo(0); });
    }
  }

  /* FAQ: smooth open */
  for (const d of $$('.faq details')) {
    d.addEventListener('toggle', () => {
      if (d.open) gsap.from(d.querySelector('p'), { y: -6, autoAlpha: 0, duration: 0.4, ease: 'power2.out' });
    });
  }
})();

(() => {
  const badges = document.querySelectorAll('[data-stars]');
  if (!badges.length) return;
  fetch('https://api.github.com/repos/umarbashirr/Conn')
    .then((r) => (r.ok ? r.json() : null))
    .then((repo) => {
      const n = repo?.stargazers_count;
      if (typeof n !== 'number' || n < 1) return;
      const text = n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
      for (const badge of badges) {
        badge.querySelector('[data-stars-count]').textContent = text;
        badge.setAttribute('aria-label', `${n} stars`);
        badge.hidden = false;
      }
    })
    .catch(() => {});
})();
