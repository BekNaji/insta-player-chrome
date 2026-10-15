/* Instagram Video Player — content script
 *
 * Plan:
 *  - Every <video> gets exactly ONE panel (tracked in a Map, so no duplicates).
 *  - The panel is NOT placed inside the <a> link. It is appended to document.body
 *    (or the fullscreen element) and positioned over the video with position: fixed.
 *  - All click/touch events on the panel are stopped with stopPropagation.
 *  - Position is refreshed in a requestAnimationFrame loop, so it follows scroll/resize.
 *  - Speed, volume and mute are saved in chrome.storage.local.
 */
(() => {
  'use strict';

  // Prevent the script from running twice
  if (window.__ivpLoaded) return;
  window.__ivpLoaded = true;

  // ---------- Settings ----------
  const SPEEDS = [1, 1.25, 1.5, 2];
  const SEEK_STEP = 5; // seconds
  const DEFAULTS = { speed: 1, volume: 1, muted: false };
  const MIN_VIDEO_WIDTH = 200; // no panel on videos smaller than this
  const MIN_VIDEO_HEIGHT = 150;
  const COMPACT_WIDTH = 420; // narrower videos get the compact layout
  const SIDE_INSET = 8; // distance from the video's left edge
  const RIGHT_RESERVED = 56; // space for Instagram's own mute button (bottom right)
  const BOTTOM_INSET = 8;
  const STORIES_BOTTOM_INSET = 76; // keep clear of the stories "send message" bar
  const MAX_PANEL_WIDTH = 520;

  // ---------- State ----------
  const state = { ...DEFAULTS };
  const panels = new Map(); // video -> panel object
  const ratios = new WeakMap(); // video -> visible ratio on screen
  const pointer = { x: -1, y: -1 };
  let scanTimer = null;

  // ---------- Helpers ----------

  // Format seconds as "m:ss" or "h:mm:ss"
  function formatTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '0:00';
    const s = Math.floor(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    const rr = String(r).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${rr}` : `${m}:${rr}`;
  }

  // Is the user typing in an input, textarea, select or contenteditable?
  function isTypingTarget(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      // range, checkbox, etc. do not accept text, so shortcuts stay allowed
      return !['range', 'checkbox', 'radio', 'button', 'submit'].includes(t);
    }
    return el.isContentEditable || !!el.closest('[contenteditable="true"], [role="textbox"]');
  }

  // Safely check that storage is available (it throws after the extension is reloaded)
  function storageOk() {
    try {
      return !!(chrome && chrome.runtime && chrome.runtime.id && chrome.storage && chrome.storage.local);
    } catch (e) {
      return false;
    }
  }

  let saveTimer = null;
  function saveState() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!storageOk()) return;
      try {
        chrome.storage.local.set({ speed: state.speed, volume: state.volume, muted: state.muted });
      } catch (e) { /* ignore */ }
    }, 150);
  }

  // ---------- Apply saved state to videos ----------
  function applyToVideo(video) {
    try {
      if (video.playbackRate !== state.speed) video.playbackRate = state.speed;
      if (Math.abs(video.volume - state.volume) > 0.001) video.volume = state.volume;
      if (video.muted !== state.muted) video.muted = state.muted;
    } catch (e) { /* ignore */ }
  }

  function applyToAll() {
    panels.forEach((p, video) => {
      applyToVideo(video);
      updateStaticUI(p);
    });
  }

  // ---------- Panel creation ----------
  function makeBtn(text, title) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ivp-btn';
    b.textContent = text;
    b.title = title;
    return b;
  }

  function makeRange(cls, min, max, step) {
    const r = document.createElement('input');
    r.type = 'range';
    r.className = cls;
    r.min = String(min);
    r.max = String(max);
    r.step = String(step);
    r.value = '0';
    return r;
  }

  function createPanel(video) {
    const root = document.createElement('div');
    root.className = 'ivp-panel ivp-hidden';
    root.setAttribute('data-ivp', '1');

    const seek = makeRange('ivp-seek', 0, 1000, 1);
    seek.disabled = true;
    seek.title = 'Seek';

    const row = document.createElement('div');
    row.className = 'ivp-row';

    const playBtn = makeBtn('▶', 'Play / Pause (Space)');
    const time = document.createElement('span');
    time.className = 'ivp-time';
    time.textContent = '0:00 / 0:00';
    const spacer = document.createElement('span');
    spacer.className = 'ivp-spacer';
    const speedBtn = makeBtn('1x', 'Speed');
    const muteBtn = makeBtn('🔊', 'Mute (M)');
    const vol = makeRange('ivp-vol', 0, 1, 0.05);
    vol.title = 'Volume';

    row.append(playBtn, time, spacer, speedBtn, muteBtn, vol);
    root.append(seek, row);

    const p = { video, root, seek, playBtn, time, speedBtn, muteBtn, vol, dragging: false, cache: {} };

    // --- Keep events away from Instagram ---
    const blocked = [
      'click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup',
      'touchstart', 'touchend', 'touchmove', 'contextmenu', 'wheel'
    ];
    blocked.forEach((type) => {
      root.addEventListener(type, (e) => e.stopPropagation(), { passive: true });
    });

    // --- Controls ---
    playBtn.addEventListener('click', () => { togglePlay(video); playBtn.blur(); });
    speedBtn.addEventListener('click', () => { cycleSpeed(); speedBtn.blur(); });
    muteBtn.addEventListener('click', () => { toggleMute(); muteBtn.blur(); });

    vol.addEventListener('input', () => {
      state.volume = Number(vol.value);
      state.muted = state.volume === 0;
      applyToAll();
      saveState();
    });

    // Seek slider: dragging jumps the video to that position
    const startDrag = () => { p.dragging = true; };
    seek.addEventListener('pointerdown', startDrag);
    seek.addEventListener('touchstart', startDrag, { passive: true });
    seek.addEventListener('input', () => {
      const d = video.duration;
      if (!Number.isFinite(d) || d <= 0) return;
      try { video.currentTime = (Number(seek.value) / 1000) * d; } catch (e) { /* ignore */ }
      updateProgress(p, true);
    });
    seek.addEventListener('change', () => { p.dragging = false; seek.blur(); });

    // Video events: keep the UI in sync
    ['play', 'pause', 'ended', 'volumechange', 'ratechange', 'loadedmetadata', 'durationchange']
      .forEach((ev) => video.addEventListener(ev, () => updateStaticUI(p)));
    // Instagram may swap the video source, so re-apply our settings
    ['loadedmetadata', 'loadstart', 'playing'].forEach((ev) =>
      video.addEventListener(ev, () => applyToVideo(video)));

    return p;
  }

  // ---------- UI updates ----------
  function setText(p, key, el, value) {
    if (p.cache[key] !== value) {
      p.cache[key] = value;
      el.textContent = value;
    }
  }

  // Rarely changing parts: play icon, speed, volume
  function updateStaticUI(p) {
    const v = p.video;
    setText(p, 'play', p.playBtn, v.paused || v.ended ? '▶' : '❚❚');
    setText(p, 'speed', p.speedBtn, `${state.speed}x`);
    const muted = v.muted || v.volume === 0;
    setText(p, 'mute', p.muteBtn, muted ? '🔇' : '🔊');
    const shownVol = v.muted ? 0 : v.volume;
    if (document.activeElement !== p.vol && Number(p.vol.value) !== shownVol) p.vol.value = String(shownVol);
    updateProgress(p, true);
  }

  // Progress slider and time (called every frame, so it stays cheap)
  function updateProgress(p, force) {
    const v = p.video;
    const d = v.duration;
    const known = Number.isFinite(d) && d > 0;
    if (p.seek.disabled === known) p.seek.disabled = !known;
    const cur = Number.isFinite(v.currentTime) ? v.currentTime : 0;
    if (!p.dragging && (force || !v.paused)) {
      const pos = known ? Math.round((cur / d) * 1000) : 0;
      if (Number(p.seek.value) !== pos) p.seek.value = String(pos);
    }
    setText(p, 'time', p.time, `${formatTime(cur)} / ${known ? formatTime(d) : '--:--'}`);
  }

  // ---------- Actions ----------
  function togglePlay(video) {
    if (video.paused || video.ended) {
      const pr = video.play();
      if (pr && typeof pr.catch === 'function') pr.catch(() => {});
    } else {
      video.pause();
    }
  }

  function cycleSpeed() {
    // Move to the speed after the current one in the list
    let idx = SPEEDS.indexOf(state.speed);
    if (idx === -1) idx = 0;
    state.speed = SPEEDS[(idx + 1) % SPEEDS.length];
    applyToAll();
    saveState();
  }

  function toggleMute() {
    // If volume is 0, raise it when unmuting
    state.muted = !state.muted;
    if (!state.muted && state.volume === 0) state.volume = 0.5;
    applyToAll();
    saveState();
  }

  function seekBy(video, delta) {
    const d = video.duration;
    let t = (Number.isFinite(video.currentTime) ? video.currentTime : 0) + delta;
    t = Math.max(0, t);
    if (Number.isFinite(d)) t = Math.min(t, d);
    try { video.currentTime = t; } catch (e) { /* ignore */ }
  }

  // ---------- Video registration ----------
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => ratios.set(e.target, e.intersectionRatio));
  }, { threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] });

  function register(video) {
    if (panels.has(video)) return; // never add two panels to one video
    const p = createPanel(video);
    panels.set(video, p);
    io.observe(video);
    applyToVideo(video);
    updateStaticUI(p);
  }

  function unregister(video) {
    const p = panels.get(video);
    if (!p) return;
    p.root.remove();
    panels.delete(video);
    io.unobserve(video);
  }

  function scan() {
    document.querySelectorAll('video').forEach(register);
    // Clean up videos that were removed from the DOM
    panels.forEach((p, video) => { if (!video.isConnected) unregister(video); });
  }

  // MutationObserver with debounce (Instagram loads content dynamically)
  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 200);
  }
  new MutationObserver(scheduleScan).observe(document.documentElement, { childList: true, subtree: true });

  // ---------- Positioning loop ----------
  function layout() {
    const fs = document.fullscreenElement;
    const host = fs && fs.tagName !== 'VIDEO' ? fs : document.body;
    const bottomInset = location.pathname.startsWith('/stories/') ? STORIES_BOTTOM_INSET : BOTTOM_INSET;

    panels.forEach((p, video) => {
      if (!video.isConnected) return; // scan() will clean it up
      const rect = video.getBoundingClientRect();
      const ratio = ratios.get(video) || 0;
      const show =
        ratio > 0.3 &&
        rect.width >= MIN_VIDEO_WIDTH &&
        rect.height >= MIN_VIDEO_HEIGHT &&
        document.fullscreenElement !== video;

      if (!show) {
        if (!p.root.classList.contains('ivp-hidden')) p.root.classList.add('ivp-hidden');
        return;
      }
      if (p.root.parentNode !== host) host.appendChild(p.root);
      p.root.classList.remove('ivp-hidden');

      // Panel width: leave room on the right for Instagram's mute button
      const width = Math.max(
        160,
        Math.min(MAX_PANEL_WIDTH, rect.width - SIDE_INSET - RIGHT_RESERVED)
      );
      const visibleBottom = Math.min(rect.bottom, window.innerHeight);
      const height = p.root.offsetHeight || 56;
      const left = Math.round(rect.left + SIDE_INSET);
      const top = Math.round(visibleBottom - height - bottomInset);

      const c = p.cache;
      if (c.w !== width) { c.w = width; p.root.style.width = `${width}px`; }
      if (c.l !== left) { c.l = left; p.root.style.left = `${left}px`; }
      if (c.t !== top) { c.t = top; p.root.style.top = `${top}px`; }

      const compact = rect.width < COMPACT_WIDTH;
      p.root.classList.toggle('ivp-compact', compact);

      // Fully visible when hovering the video, when paused, or while dragging
      const hovered =
        pointer.x >= rect.left && pointer.x <= rect.right &&
        pointer.y >= rect.top && pointer.y <= rect.bottom;
      p.root.classList.toggle('ivp-active', hovered || video.paused || p.dragging);

      updateProgress(p, false);
    });
    requestAnimationFrame(layout);
  }

  // ---------- Keyboard ----------
  // Which video to control: the one under the pointer, otherwise the most visible one
  function activeVideo() {
    let best = null;
    let bestScore = 0;
    panels.forEach((p, video) => {
      if (p.root.classList.contains('ivp-hidden')) return;
      const r = video.getBoundingClientRect();
      const over = pointer.x >= r.left && pointer.x <= r.right && pointer.y >= r.top && pointer.y <= r.bottom;
      const score = (ratios.get(video) || 0) + (over ? 10 : 0) + (!video.paused ? 0.5 : 0);
      if (score > bestScore) { bestScore = score; best = video; }
    });
    return best;
  }

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;

    const key = e.key;
    const isSpace = key === ' ' || e.code === 'Space';
    if (!(isSpace || key === 'ArrowLeft' || key === 'ArrowRight' || key === 'm' || key === 'M')) return;

    const video = activeVideo();
    if (!video) return;

    e.preventDefault();
    e.stopPropagation();
    if (isSpace) togglePlay(video);
    else if (key === 'ArrowLeft') seekBy(video, -SEEK_STEP);
    else if (key === 'ArrowRight') seekBy(video, SEEK_STEP);
    else toggleMute();
  }, true);

  // ---------- Pointer tracking / end of dragging ----------
  window.addEventListener('pointermove', (e) => { pointer.x = e.clientX; pointer.y = e.clientY; }, { passive: true, capture: true });
  const endDrag = () => panels.forEach((p) => { p.dragging = false; });
  window.addEventListener('pointerup', endDrag, true);
  window.addEventListener('touchend', endDrag, true);

  // ---------- Storage ----------
  function loadState(cb) {
    if (!storageOk()) { cb(); return; }
    try {
      chrome.storage.local.get(DEFAULTS, (res) => {
        if (res) {
          const sp = Number(res.speed);
          const vo = Number(res.volume);
          state.speed = SPEEDS.includes(sp) ? sp : DEFAULTS.speed;
          state.volume = Number.isFinite(vo) ? Math.min(1, Math.max(0, vo)) : DEFAULTS.volume;
          state.muted = !!res.muted;
        }
        cb();
      });
    } catch (e) { cb(); }
  }

  // If another tab changes the settings, update this tab too
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.speed && SPEEDS.includes(Number(changes.speed.newValue))) state.speed = Number(changes.speed.newValue);
      if (changes.volume && Number.isFinite(Number(changes.volume.newValue))) state.volume = Number(changes.volume.newValue);
      if (changes.muted) state.muted = !!changes.muted.newValue;
      applyToAll();
    });
  } catch (e) { /* ignore */ }

  // ---------- Start ----------
  loadState(() => {
    scan();
    requestAnimationFrame(layout);
  });
})();
