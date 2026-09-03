let sentences = [];
let currentIndex = 0;
let isPlaying = false;
let overlay, textContainer;
let currentUtterance = null;

// New State Variables
let selectedVoice = null;
let playbackRate = 1.0;

// Listen for the start message from the popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "START_TTSFLOW") {
    initTTSFlow();
  }
});

// Autoplay trigger for when a new chapter loads
window.addEventListener('load', () => {
  if (sessionStorage.getItem('ttsflow_autoplay') === 'true') {
    // Wait a second for the page DOM to fully settle
    setTimeout(() => {
      initTTSFlow();
      if (sentences.length > 0) {
        isPlaying = true;
        document.getElementById('ttsflow-playpause').innerText = "⏸";
        playCurrentSentence();
      }
    }, 1000);
  }
});

function initTTSFlow() {
  if (document.getElementById('ttsflow-overlay')) return; 
  
  extractAndSegmentText();
  
  if (sentences.length === 0) {
    alert("TTSFlow: Could not find readable text on this page.");
    return;
  }
  
  buildUI();
  highlightCurrentSentence();
}

function extractAndSegmentText() {
  const contentArea = document.querySelector('.chapter-content, .entry-content, #chapter-content, .reader-content, article') || document.body;
  const elements = contentArea.querySelectorAll('p, .paragraph');
  let validParagraphs = [];
  
  for (let el of elements) {
    const text = el.innerText.trim();
    if (text.length < 5) continue; 
    
    const lowerText = text.toLowerCase();
    
    if (el.closest('.author-note-bottom, .comments-container, .chapter-nav, .portlet-body')) {
      break;
    }

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
  
  // Top Bar for Speed and Voice Control
  const topBar = document.createElement('div');
  topBar.id = 'ttsflow-top-bar';
  topBar.innerHTML = `
    <div id="ttsflow-speed-control">
      <label>Speed: <span id="ttsflow-speed-val">1.0</span>x</label>
      <input type="range" id="ttsflow-speed-slider" min="0.5" max="2.5" step="0.1" value="1.0">
    </div>
    <div>
      <select id="ttsflow-voice-select"><option>Loading voices...</option></select>
    </div>
  `;

  const controls = document.createElement('div');
  controls.id = 'ttsflow-controls';
  controls.innerHTML = `
    <button class="ttsflow-btn" id="ttsflow-prev">⏮</button>
    <button class="ttsflow-btn" id="ttsflow-playpause">⏯</button>
    <button class="ttsflow-btn" id="ttsflow-stop">⏹</button>
    <button class="ttsflow-btn" id="ttsflow-next">⏭</button>
    <button class="ttsflow-btn" id="ttsflow-close" style="margin-left: 20px;">✕</button>
  `;
  
  textContainer = document.createElement('div');
  textContainer.id = 'ttsflow-text-container';
  
  sentences.forEach((sentence, index) => {
    const span = document.createElement('span');
    span.id = `ttsflow-s-${index}`;
    span.innerText = sentence + ' ';
    textContainer.appendChild(span);
  });
  
  overlay.appendChild(topBar);
  overlay.appendChild(controls);
  overlay.appendChild(textContainer);
  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden'; 
  
  attachEventListeners();
  populateVoices(); 
}

function populateVoices() {
  const voiceSelect = document.getElementById('ttsflow-voice-select');
  if (!voiceSelect) return;

  let voices = window.speechSynthesis.getVoices();
  
  // Browsers sometimes load voices asynchronously
  if (voices.length === 0) {
    window.speechSynthesis.onvoiceschanged = () => {
      populateVoices();
    };
    return;
  }

  voiceSelect.innerHTML = ''; 
  voices.forEach((voice, i) => {
    const option = document.createElement('option');
    option.value = i;
    option.textContent = `${voice.name} (${voice.lang})`;
    voiceSelect.appendChild(option);
  });

  // Set default to previously selected or the first one
  if (voices.length > 0) {
    selectedVoice = voices[0];
    
    voiceSelect.onchange = (e) => {
      selectedVoice = voices[e.target.value];
      if (isPlaying) {
         window.speechSynthesis.cancel();
         playCurrentSentence();
      }
    };
  }
}

function attachEventListeners() {
  // Speed Slider Logic
  document.getElementById('ttsflow-speed-slider').oninput = (e) => {
    playbackRate = parseFloat(e.target.value);
    document.getElementById('ttsflow-speed-val').innerText = playbackRate.toFixed(1);
    if (isPlaying) {
      window.speechSynthesis.cancel();
      playCurrentSentence();
    }
  };

  document.getElementById('ttsflow-close').onclick = () => {
    sessionStorage.removeItem('ttsflow_autoplay'); // Disable autoplay loop
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
    sessionStorage.removeItem('ttsflow_autoplay'); 
    document.getElementById('ttsflow-playpause').innerText = "⏯";
    window.speechSynthesis.cancel(); 
  };

  document.getElementById('ttsflow-playpause').onclick = () => {
    isPlaying = !isPlaying;
    if (isPlaying) {
      document.getElementById('ttsflow-playpause').innerText = "⏸"; 
      playCurrentSentence();
    } else {
      document.getElementById('ttsflow-playpause').innerText = "⏯"; 
      window.speechSynthesis.pause(); 
    }
  };
}

function playCurrentSentence() {
  if (!isPlaying) return;
  const currentText = sentences[currentIndex];
  if (!currentText) return;

  window.speechSynthesis.cancel();
  currentUtterance = new SpeechSynthesisUtterance(currentText);
  
  // Apply Voice and Speed
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

function goToNextChapter() {
  console.log("TTSFlow: End of chapter. Searching for Next link...");
  
  const links = Array.from(document.querySelectorAll('a'));
  
  // Find a link that implies "Next"
  const nextLink = links.find(a => {
    const text = a.innerText.toLowerCase().trim();
    const rel = (a.getAttribute('rel') || '').toLowerCase();
    return (text === 'next' || text === 'next chapter' || text === 'next >' || text.includes('next chapter') || rel === 'next');
  });

  if (nextLink && nextLink.href) {
    console.log("TTSFlow: Navigating to next chapter:", nextLink.href);
    sessionStorage.setItem('ttsflow_autoplay', 'true');
    window.location.href = nextLink.href;
  } else {
    console.log("TTSFlow: No next chapter link found.");
    sessionStorage.removeItem('ttsflow_autoplay');
    alert("TTSFlow: Reached the latest chapter. No 'Next' button found.");
    isPlaying = false;
    document.getElementById('ttsflow-playpause').innerText = "⏯";
  }
}

function moveSentence(step) {
  currentIndex += step;
  if (currentIndex < 0) currentIndex = 0;
  if (currentIndex >= sentences.length) {
    currentIndex = sentences.length - 1;
  }
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
  }
}