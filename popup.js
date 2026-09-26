const startBtn = document.getElementById('startBtn');
const settingsBtn = document.getElementById('settingsBtn');
const clearCacheBtn = document.getElementById('clearCacheBtn');
const statusEl = document.getElementById('status');

// Order matters: the reader depends on icons, engines and the voice panel.
const CONTENT_FILES = [
  'content/icons.js',
  'content/engines.js',
  'content/voice-panel.js',
  'content/reader.js'
];

let activeTab = null;
let running = false;
let statusTimer = null;

function status(message, kind = '') {
  statusEl.textContent = message;
  statusEl.className = kind;
  clearTimeout(statusTimer);
  if (message && kind) statusTimer = setTimeout(() => status(''), 4000);
}

async function send(tabId, message) {
  try {
    return await browser.tabs.sendMessage(tabId, message);
  } catch (e) {
    return null;
  }
}

async function bg(action) {
  try {
    return (await browser.runtime.sendMessage({ action })) || {};
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

// The content scripts are missing on pages that were already open when the
// extension was installed or reloaded. Inject them rather than failing
// silently, which is what the old popup did.
async function ensureContentScripts(tabId) {
  if (await send(tabId, { action: 'TTSFLOW_PING' })) return true;
  try {
    // The stylesheet has to come too: the dock and the sentence highlight
    // live on the page itself and are unstyled without it.
    await browser.scripting.insertCSS({ target: { tabId }, files: ['styles.css'] });
    await browser.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
  } catch (e) {
    return false;
  }
  return !!(await send(tabId, { action: 'TTSFLOW_PING' }));
}

function render() {
  startBtn.textContent = running ? 'Stop Reading' : 'Start Reading';
  startBtn.classList.toggle('stop', running);
}

function paintIcons() {
  document.getElementById('logo').src = browser.runtime.getURL('icon-128.png');
  settingsBtn.prepend(TTSFlow.icon('settings', { size: 17 }));
  clearCacheBtn.prepend(TTSFlow.icon('broom', { size: 17 }));
}

/* ---------------------------------------------------------------------
   Actions
   --------------------------------------------------------------------- */

startBtn.addEventListener('click', async () => {
  if (!activeTab || !activeTab.id) return;
  startBtn.disabled = true;

  if (running) {
    await send(activeTab.id, { action: 'STOP_TTSFLOW' });
    window.close();
    return;
  }

  if (!(await ensureContentScripts(activeTab.id))) {
    startBtn.disabled = false;
    status('TTSFlow cannot run on this page.', 'error');
    return;
  }

  await send(activeTab.id, { action: 'START_TTSFLOW' });
  window.close();
});

settingsBtn.addEventListener('click', () => {
  browser.runtime.openOptionsPage();
  window.close();
});

clearCacheBtn.addEventListener('click', async () => {
  clearCacheBtn.disabled = true;
  status('Clearing…');

  const reply = await bg('TTSFLOW_CLEAR_CACHE');
  clearCacheBtn.disabled = false;

  if (reply.error) {
    status(`Could not clear: ${reply.error}`, 'error');
    return;
  }
  // Say what actually happened, and be explicit that voices are untouched.
  const parts = [];
  if (reply.positions) parts.push(`${reply.positions} saved position${reply.positions === 1 ? '' : 's'}`);
  if (reply.audio) parts.push(`${reply.audio} cached clip${reply.audio === 1 ? '' : 's'}`);
  status(
    parts.length
      ? `Cleared ${parts.join(' and ')}. Downloaded voices kept.`
      : 'Nothing was cached.',
    'ok'
  );
});

/* ---------------------------------------------------------------------
   Boot
   --------------------------------------------------------------------- */

async function init() {
  paintIcons();

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  activeTab = tab;

  if (!tab || !tab.id) {
    startBtn.disabled = true;
    status('No page here to read.');
    return;
  }

  const pong = await send(tab.id, { action: 'TTSFLOW_PING' });
  running = !!(pong && pong.running);
  render();
}

init();
