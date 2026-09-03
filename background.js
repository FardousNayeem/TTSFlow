let piperTabId = null;
let novelTabId = null;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "PLAY_TEXT") {
    novelTabId = sender.tab.id;
    const textToPlay = request.text;
    
    // Check if Piper tab is open, otherwise create it
    if (piperTabId) {
      chrome.tabs.get(piperTabId).then(tab => {
        sendToPiper(textToPlay);
      }).catch(() => {
        openPiperAndPlay(textToPlay);
      });
    } else {
      openPiperAndPlay(textToPlay);
    }
  }

  if (request.action === "AUDIO_ENDED") {
    // Tell the novel tab to move to the next sentence
    if (novelTabId) {
      chrome.tabs.sendMessage(novelTabId, { action: "NEXT_SENTENCE" });
    }
  }
});

function openPiperAndPlay(text) {
  chrome.tabs.create({ url: "https://piper.ttstool.com/", active: false }, (tab) => {
    piperTabId = tab.id;
    // Wait a bit for the page to load before sending the first text
    setTimeout(() => {
      sendToPiper(text);
    }, 3000); 
  });
}

function sendToPiper(text) {
  chrome.tabs.sendMessage(piperTabId, { action: "SYNTHESIZE", text: text });
}