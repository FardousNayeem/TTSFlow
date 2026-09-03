let sentences = [];
let currentIndex = 0;
let isPlaying = false;
let overlay, textContainer;
let currentUtterance = null;

// Listen for the start message from the popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "START_TTSFLOW") {
    initTTSFlow();
  }
});

function initTTSFlow() {
  if (document.getElementById('ttsflow-overlay')) return; // Prevent duplicates
  
  extractAndSegmentText();
  
  if (sentences.length === 0) {
    alert("TTSFlow: Could not find readable text on this page.");
    return;
  }
  
  buildUI();
  highlightCurrentSentence();
}

function extractAndSegmentText() {
  // Target the main content area first
  const contentArea = document.querySelector('.chapter-content, .entry-content, #chapter-content, .reader-content, article') || document.body;
  const elements = contentArea.querySelectorAll('p, .paragraph');
  
  let validParagraphs = [];
  
  for (let el of elements) {
    const text = el.innerText.trim();
    if (text.length < 5) continue; // Skip empty or tiny fragments
    
    // The Cutoff Logic: Stop extracting if we hit known footer/UI text or elements
    const lowerText = text.toLowerCase();
    
    // Check if this element is inside a comments section or author note container
    if (el.closest('.author-note-bottom, .comments-container, .chapter-nav, .portlet-body')) {
      console.log("TTSFlow: Reached footer container. Stopping extraction.");
      break;
    }

    // Check for common closing phrases or UI text
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
      console.log("TTSFlow: Reached cutoff text. Stopping extraction.");
      break; 
    }
    
    validParagraphs.push(text);
  }
  
  const fullText = validParagraphs.join(' ');

  // Use Intl.Segmenter to reliably split the text into sentences
  const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
  const segments = segmenter.segment(fullText);
  
  sentences = Array.from(segments).map(s => s.segment.trim()).filter(s => s.length > 0);
  currentIndex = 0;
}

function buildUI() {
  overlay = document.createElement('div');
  overlay.id = 'ttsflow-overlay';
  
  // Create controls matching your reference image
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
  
  // Wrap each sentence in a span for highlighting
  sentences.forEach((sentence, index) => {
    const span = document.createElement('span');
    span.id = `ttsflow-s-${index}`;
    span.innerText = sentence + ' ';
    textContainer.appendChild(span);
  });
  
  overlay.appendChild(controls);
  overlay.appendChild(textContainer);
  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden'; // Lock background scrolling
  
  attachEventListeners();
}

function attachEventListeners() {
  document.getElementById('ttsflow-close').onclick = () => {
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

  // Cancel any currently playing speech to prevent overlap
  window.speechSynthesis.cancel();

  // Create a new speech request
  currentUtterance = new SpeechSynthesisUtterance(currentText);
  
  // When the sentence finishes, automatically move to the next one
  currentUtterance.onend = () => {
    if (isPlaying) {
      if (currentIndex >= sentences.length - 1) {
        // Phase 4 Hook: We are at the end of the chapter!
        console.log("TTSFlow: Reached end of chapter.");
        isPlaying = false;
        document.getElementById('ttsflow-playpause').innerText = "⏯";
        // TODO in Phase 4: Automatically find and click the "Next" button here
      } else {
        moveSentence(1);
        playCurrentSentence();
      }
    }
  };

  // Start talking
  window.speechSynthesis.speak(currentUtterance);
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
  // Remove old highlights
  const oldHighlight = document.querySelector('.ttsflow-highlight');
  if (oldHighlight) oldHighlight.classList.remove('ttsflow-highlight');
  
  // Add new highlight
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