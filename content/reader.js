/* =========================================================================
   TTSFlow reader.

   Reading only ever starts from an explicit user action or from a resume
   token the background issued to THIS tab for THIS navigation. The old
   origin-wide localStorage flag is gone: it started every tab of the same
   site, and it survived restarts, so pages read themselves unprompted.
   ========================================================================= */

(() => {
  'use strict';

  if (window.top !== window) return;
  if (!/^https?:$/.test(window.location.protocol)) return;
  if (window.__ttsflowLoaded) return;
  window.__ttsflowLoaded = true;

  const NS = globalThis.TTSFlow;
  const { NativeEngine, PiperEngine, bg } = NS.engines;

  let sentences = [];
  let currentIndex = 0;
  let isPlaying = false;
  let overlay = null;
  let textContainer = null;

  let nativeEngine = null;
  let piperEngine = null;
  let voicePanel = null;
  let sessionPort = null;

  let previousBodyOverflow = '';
  let handingOffToNextChapter = false;
  let dismissGesturePrompt = null;

  const settings = {
    speed: 1.0,
    pitch: 1.0,
    engine: 'native',
    voiceName: '',
    voiceId: '',
    autoAdvance: true,
    resumePosition: true,
    autoScroll: true
  };
  const PREF_KEYS = Object.keys(settings);
  let settingsLoaded = false;

  /* ---------------------------------------------------------------------
     Settings and reading position
     --------------------------------------------------------------------- */

  async function loadSettings() {
    if (settingsLoaded) return;
    settingsLoaded = true;

    let stored = {};
    try {
      stored = await browser.storage.local.get(PREF_KEYS);
    } catch (e) {
      stored = {};
    }

    // One-time migration off localStorage, and removal of the flag that
    // used to make unrelated tabs start reading by themselves.
    try {
      if (stored.speed == null) stored.speed = parseFloat(localStorage.getItem('ttsflow_speed'));
      if (stored.voiceName == null) stored.voiceName = localStorage.getItem('ttsflow_voice');
      localStorage.removeItem('ttsflow_autoplay');
      localStorage.removeItem('ttsflow_speed');
      localStorage.removeItem('ttsflow_voice');
    } catch (e) {
      /* storage blocked by site policy */
    }

    const speed = parseFloat(stored.speed);
    settings.speed = Number.isFinite(speed) ? Math.min(2.5, Math.max(0.5, speed)) : 1.0;
    const pitch = parseFloat(stored.pitch);
    settings.pitch = Number.isFinite(pitch) ? Math.min(1.4, Math.max(0.7, pitch)) : 1.0;
    settings.engine = stored.engine === 'piper' ? 'piper' : 'native';
    settings.voiceName = typeof stored.voiceName === 'string' ? stored.voiceName : '';
    settings.voiceId = typeof stored.voiceId === 'string' ? stored.voiceId : '';

    for (const key of ['autoAdvance', 'resumePosition', 'autoScroll']) {
      if (typeof stored[key] === 'boolean') settings[key] = stored[key];
    }
  }

  // The options page writes straight to storage, so pick up changes made
  // while a reader is already open.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    let speedChanged = false;
    let voiceChanged = false;
    let resynthNeeded = false;

    for (const key of PREF_KEYS) {
      if (!(key in changes)) continue;
      const value = changes[key].newValue;
      // Equal means this is the echo of our own write; reacting to it caused
      // a second setRate per slider tick, which re-spoke the sentence twice.
      if (value === undefined || value === settings[key]) continue;
      settings[key] = value;

      if (key === 'speed') speedChanged = true;
      if (key === 'pitch') resynthNeeded = true;
      if (key === 'engine' || key === 'voiceName' || key === 'voiceId') voiceChanged = true;
    }

    if (speedChanged) {
      const val = document.getElementById('ttsflow-speed-val');
      const slider = document.getElementById('ttsflow-speed-slider');
      if (val) val.textContent = settings.speed.toFixed(1);
      if (slider) slider.value = String(settings.speed);
      if (isPlaying) activeEngine().setRate(settings.speed);
    }

    // A voice picked on the options page has to reach the overlay's own
    // picker, or its label keeps naming the voice you just replaced.
    if (voiceChanged && voicePanel) {
      voicePanel.setSelection({
        engine: settings.engine,
        voiceName: settings.voiceName,
        voiceId: settings.voiceId
      });
    }

    // Pitch and voice both change how the sentence must be produced, so the
    // current one is re-spoken rather than waiting for the next.
    if ((voiceChanged || resynthNeeded) && isPlaying) playCurrentSentence();
  });

  function saveSettings() {
    try {
      browser.storage.local.set({ ...settings });
    } catch (e) {
      /* best effort */
    }
  }

  function positionKey() {
    return window.location.origin + window.location.pathname;
  }

  async function savePosition() {
    try {
      const { positions = {} } = await browser.storage.local.get('positions');
      positions[positionKey()] = { index: currentIndex, at: Date.now() };

      // Keep the newest 60 chapters; this is a convenience, not an archive.
      const entries = Object.entries(positions).sort((a, b) => b[1].at - a[1].at);
      await browser.storage.local.set({ positions: Object.fromEntries(entries.slice(0, 60)) });
    } catch (e) {
      /* best effort */
    }
  }

  async function loadPosition() {
    try {
      const { positions = {} } = await browser.storage.local.get('positions');
      const entry = positions[positionKey()];
      if (entry && entry.index > 0 && entry.index < sentences.length) return entry.index;
    } catch (e) {
      /* best effort */
    }
    return 0;
  }

  /* ---------------------------------------------------------------------
     Text extraction
     --------------------------------------------------------------------- */

  // Tried in order. querySelector with a comma-joined list returns the first
  // match in document order, not selector order, so a generic wrapper near
  // the top of the page would otherwise beat the real chapter container.
  const CONTENT_SELECTORS = [
    '.reader-container', '.chapter-body', '.chapter-content', '.chapter-inner',
    '#chapter-content', '#chapter-container', '.chapter-text', '.reader-content',
    '.entry-content', 'article'
  ];

  const PARAGRAPH_SELECTOR = 'p, .paragraph, .wtr-line';

  const SKIP_CONTAINERS =
    '.ad-blocker-message, .wtr-ads, .ads-report-warning, .bottom-reader-nav, ' +
    'nav, header, footer, .btn, button';

  const STOP_CONTAINERS =
    '.author-note-bottom, .comments-container, .chapter-nav, .portlet-body, ' +
    '.author-note, #comments';

  const STOP_PHRASES = [
    "if you're enjoying the story",
    'thanks for reading',
    "author's note",
    'royal road® is the home',
    'showing 1 to'
  ];

  const NAV_WORDS = ['next', 'next chapter', 'next >', 'previous', 'prev chapter'];

  function findContentArea(doc) {
    for (const selector of CONTENT_SELECTORS) {
      const known = doc.querySelector(selector);
      if (known) return known;
    }

    // Credit each paragraph to its ancestors, then take the deepest element
    // still holding essentially all the prose. Paragraphs are often wrapped
    // individually, so scoring only direct parents misses the real container.
    const scores = new Map();
    const depths = new Map();

    for (const el of doc.querySelectorAll(PARAGRAPH_SELECTOR)) {
      const len = el.innerText.trim().length;
      if (len < 40) continue;

      let node = el.parentElement;
      for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
        if (node === doc.body || node === doc.documentElement) break;
        scores.set(node, (scores.get(node) || 0) + len);
        if (!depths.has(node)) {
          let d = 0;
          for (let a = node; a; a = a.parentElement) d++;
          depths.set(node, d);
        }
      }
    }

    let bestScore = 0;
    for (const score of scores.values()) if (score > bestScore) bestScore = score;
    if (bestScore === 0) return doc.body;

    let best = null;
    for (const [el, score] of scores) {
      if (score < bestScore * 0.95) continue;
      if (!best || depths.get(el) > depths.get(best)) best = el;
    }
    return best || doc.body;
  }

  function extractParagraphs(doc) {
    const contentArea = findContentArea(doc);
    const paragraphs = [];

    for (const el of contentArea.querySelectorAll(PARAGRAPH_SELECTOR)) {
      const text = el.innerText.trim();
      if (text.length < 5) continue;
      if (el.closest(SKIP_CONTAINERS)) continue;

      const lower = text.toLowerCase();
      const isBoundary =
        !!el.closest(STOP_CONTAINERS) ||
        NAV_WORDS.includes(lower) ||
        STOP_PHRASES.some((phrase) => lower.includes(phrase));

      if (isBoundary) {
        // These markers sit both above and below the chapter on Royal Road.
        // Above the story they are chrome to skip; below it they are the end.
        if (paragraphs.length === 0) continue;
        break;
      }

      paragraphs.push(text);
    }

    return paragraphs;
  }

  function extractAndSegmentText(doc) {
    const fullText = extractParagraphs(doc).join(' ');

    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
      sentences = Array.from(segmenter.segment(fullText))
        .map((s) => s.segment.trim())
        .filter((s) => s.length > 0);
    } else {
      sentences = fullText.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
    }

    currentIndex = 0;
  }

  /* ---------------------------------------------------------------------
     Notices
     --------------------------------------------------------------------- */

  // Small DOM helper: builds elements without ever assigning innerHTML.
  function el(tag, props = {}) {
    return Object.assign(document.createElement(tag), props);
  }

  function toast(message) {
    const el = document.createElement('div');
    el.className = 'ttsflow-toast';
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4500);
  }

  /* ---------------------------------------------------------------------
     Engines
     --------------------------------------------------------------------- */

  function activeEngine() {
    return settings.engine === 'piper' ? piperEngine : nativeEngine;
  }

  function speakOptions() {
    return {
      rate: settings.speed,
      pitch: settings.pitch,
      voiceName: settings.voiceName,
      voiceId: settings.voiceId,
      nextText: sentences[currentIndex + 1] || ''
    };
  }

  function wireEngine(candidate) {
    candidate.onended = () => {
      if (!isPlaying) return;
      if (currentIndex >= sentences.length - 1) {
        goToNextChapter();
      } else {
        moveSentence(1);
        playCurrentSentence();
      }
    };

    candidate.onerror = (info) => {
      if (info && info.blocked) {
        requireUserGesture(
          info.error === 'not-allowed'
            ? 'Your browser blocked audio on this page.'
            : 'Playback could not start.'
        );
        return;
      }
      // A neural voice that fails mid-chapter should not strand the reader.
      if (settings.engine === 'piper') {
        toast(`TTSFlow: neural voice failed (${(info && info.error) || 'unknown'}). Using a system voice.`);
        switchEngine('native');
        playCurrentSentence();
        return;
      }
      toast('TTSFlow: playback error.');
    };
  }

  function switchEngine(id) {
    const previous = activeEngine();
    if (previous) previous.stop();
    settings.engine = id;
    if (id === 'native' && !settings.voiceName) {
      const first = nativeEngine.synth.getVoices()[0];
      if (first) settings.voiceName = first.name;
    }
    saveSettings();
    if (voicePanel) {
      voicePanel.setSelection({
        engine: id,
        voiceName: settings.voiceName,
        voiceId: settings.voiceId
      });
    }
  }

  /* ---------------------------------------------------------------------
     Session port — keeps the background alive while reading, and tells it
     to tear playback down when this tab goes away.
     --------------------------------------------------------------------- */

  function openSession() {
    if (sessionPort) return;
    try {
      sessionPort = browser.runtime.connect({ name: 'ttsflow-session' });
      sessionPort.onDisconnect.addListener(() => {
        sessionPort = null;
      });
    } catch (e) {
      sessionPort = null;
    }
  }

  function closeSession() {
    if (sessionPort) {
      try {
        sessionPort.disconnect();
      } catch (e) {
        /* already gone */
      }
      sessionPort = null;
    }
  }

  /* ---------------------------------------------------------------------
     Startup
     --------------------------------------------------------------------- */

  async function startTTSFlow({ resumePosition = false } = {}) {
    if (document.getElementById('ttsflow-overlay')) return;

    await loadSettings();

    extractAndSegmentText(document);
    if (sentences.length === 0) {
      toast('TTSFlow: could not find readable text on this page.');
      return;
    }

    const claim = await bg('TTSFLOW_CLAIM');
    if (!claim.ok) {
      toast('TTSFlow: could not start (extension is reloading).');
      return;
    }

    nativeEngine = new NativeEngine();
    piperEngine = new PiperEngine();
    wireEngine(nativeEngine);
    wireEngine(piperEngine);

    // A missing system voice set is fatal only if we intended to use one.
    let systemVoices = [];
    try {
      await nativeEngine.init();
      systemVoices = nativeEngine.synth.getVoices();
    } catch (error) {
      if (settings.engine !== 'piper') {
        toast(`TTSFlow: ${error.message}`);
      }
    }

    if (!settings.voiceName && systemVoices.length) {
      const preferred =
        systemVoices.find((v) => v.default && v.lang.startsWith('en')) ||
        systemVoices.find((v) => v.lang.startsWith('en')) ||
        systemVoices[0];
      settings.voiceName = preferred.name;
    }

    if (settings.engine === 'piper' && !settings.voiceId) settings.engine = 'native';

    openSession();
    buildUI(systemVoices);

    if (resumePosition && settings.resumePosition) {
      const saved = await loadPosition();
      if (saved) {
        currentIndex = saved;
        toast(`TTSFlow: resuming at sentence ${saved + 1}.`);
      }
    }

    isPlaying = true;
    highlightCurrentSentence();
    playCurrentSentence();
  }

  /* ---------------------------------------------------------------------
     UI
     --------------------------------------------------------------------- */

  function buildUI(systemVoices) {
    overlay = document.createElement('div');
    overlay.id = 'ttsflow-overlay';

    const navbar = document.createElement('div');
    navbar.id = 'ttsflow-navbar';

    const logo = el('img', { id: 'ttsflow-navbar-logo', alt: 'Logo' });
    logo.src = browser.runtime.getURL('icon-128.png');

    const controls = el('div', { id: 'ttsflow-controls' });
    for (const [id, iconName, title] of [
      ['ttsflow-prev', 'prev', 'Previous sentence'],
      ['ttsflow-playpause', 'pause', 'Play / pause'],
      ['ttsflow-stop', 'stop', 'Stop'],
      ['ttsflow-next', 'next', 'Next sentence']
    ]) {
      const button = el('button', { id, className: 'ttsflow-btn', title });
      button.setAttribute('aria-label', title);
      button.appendChild(NS.icon(iconName, { size: id === 'ttsflow-playpause' ? 22 : 18 }));
      controls.appendChild(button);
    }

    const speedBox = el('div', { id: 'ttsflow-speed-control' });
    const speedLabel = el('label', { textContent: 'Speed: ' });
    speedLabel.appendChild(el('span', { id: 'ttsflow-speed-val', textContent: settings.speed.toFixed(1) }));
    speedLabel.append('x');
    const slider = el('input', { id: 'ttsflow-speed-slider', type: 'range' });
    slider.min = '0.5';
    slider.max = '2.5';
    slider.step = '0.1';
    slider.value = String(settings.speed);
    speedBox.append(speedLabel, slider);

    const closeButton = el('button', { id: 'ttsflow-close', className: 'ttsflow-btn', title: 'Close' });
    closeButton.setAttribute('aria-label', 'Close reader');
    closeButton.appendChild(NS.icon('close', { size: 18 }));

    navbar.append(
      logo,
      controls,
      speedBox,
      el('div', { id: 'ttsflow-voice-slot' }),
      closeButton
    );

    textContainer = document.createElement('div');
    textContainer.id = 'ttsflow-text-container';

    overlay.append(navbar, textContainer);
    document.body.appendChild(overlay);

    renderSentences();

    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    voicePanel = new NS.VoicePanel({
      onSelect: (selection) => {
        settings.engine = selection.engine;
        settings.voiceName = selection.voiceName;
        settings.voiceId = selection.voiceId;
        saveSettings();
        if (isPlaying) playCurrentSentence();
      },
      onNotice: toast
    });
    voicePanel.mount(navbar.querySelector('#ttsflow-voice-slot'));
    voicePanel.setSystemVoices(systemVoices.map((v) => ({ name: v.name, lang: v.lang })));
    voicePanel.setSelection({
      engine: settings.engine,
      voiceName: settings.voiceName,
      voiceId: settings.voiceId
    });

    attachEventListeners();
  }

  function renderSentences() {
    textContainer.textContent = '';
    sentences.forEach((sentence, index) => {
      const span = document.createElement('span');
      span.id = `ttsflow-s-${index}`;
      span.className = 'ttsflow-sentence';
      span.textContent = sentence + ' ';
      span.onclick = () => {
        currentIndex = index;
        isPlaying = true;
        setPlayPauseIcon();
        highlightCurrentSentence();
        playCurrentSentence();
      };
      textContainer.appendChild(span);
    });
  }

  function setPlayPauseIcon() {
    const btn = document.getElementById('ttsflow-playpause');
    if (!btn) return;
    btn.textContent = '';
    btn.appendChild(NS.icon(isPlaying ? 'pause' : 'play', { size: 22 }));
    btn.title = isPlaying ? 'Pause' : 'Play';
    btn.setAttribute('aria-label', btn.title);
  }

  function attachEventListeners() {
    // Dragging fires oninput continuously. Piper only has to change a
    // playbackRate, so it tracks live; the system engine can only change
    // speed by re-speaking the sentence, so that waits until the drag
    // settles. Saving is debounced too, instead of a storage write per pixel.
    let rateTimer = null;
    document.getElementById('ttsflow-speed-slider').oninput = (e) => {
      settings.speed = parseFloat(e.target.value);
      document.getElementById('ttsflow-speed-val').textContent = settings.speed.toFixed(1);

      const target = activeEngine();
      if (target.id === 'piper') target.setRate(settings.speed);

      clearTimeout(rateTimer);
      rateTimer = setTimeout(() => {
        saveSettings();
        if (activeEngine().id === 'native' && isPlaying) {
          activeEngine().setRate(settings.speed);
        }
      }, 300);
    };

    document.getElementById('ttsflow-close').onclick = closeTTSFlow;
    document.getElementById('ttsflow-next').onclick = () => nudge(1);
    document.getElementById('ttsflow-prev').onclick = () => nudge(-1);

    document.getElementById('ttsflow-stop').onclick = () => {
      isPlaying = false;
      activeEngine().stop();
      setPlayPauseIcon();
      savePosition();
      bg('TTSFLOW_RELEASE_SELF');
    };

    document.getElementById('ttsflow-playpause').onclick = togglePlayPause;

    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pagehide', onPageHide);
  }

  function onKeyDown(e) {
    if (!overlay || !document.getElementById('ttsflow-overlay')) return;
    if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      closeTTSFlow();
    } else if (e.key === ' ') {
      e.preventDefault();
      togglePlayPause();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      nudge(1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      nudge(-1);
    }
  }

  function nudge(step) {
    moveSentence(step);
    if (isPlaying) playCurrentSentence();
  }

  async function togglePlayPause() {
    isPlaying = !isPlaying;
    setPlayPauseIcon();

    if (!isPlaying) {
      activeEngine().pause();
      savePosition();
      return;
    }

    // Stop clears the engine, and resume() only revives a *paused* one, so
    // pressing play after stop used to do nothing at all. Stop also hands
    // back the reader lock, so take it again before making any sound.
    const target = activeEngine();
    if (!target.paused) await bg('TTSFLOW_CLAIM');
    if (target.paused) target.resume();
    else playCurrentSentence();
  }

  /* ---------------------------------------------------------------------
     Playback
     --------------------------------------------------------------------- */

  function playCurrentSentence() {
    if (!isPlaying) return;
    const text = sentences[currentIndex];
    if (!text) return;

    if (dismissGesturePrompt) dismissGesturePrompt();

    const target = activeEngine();
    // Stop whichever engine is not in use, so switching mid-sentence does
    // not leave two voices talking over each other.
    const other = target === nativeEngine ? piperEngine : nativeEngine;
    if (other) other.stop();

    target.speak(text, speakOptions());
  }

  function moveSentence(step) {
    currentIndex = Math.min(Math.max(currentIndex + step, 0), sentences.length - 1);
    highlightCurrentSentence();
  }

  function highlightCurrentSentence() {
    const old = document.querySelector('.ttsflow-highlight');
    if (old) old.classList.remove('ttsflow-highlight');

    const active = document.getElementById(`ttsflow-s-${currentIndex}`);
    if (active) {
      active.classList.add('ttsflow-highlight');
      if (settings.autoScroll) active.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  // Firefox will not always start speech on a document the user has not
  // touched. Offer one click target instead of failing silently.
  function requireUserGesture(message) {
    isPlaying = false;
    activeEngine().stop();
    setPlayPauseIcon();

    if (!overlay) {
      toast(`TTSFlow: ${message} Click the page, then press play.`);
      return;
    }
    if (dismissGesturePrompt) return;

    const prompt = document.createElement('div');
    prompt.id = 'ttsflow-gesture';

    const line = document.createElement('p');
    line.textContent = message;

    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'ttsflow-gesture-btn';
    button.textContent = 'Click to continue reading';

    prompt.append(line, button);

    const onClick = () => {
      if (dismissGesturePrompt) dismissGesturePrompt();
      if (!isPlaying) {
        isPlaying = true;
        setPlayPauseIcon();
        playCurrentSentence();
      }
    };

    dismissGesturePrompt = () => {
      dismissGesturePrompt = null;
      prompt.remove();
      if (overlay) overlay.removeEventListener('click', onClick);
    };

    button.addEventListener('click', onClick);
    overlay.addEventListener('click', onClick);
    overlay.appendChild(prompt);
    button.focus();
  }

  /* ---------------------------------------------------------------------
     Chapter navigation
     --------------------------------------------------------------------- */

  function findNextChapterUrl() {
    const explicit = document.querySelector(
      'a[rel="next"], link[rel="next"], a[data-vt-direction="next"]'
    );
    if (explicit && explicit.href) return explicit.href;

    const link = Array.from(document.querySelectorAll('a')).find((el) => {
      if (!el.href) return false;
      const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (!text || text.length > 20) return false;
      return text === 'next' || text === 'next >' || text.includes('next chapter');
    });
    if (link) return link.href;

    return predictNextChapterUrl();
  }

  // Last resort for sites whose "next" is a script-driven button.
  function predictNextChapterUrl() {
    // Royal Road chapter ids are database ids, not sequential per fiction,
    // so incrementing one lands on an unrelated story.
    if (/(^|\.)royalroad\.com$/.test(window.location.hostname)) return null;

    const url = new URL(window.location.href);

    for (const key of ['page', 'chapter', 'ch']) {
      const value = url.searchParams.get(key);
      if (value && /^\d+$/.test(value)) {
        url.searchParams.set(key, String(parseInt(value, 10) + 1));
        return url.href;
      }
    }

    // The number must be the last path segment and be introduced by a
    // chapter-ish word; guessing from a bare trailing number sends the
    // reader to an unrelated page.
    const match = url.pathname.match(/^(.*?)(\d+)\/?$/);
    if (match) {
      const prefix = match[1];
      if (/(chapter|chap|ch|part|page|vol|volume|episode|ep)[-_/]?$/i.test(prefix)) {
        const trailingSlash = url.pathname.endsWith('/') ? '/' : '';
        url.pathname = prefix + (parseInt(match[2], 10) + 1) + trailingSlash;
        return url.href;
      }
    }

    return null;
  }

  async function goToNextChapter() {
    if (!settings.autoAdvance) {
      toast('TTSFlow: end of chapter.');
      isPlaying = false;
      setPlayPauseIcon();
      savePosition();
      bg('TTSFLOW_RELEASE_SELF');
      return;
    }

    const targetUrl = findNextChapterUrl();

    if (!targetUrl || targetUrl === window.location.href) {
      toast('TTSFlow: reached the latest chapter. No "Next" link found.');
      isPlaying = false;
      setPlayPauseIcon();
      bg('TTSFLOW_RELEASE_SELF');
      return;
    }

    if (textContainer) {
      textContainer.textContent = '';
      textContainer.appendChild(el('div', { className: 'ttsflow-spinner' }));
    }

    // Hand the reader to the page about to load in this tab, and only it.
    // Await the token: navigating first would kill the message in flight.
    const armed = await bg('TTSFLOW_ARM_RESUME');
    if (!armed.ok) {
      toast('TTSFlow: could not continue to the next chapter.');
      isPlaying = false;
      return;
    }

    handingOffToNextChapter = true;
    activeEngine().stop();
    window.location.href = targetUrl;
  }

  /* ---------------------------------------------------------------------
     Teardown
     --------------------------------------------------------------------- */

  function closeTTSFlow() {
    isPlaying = false;
    if (nativeEngine) nativeEngine.destroy();
    if (piperEngine) piperEngine.destroy();
    if (dismissGesturePrompt) dismissGesturePrompt();
    if (voicePanel) voicePanel.destroy();
    voicePanel = null;

    if (overlay) {
      overlay.remove();
      overlay = null;
      textContainer = null;
      document.body.style.overflow = previousBodyOverflow;
    }

    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('pagehide', onPageHide);

    closeSession();
    bg('TTSFLOW_RELEASE_SELF');
  }

  // Speech outlives the document, so an abandoned tab would keep talking.
  function onPageHide() {
    isPlaying = false;
    if (nativeEngine) nativeEngine.stop();
    if (piperEngine) piperEngine.stop();
    savePosition();
    if (!handingOffToNextChapter) {
      closeSession();
      bg('TTSFLOW_RELEASE_SELF');
    }
  }

  /* ---------------------------------------------------------------------
     Messages
     --------------------------------------------------------------------- */

  browser.runtime.onMessage.addListener((request) => {
    if (!request || typeof request.action !== 'string') return false;

    switch (request.action) {
      case 'START_TTSFLOW':
        startTTSFlow({ resumePosition: true });
        return Promise.resolve({ ok: true });

      case 'STOP_TTSFLOW':
      case 'TTSFLOW_RELEASE': // another tab took the reader
        closeTTSFlow();
        return Promise.resolve({ ok: true });

      case 'TTSFLOW_PING':
        return Promise.resolve({
          ok: true,
          running: !!document.getElementById('ttsflow-overlay')
        });

      case 'TTSFLOW_PIPER_PROGRESS':
        if (voicePanel) voicePanel.handleProgress(request.voiceId, request.loaded, request.total);
        return false;

      case 'TTSFLOW_PIPER_ENDED':
      case 'TTSFLOW_PIPER_ERROR':
        if (piperEngine) piperEngine.handleBackgroundMessage(request);
        return false;

      default:
        return false;
    }
  });

  /* ---------------------------------------------------------------------
     Chapter handoff — resumes only against a one-shot token issued to this
     tab for this navigation. No token, no autostart.
     --------------------------------------------------------------------- */

  async function maybeResume() {
    const { resume } = await bg('TTSFLOW_CONSUME_RESUME');
    if (!resume) return;

    await loadSettings();

    // wtr-lab renders chapter text after load, so poll briefly rather than
    // betting on one fixed delay.
    const deadline = Date.now() + 10000;
    const attempt = () => {
      if (document.getElementById('ttsflow-overlay')) return;
      extractAndSegmentText(document);
      if (sentences.length > 0) startTTSFlow();
      else if (Date.now() < deadline) setTimeout(attempt, 500);
    };
    setTimeout(attempt, 300);
  }

  if (document.readyState === 'complete') maybeResume();
  else window.addEventListener('load', maybeResume, { once: true });
})();
