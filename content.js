let sentences = [];
let currentIndex = 0;
let isPlaying = false;
let overlay, textContainer;
let currentUtterance = null;

let playbackRate = parseFloat(localStorage.getItem('ttsflow_speed')) || 1.0;
let savedVoiceName = localStorage.getItem('ttsflow_voice') || 'Microsoft Mark';
let selectedVoice = null;
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
    return;
  }
  
  buildUI();
  isPlaying = true;
  highlightCurrentSentence();
  playCurrentSentence();
}

function extractAndSegmentText(docContext) {
  const contentArea = docContext.querySelector('.chapter-content, .entry-content, #chapter-content, .reader-content, article') || docContext.body;
  const elements = contentArea.querySelectorAll('p, .paragraph');
  let validParagraphs = [];
  
  for (let el of elements) {
    const text = el.innerText.trim();
    if (text.length < 5) continue; 
    
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
  
  const navbar = document.createElement('div');
  navbar.id = 'ttsflow-navbar';
  navbar.innerHTML = `
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
  selectedVoice = voices.find(v => v.name === savedVoiceName) || 
                  voices.find(v => v.name.includes('Mark')) || 
                  voices[0];

  voices.forEach((voice, i) => {
    const option = document.createElement('option');
    option.value = i;
    option.textContent = `${voice.name} (${voice.lang})`;
    if (voice === selectedVoice) option.selected = true;
    voiceSelect.appendChild(option);
  });

  voiceSelect.onchange = (e) => {
    selectedVoice = voices[e.target.value];
    localStorage.setItem('ttsflow_voice', selectedVoice.name); 
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
    document.getElementById('ttsflow-playpause').innerText = "▶"; // Fixed Icon
    if (currentUtterance) currentUtterance.onend = null;
    window.speechSynthesis.cancel(); 
  };

  document.getElementById('ttsflow-playpause').onclick = () => {
    isPlaying = !isPlaying;
    if (isPlaying) {
      document.getElementById('ttsflow-playpause').innerText = "⏸"; 
      playCurrentSentence();
    } else {
      document.getElementById('ttsflow-playpause').innerText = "▶"; // Fixed Icon
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
  if (selectedVoice) currentUtterance.voice = selectedVoice;
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

async function goToNextChapter() {
  console.log("TTSFlow: End of chapter. Searching for Next link...");
  let targetUrl = null;

  const specificNextBtn = currentNavContext.querySelector('a[data-vt-direction="next"], a[rel="next"]');
  if (specificNextBtn && specificNextBtn.href) {
    targetUrl = specificNextBtn.href;
  }

  if (!targetUrl) {
    const links = Array.from(currentNavContext.querySelectorAll('a'));
    const matchedLink = links.find(a => {
      const cleanText = (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      return (
        cleanText === 'next' || cleanText === 'next chapter' || cleanText === 'next >' ||
        cleanText.startsWith('next chapter') || cleanText.endsWith('next chapter') ||
        (cleanText.includes('next') && cleanText.includes('chapter'))
      );
    });
    if (matchedLink && matchedLink.href) targetUrl = matchedLink.href;
  }

  if (targetUrl) {
    console.log("TTSFlow: Fetching next chapter from:", targetUrl);
    
    textContainer.innerHTML = '<div class="ttsflow-spinner"></div>';
    
    try {
      const response = await fetch(targetUrl);
      const html = await response.text();
      
      const parser = new DOMParser();
      currentNavContext = parser.parseFromString(html, 'text/html');
      
      window.history.pushState({path: targetUrl}, '', targetUrl);
      
      extractAndSegmentText(currentNavContext);
      
      if (sentences.length > 0) {
        renderSentences();
        highlightCurrentSentence();
        playCurrentSentence();
      } else {
        alert("TTSFlow: Loaded next page but couldn't find readable text.");
        closeTTSFlow();
      }
    } catch (e) {
      console.error(e);
      alert("TTSFlow: Failed to load next chapter automatically.");
      closeTTSFlow();
    }
  } else {
    alert("TTSFlow: Reached the latest chapter. No 'Next' button found.");
    isPlaying = false;
    const playBtn = document.getElementById('ttsflow-playpause');
    if (playBtn) playBtn.innerText = "▶"; // Fixed Icon
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
    const y = activeSpan.getBoundingClientRect().top + window.scrollY - 100;
    window.scrollTo({top: y, behavior: 'smooth'});
  }
}

function closeTTSFlow() {
  if (overlay) {
    overlay.remove();
    document.body.style.overflow = '';
    isPlaying = false;
  }
}