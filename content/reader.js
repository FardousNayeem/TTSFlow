/* =========================================================================
   TTSFlow reader.

   Reads the page in place. The chapter text is never copied out into an
   overlay: each sentence is a DOM Range over the page's own text nodes,
   highlighted with the CSS Custom Highlight API, so the site keeps its own
   typography, theme and reader preferences while the voice follows along.
   The controls live in a small dock on the right edge.

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

  // sentences[i] is what gets spoken; ranges[i] is where it sits on the page.
  let sentences = [];
  let ranges = [];
  let blocks = [];
  let currentIndex = 0;
  let isPlaying = false;
  let dock = null;

  let nativeEngine = null;
  let piperEngine = null;
  let voicePanel = null;
  let sessionPort = null;

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
    settings.speed = Number.isFinite(speed) ? clampSpeed(speed) : 1.0;
    const pitch = parseFloat(stored.pitch);
    settings.pitch = Number.isFinite(pitch) ? Math.min(1.4, Math.max(0.7, pitch)) : 1.0;
    settings.engine = stored.engine === 'piper' ? 'piper' : 'native';
    settings.voiceName = typeof stored.voiceName === 'string' ? stored.voiceName : '';
    settings.voiceId = typeof stored.voiceId === 'string' ? stored.voiceId : '';

    for (const key of ['autoAdvance', 'resumePosition', 'autoScroll']) {
      if (typeof stored[key] === 'boolean') settings[key] = stored[key];
    }
  }

  // Two decimals, not one: rounding to tenths turned the 1.25× preset into
  // 1.3× and left no preset marked as selected.
  function clampSpeed(value) {
    return Math.round(Math.min(2.5, Math.max(0.5, value)) * 100) / 100;
  }

  function formatSpeed(value) {
    const text = value.toFixed(2).replace(/0$/, '');
    return `${text}×`;
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
      settings.speed = clampSpeed(parseFloat(settings.speed) || 1);
      renderSpeed();
      if (isPlaying) activeEngine().setRate(settings.speed);
    }

    // A voice picked on the options page has to reach the dock's own
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
      positions[positionKey()] = {
        index: currentIndex,
        text: (sentences[currentIndex] || '').slice(0, 200),
        at: Date.now()
      };

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
      if (!entry || !(entry.index > 0)) return 0;
      // Check the sentence is still the one saved. An edited chapter, or a
      // change in how the page is split into sentences, shifts every index.
      if (entry.text) {
        const matches = (i) => sentences[i] && sentences[i].slice(0, 200) === entry.text;
        if (matches(entry.index)) return entry.index;
        for (let d = 1; d < sentences.length; d++) {
          if (matches(entry.index - d)) return entry.index - d;
          if (matches(entry.index + d)) return entry.index + d;
        }
      }
      if (entry.index < sentences.length) return entry.index;
    } catch (e) {
      /* best effort */
    }
    return 0;
  }

  /* ---------------------------------------------------------------------
     Text extraction — straight from the live page.

     Working on the rendered document rather than a copy of its markup
     means visibility is free: Royal Road plants an anti-copy paragraph in
     every chapter and hides it with a per-page class, and checkVisibility()
     drops it without the reader having to know the class.
     --------------------------------------------------------------------- */

  // Tried in order. querySelector with a comma-joined list returns the first
  // match in document order, not selector order, so a generic wrapper near
  // the top of the page would otherwise beat the real chapter container.
  const CONTENT_SELECTORS = [
    '.reader-container', '.chapter-inner', '.chapter-body', '.chapter-content',
    '#chapter-content', '#chapter-container', '.chapter-text', '.reader-content',
    '.entry-content', 'article'
  ];

  // A known container only counts if it actually holds prose; several sites
  // keep an empty `.chapter-content` shell around a script-rendered body.
  const MIN_CONTENT_CHARS = 200;

  const PARAGRAPH_SELECTOR = 'p, .paragraph, .wtr-line';

  // The nearest of these around a text node is the unit a sentence may not
  // cross; a sentence never runs from one paragraph into the next.
  const BLOCK_SELECTOR =
    'p, li, blockquote, pre, h1, h2, h3, h4, h5, h6, dd, dt, td, th, ' +
    'figcaption, .paragraph, .wtr-line, div, section, article, main';

  // RT and RP are ruby annotations: the reading aid above a word, not text
  // to speak a second time.
  const IGNORED_TAGS = new Set([
    'RT', 'RP', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'INPUT', 'SELECT',
    'BUTTON', 'IFRAME', 'svg', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'OBJECT'
  ]);

  const SKIP_CONTAINERS =
    '.ad-blocker-message, .wtr-ads, .ads-report-warning, .bottom-reader-nav, ' +
    '.nitropay-ad-placeholder, nav, header, footer, .btn, button, #ttsflow-dock';

  // `.portlet-body` used to be here, as the Royal Road comments wrapper. Royal
  // Road now nests the chapter itself inside a `.portlet-body`, so every
  // paragraph looked like the end of the chapter and nothing was ever read.
  const STOP_CONTAINERS =
    '.author-note-bottom, .author-note-portlet, .author-note, .comments-container, ' +
    '.chapter-nav, #comments';

  const STOP_PHRASES = [
    "if you're enjoying the story",
    'thanks for reading',
    "author's note",
    'royal road® is the home',
    'showing 1 to'
  ];

  const NAV_WORDS = ['next', 'next chapter', 'next >', 'previous', 'prev chapter'];

  function visibleTextLength(el) {
    return (el.innerText || '').replace(/\s+/g, ' ').trim().length;
  }

  function findContentArea(doc) {
    for (const selector of CONTENT_SELECTORS) {
      let best = null;
      let bestLength = 0;
      for (const candidate of doc.querySelectorAll(selector)) {
        const length = visibleTextLength(candidate);
        if (length > bestLength) {
          best = candidate;
          bestLength = length;
        }
      }
      if (best && bestLength >= MIN_CONTENT_CHARS) return best;
    }

    // Credit each paragraph to its ancestors, then take the deepest element
    // still holding essentially all the prose. Paragraphs are often wrapped
    // individually, so scoring only direct parents misses the real container.
    const scores = new Map();
    const depths = new Map();

    for (const el of doc.querySelectorAll(PARAGRAPH_SELECTOR)) {
      if (el.closest('#ttsflow-dock')) continue;
      const len = (el.innerText || '').trim().length;
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

  function isRendered(el) {
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({
        checkVisibilityCSS: true,
        visibilityProperty: true,
        checkOpacity: true,
        opacityProperty: true
      });
    }
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  // Groups the visible text nodes under `root` into blocks. Each block keeps
  // a flat string plus the text-node pieces it was built from, so a string
  // offset can be turned back into a DOM position.
  function collectBlocks(root) {
    const result = [];
    const blockOf = new Map();
    let current = null;

    const blockFor = (parent) => {
      if (blockOf.has(parent)) return blockOf.get(parent);
      let block = parent.closest(BLOCK_SELECTOR);
      if (!block || !root.contains(block)) block = root;
      blockOf.set(parent, block);
      return block;
    };

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
        if (IGNORED_TAGS.has(node.tagName)) return NodeFilter.FILTER_REJECT;
        if (node.matches(SKIP_CONTAINERS)) return NodeFilter.FILTER_REJECT;
        if (!isRendered(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        // A <br> ends a line visually but contributes no text of its own;
        // without a gap "Chapter 1<br>Title" would read as "Chapter 1Title".
        if (node.tagName === 'BR' && current) current.text += ' ';
        continue;
      }

      const value = node.nodeValue;
      if (!value) continue;
      const parent = node.parentElement;
      if (!parent) continue;

      const block = blockFor(parent);
      if (!current || current.el !== block) {
        current = { el: block, text: '', pieces: [] };
        result.push(current);
      }
      // Whitespace is flattened one character for one, so offsets into the
      // flat string still line up with offsets into the text node.
      const start = current.text.length;
      current.text += value.replace(/\s/g, ' ');
      current.pieces.push({ node, start, end: current.text.length });
    }

    return result.filter((b) => /[\p{L}\p{N}]/u.test(b.text));
  }

  // String offset within a block -> [textNode, offset]. Offsets that land in
  // a gap (a <br> space) snap forward for a start and back for an end.
  function locate(block, offset, isEnd) {
    const { pieces } = block;
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i];
      if (offset < piece.start) {
        if (isEnd && i > 0) return [pieces[i - 1].node, pieces[i - 1].node.nodeValue.length];
        return [piece.node, 0];
      }
      if (offset <= piece.end) return [piece.node, offset - piece.start];
    }
    const last = pieces[pieces.length - 1];
    return [last.node, last.node.nodeValue.length];
  }

  // A page's lang attribute is whatever its author typed ("english",
  // "en_US"), and an invalid tag makes the constructor throw, which used to
  // take the whole reader down on that site.
  function makeSegmenter() {
    if (typeof Intl === 'undefined' || !Intl.Segmenter) return null;
    for (const lang of [document.documentElement.lang, 'en']) {
      try {
        if (lang) return new Intl.Segmenter(lang, { granularity: 'sentence' });
      } catch (e) {
        /* try the next */
      }
    }
    return null;
  }

  const segmenter = makeSegmenter();

  // Intl.Segmenter ends a sentence at "Mr." and friends, which made the
  // voice stop dead between a title and a name.
  const ABBREVIATION = /\b(?:Mr|Mrs|Ms|Mx|Dr|Prof|St|Sr|Jr|Lt|Sgt|Capt|Gen|Col|Rev|vs|etc|No|Vol|Ch)\.\s*$/;

  function splitSentences(text) {
    let parts;
    if (segmenter) {
      parts = Array.from(segmenter.segment(text), (s) => ({ start: s.index, end: s.index + s.segment.length }));
    } else {
      parts = [];
      const re = /[^.!?]+(?:[.!?]+["'”’)\]]*|$)\s*/g;
      let match;
      while ((match = re.exec(text)) && match[0]) parts.push({ start: match.index, end: match.index + match[0].length });
    }

    const merged = [];
    for (const part of parts) {
      const previous = merged[merged.length - 1];
      if (previous && ABBREVIATION.test(text.slice(previous.start, previous.end))) previous.end = part.end;
      else merged.push({ ...part });
    }
    return merged;
  }

  function extractSentences(doc) {
    const root = findContentArea(doc);
    const nextSentences = [];
    const nextRanges = [];
    const nextBlocks = [];
    let started = false;

    for (const block of collectBlocks(root)) {
      const lower = block.text.replace(/\s+/g, ' ').trim().toLowerCase();
      const isBoundary =
        !!block.el.closest(STOP_CONTAINERS) ||
        NAV_WORDS.includes(lower) ||
        STOP_PHRASES.some((phrase) => lower.includes(phrase));

      if (isBoundary) {
        // These markers sit both above and below the chapter on Royal Road.
        // Above the story they are chrome to skip; below it they are the end.
        if (!started) continue;
        break;
      }

      for (const { start, end } of splitSentences(block.text)) {
        const raw = block.text.slice(start, end);
        const spoken = raw.replace(/\s+/g, ' ').trim();
        if (!/[\p{L}\p{N}]/u.test(spoken)) continue;

        const lead = raw.length - raw.trimStart().length;
        const trail = raw.length - raw.trimEnd().length;

        const range = document.createRange();
        try {
          range.setStart(...locate(block, start + lead, false));
          range.setEnd(...locate(block, end - trail, true));
        } catch (e) {
          continue;
        }

        started = true;
        nextSentences.push(spoken);
        nextRanges.push(range);
        nextBlocks.push(block.el);
      }
    }

    sentences = nextSentences;
    ranges = nextRanges;
    blocks = nextBlocks;
  }

  // Sites that re-render their chapter (wtr-lab, some SPA readers) leave the
  // old ranges pointing at detached nodes. Re-read the page and find the
  // same sentence again rather than stopping or jumping to the top.
  function refreshIfStale() {
    const range = ranges[currentIndex];
    if (range && range.startContainer.isConnected && range.endContainer.isConnected) return;

    const wanted = sentences[currentIndex];
    const oldIndex = currentIndex;
    extractSentences(document);
    if (!sentences.length) return;

    let best = -1;
    for (let i = 0; i < sentences.length; i++) {
      if (sentences[i] !== wanted) continue;
      if (best === -1 || Math.abs(i - oldIndex) < Math.abs(best - oldIndex)) best = i;
    }
    currentIndex = best >= 0 ? best : Math.min(oldIndex, sentences.length - 1);
  }

  /* ---------------------------------------------------------------------
     Highlighting and following
     --------------------------------------------------------------------- */

  const HIGHLIGHT = 'ttsflow-current';
  let highlightApi = typeof Highlight === 'function' && !!(globalThis.CSS && CSS.highlights);
  let fallbackBlock = null;

  function paintHighlight() {
    clearHighlight();
    const range = ranges[currentIndex];
    if (!range) return;

    if (highlightApi) {
      try {
        CSS.highlights.set(HIGHLIGHT, new Highlight(range));
        return;
      } catch (e) {
        highlightApi = false;
      }
    }
    // Without the Highlight API, mark the paragraph rather than splitting
    // the site's text nodes into spans it never asked for.
    fallbackBlock = blocks[currentIndex] || null;
    if (fallbackBlock) fallbackBlock.classList.add('ttsflow-block-active');
  }

  function clearHighlight() {
    if (highlightApi) {
      try {
        CSS.highlights.delete(HIGHLIGHT);
      } catch (e) {
        /* nothing registered */
      }
    }
    if (fallbackBlock) {
      fallbackBlock.classList.remove('ttsflow-block-active');
      fallbackBlock = null;
    }
  }

  // The page only follows the voice while you leave it alone. Scrolling back
  // to reread something should not be yanked away by the next sentence.
  const FOLLOW_PAUSE_MS = 6000;
  let userScrolledAt = 0;
  const noteUserScroll = () => {
    userScrolledAt = Date.now();
  };
  const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown']);
  const noteScrollKey = (e) => {
    if (SCROLL_KEYS.has(e.key)) noteUserScroll();
  };

  function prefersReducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function followSentence() {
    if (!settings.autoScroll) return;
    if (Date.now() - userScrolledAt < FOLLOW_PAUSE_MS) return;
    const range = ranges[currentIndex];
    if (!range) return;

    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) return;

    const vh = window.innerHeight;
    if (rect.top >= vh * 0.18 && rect.bottom <= vh * 0.72) return;

    const behavior = prefersReducedMotion() ? 'auto' : 'smooth';
    const scroller = document.scrollingElement;
    if (scroller && scroller.scrollHeight > scroller.clientHeight + 1) {
      window.scrollBy({ top: rect.top - vh * 0.36, behavior });
    } else {
      // The chapter scrolls inside its own container rather than the page.
      const anchor = range.startContainer.parentElement;
      if (anchor) anchor.scrollIntoView({ block: 'center', behavior });
    }
  }

  function sentenceAtPoint(x, y) {
    let node = null;
    let offset = 0;
    if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(x, y);
      if (pos) {
        node = pos.offsetNode;
        offset = pos.offset;
      }
    } else if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      if (r) {
        node = r.startContainer;
        offset = r.startOffset;
      }
    }
    if (!node || node.nodeType !== Node.TEXT_NODE) return -1;

    for (let i = 0; i < ranges.length; i++) {
      try {
        if (ranges[i].isPointInRange(node, offset)) return i;
      } catch (e) {
        /* range from a detached node */
      }
    }
    return -1;
  }

  // Click a sentence on the page to jump there. Links, form controls and
  // text selection keep their normal meaning.
  function onPageClick(e) {
    if (!dock || e.button !== 0 || e.defaultPrevented) return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (target.closest('#ttsflow-dock, #ttsflow-gesture, a, button, input, textarea, select, label, summary, [contenteditable=""], [contenteditable="true"]')) return;

    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;

    const index = sentenceAtPoint(e.clientX, e.clientY);
    if (index < 0) return;

    currentIndex = index;
    isPlaying = true;
    setPlayPauseIcon();
    highlightCurrentSentence({ follow: false });
    claimReader().then(() => playCurrentSentence());
  }

  /* ---------------------------------------------------------------------
     Notices
     --------------------------------------------------------------------- */

  // Small DOM helper: builds elements without ever assigning innerHTML.
  function el(tag, props = {}) {
    return Object.assign(document.createElement(tag), props);
  }

  // One at a time: several toasts used to pile up in the same spot.
  let toastEl = null;
  let toastTimer = null;

  function toast(message) {
    if (toastEl) toastEl.remove();
    clearTimeout(toastTimer);
    toastEl = el('div', { className: 'ttsflow-toast', textContent: message });
    toastEl.setAttribute('role', 'status');
    document.body.appendChild(toastEl);
    toastTimer = setTimeout(() => {
      if (toastEl) toastEl.remove();
      toastEl = null;
    }, 4500);
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

  // voiceName is shared by both engines, so after a neural voice it holds
  // that voice's name ("Amy"), which no system voice answers to.
  function ensureSystemVoiceName(voices) {
    if (!voices.length || voices.some((v) => v.name === settings.voiceName)) return;
    const preferred =
      voices.find((v) => v.default && v.lang.startsWith('en')) ||
      voices.find((v) => v.lang.startsWith('en')) ||
      voices[0];
    settings.voiceName = preferred.name;
  }

  function switchEngine(id) {
    const previous = activeEngine();
    if (previous) previous.stop();
    settings.engine = id;
    if (id === 'native') ensureSystemVoiceName(nativeEngine.synth.getVoices());
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

  /* ---------------------------------------------------------------------
     Reader lock. Tracked here so every way of starting sound takes it:
     clicking a sentence after the end of a chapter, or after Back restored
     this page, used to play without it, and the handoff to the next
     chapter was then refused because this tab no longer owned the reader.
     --------------------------------------------------------------------- */

  let ownsReader = false;

  async function claimReader() {
    if (ownsReader) return true;
    const reply = await bg('TTSFLOW_CLAIM');
    ownsReader = !!reply.ok;
    return ownsReader;
  }

  function releaseReader() {
    ownsReader = false;
    bg('TTSFLOW_RELEASE_SELF');
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

  let starting = false;

  // Two quick Start clicks both used to get past the dock check while the
  // first was still waiting on voices, and built two sets of engines.
  async function startTTSFlow(options) {
    if (dock || starting) return;
    starting = true;
    try {
      await start(options);
    } finally {
      starting = false;
    }
  }

  async function start({ resumePosition = false } = {}) {
    await loadSettings();

    extractSentences(document);
    if (sentences.length === 0) {
      toast('TTSFlow: could not find readable text on this page.');
      return;
    }

    if (!(await claimReader())) {
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

    if (settings.engine === 'piper' && !settings.voiceId) settings.engine = 'native';
    if (settings.engine === 'native') ensureSystemVoiceName(systemVoices);

    openSession();
    await buildDock(systemVoices);

    if (resumePosition && settings.resumePosition) {
      const saved = await loadPosition();
      if (saved) {
        currentIndex = saved;
        toast(`TTSFlow: resuming at sentence ${saved + 1}.`);
      }
    }

    isPlaying = true;
    setPlayPauseIcon();
    highlightCurrentSentence();
    playCurrentSentence();
  }

  /* ---------------------------------------------------------------------
     Dock

     A slim column on the right edge rather than a bar across the page: the
     chapter column stays clear, and the dock fades back while you listen.
     Below 720px wide it becomes a pill along the bottom instead.
     --------------------------------------------------------------------- */

  const IDLE_MS = 2600;
  let idleTimer = null;
  let speedPanel = null;
  let speedRoot = null;
  let dockPointerInside = false;

  function iconButton(id, iconName, label, size = 18) {
    const button = el('button', { id, type: 'button', className: 'ttsflow-dock-btn', title: label });
    button.setAttribute('aria-label', label);
    button.appendChild(NS.icon(iconName, { size }));
    return button;
  }

  // Keep in step with the media query in styles.css.
  const HORIZONTAL_QUERY = '(max-width: 720px), (max-height: 420px)';

  function isHorizontal() {
    return window.matchMedia(HORIZONTAL_QUERY).matches;
  }

  // A position saved on a tall window can put the dock partly off a
  // shorter one.
  function clampDock() {
    if (!dock || isHorizontal()) return;
    const raw = parseFloat(dock.style.getPropertyValue('--ttsflow-dock-y'));
    if (!Number.isFinite(raw)) return;
    const half = dock.offsetHeight / 2;
    const vh = window.innerHeight;
    const y = Math.min(vh - half - 8, Math.max(half + 8, (raw / 100) * vh));
    dock.style.setProperty('--ttsflow-dock-y', `${((y / vh) * 100).toFixed(2)}%`);
  }

  async function buildDock(systemVoices) {
    dock = el('div', { id: 'ttsflow-dock' });
    dock.setAttribute('role', 'toolbar');
    dock.setAttribute('aria-label', 'TTSFlow reader');

    const grip = el('button', { id: 'ttsflow-grip', type: 'button', title: 'Drag to move' });
    grip.setAttribute('aria-label', 'Move the reader controls');
    const logo = el('img', { id: 'ttsflow-logo', alt: '' });
    logo.src = browser.runtime.getURL('icon-48.png');
    grip.appendChild(logo);

    const prev = iconButton('ttsflow-prev', 'prev', 'Previous sentence', 16);
    const play = iconButton('ttsflow-playpause', 'pause', 'Pause', 20);
    play.classList.add('is-primary');
    const next = iconButton('ttsflow-next', 'next', 'Next sentence', 16);
    const transport = el('div', { className: 'ttsflow-transport' });
    transport.append(prev, play, next);

    const progress = el('span', { id: 'ttsflow-progress-text' });
    progress.setAttribute('aria-live', 'off');

    /* --- speed --- */
    speedRoot = el('div', { id: 'ttsflow-speed' });
    const speedButton = el('button', { id: 'ttsflow-speed-button', type: 'button', className: 'ttsflow-dock-btn' });
    speedButton.setAttribute('aria-haspopup', 'dialog');
    speedButton.setAttribute('aria-expanded', 'false');
    speedButton.appendChild(el('span', { id: 'ttsflow-speed-val' }));

    speedPanel = el('div', { id: 'ttsflow-speed-panel', className: 'ttsflow-popover' });
    speedPanel.setAttribute('role', 'dialog');
    speedPanel.setAttribute('aria-label', 'Reading speed');
    speedPanel.hidden = true;

    const speedHead = el('div', { className: 'ttsflow-speed-head' });
    speedHead.append(
      el('span', { textContent: 'Speed' }),
      el('output', { id: 'ttsflow-speed-readout' })
    );
    const slider = el('input', { id: 'ttsflow-speed-slider', type: 'range' });
    slider.min = '0.5';
    slider.max = '2.5';
    slider.step = '0.05';
    slider.setAttribute('aria-label', 'Reading speed');

    const presets = el('div', { className: 'ttsflow-speed-presets' });
    for (const value of [0.8, 1, 1.25, 1.5, 2]) {
      const chip = el('button', { type: 'button', className: 'ttsflow-chip', textContent: formatSpeed(value) });
      chip.dataset.speed = String(value);
      presets.appendChild(chip);
    }
    speedPanel.append(speedHead, slider, presets);
    speedRoot.append(speedButton, speedPanel);

    /* --- voice --- */
    const voiceSlot = el('div', { id: 'ttsflow-voice-slot' });

    const close = iconButton('ttsflow-close', 'close', 'Close reader', 17);

    const line = el('div', { id: 'ttsflow-progress-line' });
    line.appendChild(el('div'));

    dock.append(
      grip,
      transport,
      progress,
      el('div', { className: 'ttsflow-dock-sep' }),
      speedRoot,
      voiceSlot,
      el('div', { className: 'ttsflow-dock-sep' }),
      close,
      line
    );

    await restoreDockPosition();
    document.body.appendChild(dock);
    clampDock();

    voicePanel = new NS.VoicePanel({
      compact: true,
      onSelect: (selection) => {
        settings.engine = selection.engine;
        settings.voiceName = selection.voiceName;
        settings.voiceId = selection.voiceId;
        saveSettings();
        if (isPlaying) playCurrentSentence();
      },
      onOpen: (panel) => {
        closeSpeedPanel();
        placePopover(panel);
        wakeDock();
      },
      onNotice: toast
    });
    voicePanel.mount(voiceSlot);
    voicePanel.setSystemVoices(systemVoices.map((v) => ({ name: v.name, lang: v.lang })));
    voicePanel.setSelection({
      engine: settings.engine,
      voiceName: settings.voiceName,
      voiceId: settings.voiceId
    });

    renderSpeed();
    renderProgress();
    attachEventListeners();
    wakeDock();
  }

  function renderSpeed() {
    const text = formatSpeed(settings.speed);
    const val = document.getElementById('ttsflow-speed-val');
    const readout = document.getElementById('ttsflow-speed-readout');
    const slider = document.getElementById('ttsflow-speed-slider');
    const button = document.getElementById('ttsflow-speed-button');
    if (val) val.textContent = text;
    if (readout) readout.textContent = text;
    if (slider) slider.value = String(settings.speed);
    if (button) {
      button.title = `Speed ${text}`;
      button.setAttribute('aria-label', `Reading speed ${text}`);
    }
    if (speedPanel) {
      for (const chip of speedPanel.querySelectorAll('.ttsflow-chip')) {
        chip.classList.toggle('is-active', Math.abs(parseFloat(chip.dataset.speed) - settings.speed) < 0.001);
      }
    }
  }

  function renderProgress() {
    if (!dock) return;
    const total = sentences.length || 1;
    const ratio = sentences.length ? (currentIndex + 1) / total : 0;
    dock.style.setProperty('--ttsflow-progress', String(ratio));
    // The readout says what the reader is doing, not only where it is: the
    // dock fades while playing, so a glance should tell paused from playing.
    const text = document.getElementById('ttsflow-progress-text');
    if (text) {
      const percent = `${Math.round(ratio * 100)}%`;
      let state = percent;
      if (dock.classList.contains('is-loading')) state = 'Next';
      else if (!isPlaying) state = 'Paused';
      text.textContent = state;
      text.classList.toggle('is-state', state !== percent);
      text.title = `Sentence ${currentIndex + 1} of ${sentences.length} (${percent})`;
    }
  }

  function setPlayPauseIcon() {
    const btn = document.getElementById('ttsflow-playpause');
    if (!btn) return;
    btn.textContent = '';
    btn.appendChild(NS.icon(isPlaying ? 'pause' : 'play', { size: 20 }));
    btn.title = isPlaying ? 'Pause' : 'Play';
    btn.setAttribute('aria-label', btn.title);
    if (dock) dock.classList.toggle('is-paused', !isPlaying);
    renderProgress();
    wakeDock();
  }

  /* --- popovers --- */

  // Popovers open beside the dock; nudge one back inside the viewport when
  // the dock has been dragged near an edge.
  function placePopover(panel) {
    panel.style.setProperty('--ttsflow-dx', '0px');
    panel.style.setProperty('--ttsflow-dy', '0px');
    const rect = panel.getBoundingClientRect();
    const margin = 10;
    let dx = 0;
    let dy = 0;
    if (rect.top < margin) dy = margin - rect.top;
    else if (rect.bottom > window.innerHeight - margin) dy = window.innerHeight - margin - rect.bottom;
    if (rect.left < margin) dx = margin - rect.left;
    else if (rect.right > window.innerWidth - margin) dx = window.innerWidth - margin - rect.right;
    panel.style.setProperty('--ttsflow-dx', `${Math.round(dx)}px`);
    panel.style.setProperty('--ttsflow-dy', `${Math.round(dy)}px`);
  }

  function openSpeedPanel() {
    if (voicePanel) voicePanel.close();
    speedPanel.hidden = false;
    document.getElementById('ttsflow-speed-button').setAttribute('aria-expanded', 'true');
    placePopover(speedPanel);
    document.getElementById('ttsflow-speed-slider').focus();
    wakeDock();
  }

  function closeSpeedPanel() {
    if (!speedPanel || speedPanel.hidden) return;
    speedPanel.hidden = true;
    const button = document.getElementById('ttsflow-speed-button');
    if (button) button.setAttribute('aria-expanded', 'false');
    scheduleIdle();
  }

  function anyPopoverOpen() {
    return (speedPanel && !speedPanel.hidden) || (voicePanel && voicePanel.open);
  }

  /* --- idle fade --- */

  function wakeDock() {
    if (!dock) return;
    dock.classList.remove('is-idle');
    scheduleIdle();
  }

  function scheduleIdle() {
    clearTimeout(idleTimer);
    if (!dock) return;
    idleTimer = setTimeout(() => {
      if (!dock || !isPlaying || dockPointerInside) return;
      // Check again later rather than giving up: nothing else re-arms the
      // fade when a popover closes by an outside click. Only keyboard focus
      // holds the dock awake; a clicked button keeps focus too, and used to
      // stop the dock from ever fading again.
      if (anyPopoverOpen() || dock.querySelector(':focus-visible')) {
        scheduleIdle();
        return;
      }
      dock.classList.add('is-idle');
    }, IDLE_MS);
  }

  /* --- dragging --- */

  async function restoreDockPosition() {
    try {
      const { dockY } = await browser.storage.local.get('dockY');
      if (typeof dockY === 'number' && dockY >= 0 && dockY <= 1) {
        dock.style.setProperty('--ttsflow-dock-y', `${(dockY * 100).toFixed(2)}%`);
      }
    } catch (e) {
      /* default position */
    }
  }

  function wireDrag(grip) {
    let dragging = false;
    let moved = false;
    let startY = 0;

    grip.addEventListener('pointerdown', (e) => {
      if (isHorizontal() || e.button !== 0) return;
      dragging = true;
      moved = false;
      startY = e.clientY;
      grip.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    grip.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      if (!moved && Math.abs(e.clientY - startY) < 3) return;
      moved = true;
      dock.classList.add('is-dragging');
      closeSpeedPanel();
      if (voicePanel) voicePanel.close();

      const half = dock.offsetHeight / 2;
      const y = Math.min(window.innerHeight - half - 8, Math.max(half + 8, e.clientY));
      dock.style.setProperty('--ttsflow-dock-y', `${((y / window.innerHeight) * 100).toFixed(2)}%`);
    });

    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      dock.classList.remove('is-dragging');
      if (grip.hasPointerCapture(e.pointerId)) grip.releasePointerCapture(e.pointerId);
      if (!moved) return;
      const value = parseFloat(dock.style.getPropertyValue('--ttsflow-dock-y')) / 100;
      if (Number.isFinite(value)) {
        try {
          browser.storage.local.set({ dockY: value });
        } catch (err) {
          /* best effort */
        }
      }
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);

    // Keyboard users move it too.
    grip.addEventListener('keydown', (e) => {
      if (isHorizontal() || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = dock.getBoundingClientRect();
      const centre = rect.top + rect.height / 2 + (e.key === 'ArrowUp' ? -24 : 24);
      const half = rect.height / 2;
      const y = Math.min(window.innerHeight - half - 8, Math.max(half + 8, centre));
      const value = y / window.innerHeight;
      dock.style.setProperty('--ttsflow-dock-y', `${(value * 100).toFixed(2)}%`);
      try {
        browser.storage.local.set({ dockY: value });
      } catch (err) {
        /* best effort */
      }
    });
  }

  function onOutsideClick(e) {
    if (speedRoot && !speedRoot.contains(e.target)) closeSpeedPanel();
  }

  function attachEventListeners() {
    // Dragging fires oninput continuously. Piper only has to change a
    // playbackRate, so it tracks live; the system engine can only change
    // speed by re-speaking the sentence, so that waits until the drag
    // settles. Saving is debounced too, instead of a storage write per pixel.
    let rateTimer = null;
    const applySpeed = (value, { immediate = false } = {}) => {
      settings.speed = clampSpeed(value);
      renderSpeed();

      const target = activeEngine();
      if (target.id === 'piper') target.setRate(settings.speed);

      clearTimeout(rateTimer);
      rateTimer = setTimeout(
        () => {
          saveSettings();
          if (activeEngine().id === 'native' && isPlaying) {
            activeEngine().setRate(settings.speed);
          }
        },
        immediate ? 0 : 300
      );
    };

    document.getElementById('ttsflow-speed-slider').oninput = (e) => applySpeed(parseFloat(e.target.value));

    for (const chip of speedPanel.querySelectorAll('.ttsflow-chip')) {
      chip.onclick = () => applySpeed(parseFloat(chip.dataset.speed), { immediate: true });
    }

    const speedButton = document.getElementById('ttsflow-speed-button');
    speedButton.onclick = () => (speedPanel.hidden ? openSpeedPanel() : closeSpeedPanel());
    // A wheel over the speed readout nudges it without opening anything.
    speedButton.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        applySpeed(settings.speed + (e.deltaY < 0 ? 0.1 : -0.1));
      },
      { passive: false }
    );

    speedPanel.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      closeSpeedPanel();
      speedButton.focus();
    });

    document.getElementById('ttsflow-close').onclick = closeTTSFlow;
    document.getElementById('ttsflow-next').onclick = () => nudge(1);
    document.getElementById('ttsflow-prev').onclick = () => nudge(-1);
    document.getElementById('ttsflow-playpause').onclick = togglePlayPause;

    wireDrag(document.getElementById('ttsflow-grip'));

    dock.addEventListener('pointerenter', () => {
      dockPointerInside = true;
      wakeDock();
    });
    dock.addEventListener('pointerleave', () => {
      dockPointerInside = false;
      scheduleIdle();
    });
    dock.addEventListener('focusin', wakeDock);
    dock.addEventListener('focusout', scheduleIdle);

    document.addEventListener('click', onOutsideClick, true);
    document.addEventListener('click', onPageClick);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('wheel', noteUserScroll, { passive: true });
    window.addEventListener('touchmove', noteUserScroll, { passive: true });
    window.addEventListener('keydown', noteScrollKey, { passive: true });
    window.addEventListener('resize', onResize);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
  }

  function onResize() {
    clampDock();
    if (speedPanel && !speedPanel.hidden) placePopover(speedPanel);
    if (voicePanel && voicePanel.open) placePopover(voicePanel.panel);
  }

  function onKeyDown(e) {
    if (!dock) return;
    const target = e.target;
    if (target && (/^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName) || target.isContentEditable)) return;
    // Space and Enter on a focused dock button already press that button.
    if ((e.key === ' ' || e.key === 'Enter') && target instanceof Element && target.closest('#ttsflow-dock')) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      // The first Escape closes an open popover, wherever focus is.
      if (anyPopoverOpen()) {
        closeSpeedPanel();
        if (voicePanel) voicePanel.close();
        return;
      }
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

    // resume() only revives a *paused* engine. An engine that was stopped
    // (end of chapter, a blocked start) has also handed back the reader
    // lock, so take it again before making any sound.
    const target = activeEngine();
    if (!target.paused) await claimReader();
    if (target.paused) target.resume();
    else playCurrentSentence();
  }

  /* ---------------------------------------------------------------------
     Playback
     --------------------------------------------------------------------- */

  function playCurrentSentence() {
    if (!isPlaying) return;
    refreshIfStale();
    const text = sentences[currentIndex];
    if (!text) return;

    if (dismissGesturePrompt) dismissGesturePrompt();
    highlightCurrentSentence();

    const target = activeEngine();
    // Stop whichever engine is not in use, so switching mid-sentence does
    // not leave two voices talking over each other.
    const other = target === nativeEngine ? piperEngine : nativeEngine;
    if (other) other.stop();

    target.speak(text, speakOptions());
  }

  function moveSentence(step) {
    currentIndex = Math.min(Math.max(currentIndex + step, 0), sentences.length - 1);
    // Stepping by hand is a request to see the sentence, whatever the
    // recent scrolling.
    userScrolledAt = 0;
    highlightCurrentSentence();
  }

  function highlightCurrentSentence({ follow = true } = {}) {
    paintHighlight();
    renderProgress();
    if (follow) followSentence();
  }

  // Firefox will not always start speech on a document the user has not
  // touched. Offer one click target instead of failing silently.
  function requireUserGesture(message) {
    isPlaying = false;
    activeEngine().stop();
    setPlayPauseIcon();

    if (!dock) {
      toast(`TTSFlow: ${message} Click the page, then press play.`);
      return;
    }
    if (dismissGesturePrompt) return;

    const prompt = el('div', { id: 'ttsflow-gesture' });
    prompt.setAttribute('role', 'alertdialog');
    prompt.setAttribute('aria-label', 'TTSFlow');

    const line = el('p', { textContent: message });
    const button = el('button', {
      type: 'button',
      id: 'ttsflow-gesture-btn',
      textContent: 'Continue reading'
    });

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
    };

    button.addEventListener('click', onClick);
    document.body.appendChild(prompt);
    button.focus();
  }

  /* ---------------------------------------------------------------------
     Chapter navigation
     --------------------------------------------------------------------- */

  // A "next" that is "#" or "javascript:" is a script-driven button.
  // Following one either did nothing or stayed on this document with the
  // handoff armed, and reading stalled with the dock showing "Next".
  function isNavigableChapterUrl(href) {
    let url;
    try {
      url = new URL(href, window.location.href);
    } catch (e) {
      return false;
    }
    if (!/^https?:$/.test(url.protocol)) return false;
    const here = new URL(window.location.href);
    url.hash = '';
    here.hash = '';
    return url.href !== here.href;
  }

  function findNextChapterUrl() {
    for (const explicit of document.querySelectorAll(
      'link[rel="next"], a[rel="next"], a[data-vt-direction="next"]'
    )) {
      if (explicit.href && isNavigableChapterUrl(explicit.href)) return explicit.href;
    }

    const link = Array.from(document.querySelectorAll('a')).find((a) => {
      if (!a.href || a.closest('#ttsflow-dock')) return false;
      if (!isNavigableChapterUrl(a.href)) return false;
      const text = (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
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

  function endOfReading(message) {
    toast(message);
    isPlaying = false;
    setPlayPauseIcon();
    savePosition();
    releaseReader();
  }

  async function goToNextChapter() {
    if (!settings.autoAdvance) {
      endOfReading('TTSFlow: end of chapter.');
      return;
    }

    const targetUrl = findNextChapterUrl();

    if (!targetUrl) {
      endOfReading('TTSFlow: reached the latest chapter. No "Next" link found.');
      return;
    }

    if (dock) dock.classList.add('is-loading');
    renderProgress();
    toast('TTSFlow: opening the next chapter…');

    // Hand the reader to the page about to load in this tab, and only it.
    // Await the token: navigating first would kill the message in flight.
    const armed = await bg('TTSFLOW_ARM_RESUME');
    if (!armed.ok) {
      if (dock) dock.classList.remove('is-loading');
      toast('TTSFlow: could not continue to the next chapter.');
      isPlaying = false;
      setPlayPauseIcon();
      return;
    }

    handingOffToNextChapter = true;
    try {
      sessionStorage.setItem(HANDOFF_KEY, '1');
    } catch (e) {
      /* the next page falls back to asking anyway */
    }
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
    clearTimeout(idleTimer);
    clearHighlight();

    if (dock) {
      dock.remove();
      dock = null;
      speedPanel = null;
      speedRoot = null;
      dockPointerInside = false;
    }

    document.removeEventListener('click', onOutsideClick, true);
    document.removeEventListener('click', onPageClick);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('wheel', noteUserScroll);
    window.removeEventListener('touchmove', noteUserScroll);
    window.removeEventListener('keydown', noteScrollKey);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('pageshow', onPageShow);

    closeSession();
    releaseReader();
  }

  // Speech outlives the document, so an abandoned tab would keep talking.
  function onPageHide() {
    isPlaying = false;
    if (nativeEngine) nativeEngine.stop();
    if (piperEngine) piperEngine.stop();
    savePosition();
    if (!handingOffToNextChapter) {
      closeSession();
      releaseReader();
    }
  }

  // Back or Forward can restore this page from the back-forward cache with
  // the dock still on it, but pagehide already stopped playback and closed
  // the session. Come back paused and reconnected, not as a dead dock.
  function onPageShow(e) {
    if (!e.persisted || !dock) return;
    handingOffToNextChapter = false;
    isPlaying = false;
    dock.classList.remove('is-loading');
    openSession();
    setPlayPauseIcon();
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
        return Promise.resolve({ ok: true, running: !!dock });

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

  // Asking the background wakes its event page, and this runs on every page
  // load in every tab. Ask only when a handoff is plausible: this tab left a
  // same-site note on its way here, or it arrived from another site, where
  // a note could not be read.
  const HANDOFF_KEY = 'ttsflow_handoff';

  function handoffPossible() {
    try {
      if (sessionStorage.getItem(HANDOFF_KEY)) {
        sessionStorage.removeItem(HANDOFF_KEY);
        return true;
      }
    } catch (e) {
      return true;
    }
    if (!document.referrer) return false;
    try {
      return new URL(document.referrer).origin !== window.location.origin;
    } catch (e) {
      return false;
    }
  }

  async function maybeResume() {
    if (!handoffPossible()) return;
    const { resume } = await bg('TTSFLOW_CONSUME_RESUME');
    if (!resume) return;

    await loadSettings();

    // wtr-lab renders chapter text after load, so poll briefly rather than
    // betting on one fixed delay.
    const deadline = Date.now() + 10000;
    const attempt = () => {
      if (dock) return;
      extractSentences(document);
      if (sentences.length > 0) startTTSFlow();
      else if (Date.now() < deadline) setTimeout(attempt, 500);
    };
    setTimeout(attempt, 300);
  }

  if (document.readyState === 'complete') maybeResume();
  else window.addEventListener('load', maybeResume, { once: true });

  // Test hook: lets the extraction be exercised against saved pages without
  // a browser extension around it. Harmless on real pages.
  if (globalThis.__TTSFLOW_TEST__) {
    globalThis.__TTSFLOW_TEST__.extract = () => {
      extractSentences(document);
      return { sentences: sentences.slice(), ranges: ranges.slice() };
    };
  }
})();
