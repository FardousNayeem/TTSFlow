document.getElementById('startBtn').addEventListener('click', async () => {
  // Get the current active tab
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  
  // Send a message to content.js to start the flow
  chrome.tabs.sendMessage(tab.id, { action: "START_TTSFLOW" });
  
  // Close the popup
  window.close();
});