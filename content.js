let sentences = [];
let currentIndex = 0;
let isPlaying = false;
let overlay, textContainer;
let currentUtterance = null;

let playbackRate = parseFloat(localStorage.getItem('ttsflow_speed')) || 1.0;
let savedVoiceName = localStorage.getItem('ttsflow_voice') || 'Microsoft Mark';
let currentNavContext = document; 

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "START_TTSFLOW") {
    initTTSFlow();
  }
});

function initTTSFlow() {
  if (document.getElementById('ttsflow-overlay')) return; 
  
  currentNavContext = document; 
  extractAndSegmentText(document);
  
  if (sentences.length === 0) {
    alert("TTSFlow: Could not find readable text on this page.");
    localStorage.removeItem('ttsflow_autoplay'); // Prevent reload loops
    return;
  }
  
  buildUI();
  isPlaying = true;
  highlightCurrentSentence();
  playCurrentSentence();
}

function extractAndSegmentText(docContext) {
  const contentArea = docContext.querySelector('.reader-container, .chapter-body, .chapter-content, .entry-content, #chapter-content, .reader-content, article') || docContext.body;
  const elements = contentArea.querySelectorAll('p, .paragraph, .wtr-line');
  let validParagraphs = [];
  
  for (let el of elements) {
    const text = el.innerText.trim();
    if (text.length < 5) continue; 
    
    // Explicitly SKIP injected ads and blocker messages without breaking the loop
    if (el.closest('.ad-blocker-message, .wtr-ads, .ads-report-warning, .bottom-reader-nav')) {
      continue; 
    }

    const lowerText = text.toLowerCase();
    if (el.closest('.author-note-bottom, .comments-container, .chapter-nav, .portlet-body')) break;

    if (
      lowerText.includes("if you're enjoying the story") || 
      lowerText.includes("thanks for reading") ||
      lowerText.includes("author's note") ||
      lowerText.includes("royal road® is the home") ||
      lowerText.startsWith("showing 1 to") ||
      lowerText === "next" ||
      lowerText === "next chapter" ||
      lowerText === "next >"
    ) {
      break; 
    }
    
    validParagraphs.push(text);
  }
  
  const fullText = validParagraphs.join(' ');
  const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
  const segments = segmenter.segment(fullText);
  sentences = Array.from(segments).map(s => s.segment.trim()).filter(s => s.length > 0);
  currentIndex = 0;
}

function buildUI() {
  overlay = document.createElement('div');
  overlay.id = 'ttsflow-overlay';
  
  const iconURL = chrome.runtime.getURL('icon-128.png');

  const navbar = document.createElement('div');
  navbar.id = 'ttsflow-navbar';
  navbar.innerHTML = `
    <img id="ttsflow-navbar-logo" src="${iconURL}" alt="Logo">
    <div id="ttsflow-controls">
      <button class="ttsflow-btn" id="ttsflow-prev">⏮</button>
      <button class="ttsflow-btn" id="ttsflow-playpause">⏸</button>
      <button class="ttsflow-btn" id="ttsflow-stop">⏹</button>
      <button class="ttsflow-btn" id="ttsflow-next">⏭</button>
    </div>
    <div id="ttsflow-speed-control">
      <label>Speed: <span id="ttsflow-speed-val">${playbackRate.toFixed(1)}</span>x</label>
      <input type="range" id="ttsflow-speed-slider" min="0.5" max="2.5" step="0.1" value="${playbackRate}">
    </div>
    <div>
      <select id="ttsflow-voice-select"><option>Loading voices...</option></select>
    </div>
    <button class="ttsflow-btn" id="ttsflow-close">✕</button>
  `;
  
  textContainer = document.createElement('div');
  textContainer.id = 'ttsflow-text-container';
  
  renderSentences();
  
  overlay.appendChild(navbar);
  overlay.appendChild(textContainer);
  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden'; 
  
  attachEventListeners();
  populateVoices(); 
}

function renderSentences() {
  textContainer.innerHTML = ''; 
  sentences.forEach((sentence, index) => {
    const span = document.createElement('span');
    span.id = `ttsflow-s-${index}`;
    span.className = 'ttsflow-sentence';
    span.innerText = sentence + ' ';
    
    span.onclick = () => {
      currentIndex = index;
      isPlaying = true;
      document.getElementById('ttsflow-playpause').innerText = "⏸";
      
      if (currentUtterance) currentUtterance.onend = null; 
      window.speechSynthesis.cancel();
      
      highlightCurrentSentence();
      playCurrentSentence();
    };
    
    textContainer.appendChild(span);
  });
}

function populateVoices() {
  const voiceSelect = document.getElementById('ttsflow-voice-select');
  if (!voiceSelect) return;

  let voices = window.speechSynthesis.getVoices();
  
  if (voices.length === 0) {
    window.speechSynthesis.onvoiceschanged = populateVoices;
    return;
  }

  voiceSelect.innerHTML = ''; 
  
  let matchedVoice = voices.find(v => v.name === savedVoiceName) || 
                     voices.find(v => v.name.includes('Mark')) || 
                     voices[0];

  if (matchedVoice) savedVoiceName = matchedVoice.name;

  voices.forEach((voice) => {
    const option = document.createElement('option');
    option.value = voice.name; // Bind to absolute name to fix caching bugs
    option.textContent = `${voice.name} (${voice.lang})`;
    if (voice.name === savedVoiceName) option.selected = true;
    voiceSelect.appendChild(option);
  });

  voiceSelect.onchange = (e) => {
    savedVoiceName = e.target.value;
    localStorage.setItem('ttsflow_voice', savedVoiceName); 
    if (isPlaying) {
       if (currentUtterance) currentUtterance.onend = null;
       window.speechSynthesis.cancel();
       playCurrentSentence();
    }
  };
}

function attachEventListeners() {
  document.getElementById('ttsflow-speed-slider').oninput = (e) => {
    playbackRate = parseFloat(e.target.value);
    document.getElementById('ttsflow-speed-val').innerText = playbackRate.toFixed(1);
    localStorage.setItem('ttsflow_speed', playbackRate); 
    if (isPlaying) {
      if (currentUtterance) currentUtterance.onend = null;
      window.speechSynthesis.cancel();
      playCurrentSentence();
    }
  };

  document.getElementById('ttsflow-close').onclick = () => {
    if (currentUtterance) currentUtterance.onend = null;
    window.speechSynthesis.cancel();
    closeTTSFlow();
  };
  
  document.getElementById('ttsflow-next').onclick = () => {
    moveSentence(1);
    if (isPlaying) playCurrentSentence();
  };
  
  document.getElementById('ttsflow-prev').onclick = () => {
    moveSentence(-1);
    if (isPlaying) playCurrentSentence();
  };
  
  document.getElementById('ttsflow-stop').onclick = () => {
    isPlaying = false;
    localStorage.removeItem('ttsflow_autoplay'); // Clear flag
    document.getElementById('ttsflow-playpause').innerText = "▶"; 
    if (currentUtterance) currentUtterance.onend = null;
    window.speechSynthesis.cancel(); 
  };

  document.getElementById('ttsflow-playpause').onclick = () => {
    isPlaying = !isPlaying;
    if (isPlaying) {
      document.getElementById('ttsflow-playpause').innerText = "⏸"; 
      playCurrentSentence();
    } else {
      document.getElementById('ttsflow-playpause').innerText = "▶"; 
      window.speechSynthesis.pause(); 
    }
  };
}

function playCurrentSentence() {
  if (!isPlaying) return;
  const currentText = sentences[currentIndex];
  if (!currentText) return;

  if (currentUtterance) currentUtterance.onend = null; 
  window.speechSynthesis.cancel();
  
  currentUtterance = new SpeechSynthesisUtterance(currentText);
  
  // Fetch fresh voice object by name to avoid stale memory drops
  const voices = window.speechSynthesis.getVoices();
  const activeVoice = voices.find(v => v.name === savedVoiceName);
  if (activeVoice) currentUtterance.voice = activeVoice;
  
  currentUtterance.rate = playbackRate;
  
  currentUtterance.onend = () => {
    if (isPlaying) {
      if (currentIndex >= sentences.length - 1) {
        goToNextChapter();
      } else {
        moveSentence(1);
        playCurrentSentence();
      }
    }
  };

  window.speechSynthesis.speak(currentUtterance);
}

function goToNextChapter() {
  console.log("TTSFlow: End of chapter. Searching for Next link...");
  
  const nextElements = Array.from(document.querySelectorAll('a, button'));
  let nextBtn = nextElements.find(el => {
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (text.length > 20) return false;
    return (
      text === 'next' || text === 'next chapter' || text === 'next >' ||
      text.startsWith('next chapter') || text.endsWith('next chapter')
    );
  }) || document.querySelector('a[data-vt-direction="next"], a[rel="next"]');

  let targetUrl = null;
  if (nextBtn && nextBtn.href) {
    targetUrl = nextBtn.href;
  }

  // Predictive URL Fallback (Bypasses Javascript buttons)
  if (!targetUrl) {
    const currentUrl = window.location.href;
    const urlMatch = currentUrl.match(/(.*(?:chapter|ch|c|part|page|vol|volume)[-_\/ ]?)(\d+)(.*)/i);
    if (urlMatch) {
        const nextChNum = parseInt(urlMatch[2]) + 1;
        targetUrl = urlMatch[1] + nextChNum + urlMatch[3];
    }
  }

  if (targetUrl || nextBtn) {
    console.log("TTSFlow: Navigating to next chapter...");
    textContainer.innerHTML = '<div class="ttsflow-spinner"></div>';
    
    // Plant flag to remember to keep reading
    localStorage.setItem('ttsflow_autoplay', 'true');
    
    if (targetUrl) {
      // Natural navigation bypasses Cloudflare perfectly
      window.location.href = targetUrl;
    } else {
      nextBtn.click();
      setTimeout(() => window.location.reload(), 1500);
    }
  } else {
    alert("TTSFlow: Reached the latest chapter. No 'Next' button found.");
    isPlaying = false;
    localStorage.removeItem('ttsflow_autoplay');
    const playBtn = document.getElementById('ttsflow-playpause');
    if (playBtn) playBtn.innerText = "▶";
  }
}

function moveSentence(step) {
  currentIndex += step;
  if (currentIndex < 0) currentIndex = 0;
  if (currentIndex >= sentences.length) currentIndex = sentences.length - 1;
  highlightCurrentSentence();
}

function highlightCurrentSentence() {
  const oldHighlight = document.querySelector('.ttsflow-highlight');
  if (oldHighlight) oldHighlight.classList.remove('ttsflow-highlight');
  
  const activeSpan = document.getElementById(`ttsflow-s-${currentIndex}`);
  if (activeSpan) {
    activeSpan.classList.add('ttsflow-highlight');
    activeSpan.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function closeTTSFlow() {
  if (overlay) {
    overlay.remove();
    document.body.style.overflow = '';
    isPlaying = false;
    localStorage.removeItem('ttsflow_autoplay'); // Clear flag
  }
}

/* =========================================
   AUTO-PLAY BOOTSTRAPPER
   ========================================= */
if (localStorage.getItem('ttsflow_autoplay') === 'true') {
  const startAutoplay = () => {
    // Wait briefly for SPA frameworks to inject chapter text
    setTimeout(() => initTTSFlow(), 1000); 
  };
  
  if (document.readyState === 'complete') {
    startAutoplay();
  } else {
    window.addEventListener('load', startAutoplay);
  }
}