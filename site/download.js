(() => {
  const RELEASES_PAGE = 'https://github.com/umarbashirr/Conn/releases/latest';
  const LATEST = 'https://api.github.com/repos/umarbashirr/Conn/releases/latest';

  const FILES = {
    deb: { match: /amd64\.deb$/i, noun: 'Debian package' },
    appimage: { match: /x86_64\.appimage$/i, noun: 'AppImage' },
    exe: { match: /x64\.exe$/i, noun: 'Windows installer' },
  };

  const PLATFORMS = {
    linux: { label: 'Download for Linux', logo: '#logo-linux', file: 'deb', fallback: RELEASES_PAGE },
    windows: { label: 'Download for Windows', logo: '#logo-windows', file: 'exe', fallback: RELEASES_PAGE },
    other: { label: 'See all downloads', logo: '#i-download', file: null, fallback: '#download' },
  };

  // Each row is [state, atMs] after the click.
  const MOTION = [['press', 0], ['drop', 100], ['sweep', 400], ['started', 1200], ['rest', 5200]];
  const STILL = [['started', 0], ['rest', 4000]]; // prefers-reduced-motion: reduce
  const BUSY_LABEL = { drop: 'Starting download…', sweep: 'Starting download…', started: 'Download started' };
  const COPIED_MS = 1500;

  function platformOf(nav) {
    const id = nav.userAgentData?.platform || nav.userAgent || '';
    if (/windows/i.test(id)) return 'windows';
    if (/android|cros|chrom(e|ium) os/i.test(id)) return 'other';
    return /linux/i.test(id) ? 'linux' : 'other';
  }

  const mb = (bytes) => `${Math.round(bytes / 1e6)} MB`;

  // The one place the GitHub response is checked. Everything after it trusts the shape.
  function releaseOf(json) {
    const tag = json?.tag_name;
    if (typeof tag !== 'string' || !tag) return null;
    const assets = (Array.isArray(json.assets) ? json.assets : []).filter(
      (a) => typeof a?.name === 'string' && /^https:\/\//.test(a.browser_download_url),
    );
    const files = {};
    for (const [key, { match }] of Object.entries(FILES)) {
      const asset = assets.find((a) => match.test(a.name));
      if (asset) {
        const size = Number.isFinite(asset.size) && asset.size > 0 ? asset.size : undefined;
        files[key] = { name: asset.name, url: asset.browser_download_url, size };
      }
    }
    return { version: tag.replace(/^v/, ''), files };
  }

  async function latestRelease() {
    try {
      const res = await fetch(LATEST);
      return res.ok ? releaseOf(await res.json()) : null;
    } catch {
      return null;
    }
  }

  const all = (selector) => document.querySelectorAll(selector);
  const nav = document.querySelector('.nav-download');
  const hero = document.querySelector('.dl-button');
  const heroNote = document.querySelector('[data-hero-note]');

  // A null release is unknown, not empty: the lookup has not answered or failed, so the platform's
  // own look stands. Only a known release can take the download away.
  function heroOf(key, release) {
    const platform = PLATFORMS[key];
    if (!release) {
      return { os: key, label: platform.label, logo: platform.logo, href: platform.fallback, download: false, note: null };
    }
    const file = platform.file && release.files[platform.file];
    if (file) {
      return { os: key, label: platform.label, logo: platform.logo, href: file.url, download: true, note: null };
    }
    const { label, logo, fallback } = PLATFORMS.other;
    const note = platform.file ? `The ${FILES[platform.file].noun} isn't in v${release.version} yet.` : null;
    return { os: 'other', label, logo, href: fallback, download: false, note };
  }

  function showHero({ os, label, logo, href, download, note }) {
    hero.dataset.os = os;
    hero.querySelector('use[data-logo]').setAttribute('href', logo);
    hero.querySelector('.dl-label').textContent = label;
    hero.setAttribute('href', href);
    hero.toggleAttribute('download', download);
    heroNote.textContent = note ?? '';
    heroNote.hidden = note === null;
  }

  function showPlatform(key) {
    nav.dataset.os = key;
    nav.querySelector('use[data-logo]').setAttribute('href', PLATFORMS[key].logo);
    for (const el of all('[data-for]')) el.hidden = !el.dataset.for.split(' ').includes(key);
    for (const card of all('[data-platform]')) card.toggleAttribute('data-detected', card.dataset.platform === key);
  }

  function showFileLink(a, file) {
    a.toggleAttribute('data-absent', !file);
    if (file) {
      a.href = file.url;
      a.setAttribute('download', '');
      return;
    }
    a.removeAttribute('download');
    if (a.dataset.absentHref) a.setAttribute('href', a.dataset.absentHref);
    const label = a.querySelector('[data-absent-label]');
    if (label) {
      label.textContent = label.dataset.absentLabel;
      a.setAttribute('aria-disabled', 'true');
      a.tabIndex = -1;
    }
  }

  function showRelease(release) {
    for (const el of all('[data-version]')) el.textContent = release.version;
    for (const key of Object.keys(FILES)) {
      const file = release.files[key];
      for (const a of all(`a[data-file="${key}"]`)) showFileLink(a, file);
      for (const el of all(`[data-file-name="${key}"]`)) {
        if (file) el.textContent = file.name;
        else el.hidden = true;
      }
      for (const el of all(`[data-file-size="${key}"]`)) {
        if (!file) el.hidden = true;
        else if (file.size) el.textContent = mb(file.size);
      }
    }
  }

  const animations = new WeakMap();

  function setState(button, state) {
    button.dataset.state = state;
    button.querySelector('.dl-label').textContent = BUSY_LABEL[state] ?? PLATFORMS[button.dataset.os].label;
  }

  function play(button) {
    for (const id of animations.get(button) ?? []) clearTimeout(id);
    const steps = matchMedia('(prefers-reduced-motion: reduce)').matches ? STILL : MOTION;
    animations.set(button, steps.map(([state, at]) => setTimeout(setState, at, button, state)));
  }

  const copyTimers = new WeakMap();

  async function copy(trigger) {
    const source = document.getElementById(trigger.dataset.copy);
    try {
      await navigator.clipboard.writeText(source.textContent.trim());
    } catch {
      getSelection().selectAllChildren(source);
      return;
    }
    const label = trigger.querySelector('.copy-label');
    const rest = (label.dataset.rest ??= label.textContent);
    label.textContent = 'Copied';
    trigger.toggleAttribute('data-copied', true);
    clearTimeout(copyTimers.get(trigger));
    copyTimers.set(trigger, setTimeout(() => {
      label.textContent = rest;
      trigger.toggleAttribute('data-copied', false);
    }, COPIED_MS));
  }

  document.addEventListener('click', (event) => {
    const download = event.target.closest('.dl-button[download]');
    if (download) play(download);
    const copyButton = event.target.closest('[data-copy]');
    if (copyButton) copy(copyButton);
  });

  const key = platformOf(navigator);
  showPlatform(key);
  showHero(heroOf(key, null));
  latestRelease().then((release) => {
    if (!release) return;
    showRelease(release);
    showHero(heroOf(key, release));
  });
})();
