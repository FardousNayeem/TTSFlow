/* =========================================================================
   Background entry point: lifecycle wiring and message routing.
   ========================================================================= */

const Arbiter = globalThis.TTSFlowArbiter;
const Piper = globalThis.TTSFlowPiper;

// A restart must never resume reading on its own.
browser.runtime.onStartup.addListener(Arbiter.clearState);
browser.runtime.onInstalled.addListener(Arbiter.clearState);

browser.tabs.onRemoved.addListener((tabId) => Arbiter.releaseTab(tabId));

/* ---------------------------------------------------------------------
   Reading session port.

   The reading tab holds this open for as long as it is reading. It keeps
   this event page alive across long sentences — Firefox unloads idle event
   pages, and a connected port is the supported way to say "still busy" —
   and its disconnect is the signal to tear playback down when the tab is
   closed or navigates away.
   --------------------------------------------------------------------- */

let readingPorts = 0;

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ttsflow-session') return;
  readingPorts++;

  port.onDisconnect.addListener(() => {
    readingPorts = Math.max(0, readingPorts - 1);
    if (readingPorts === 0) Piper.shutdown();
  });
});

/* ---------------------------------------------------------------------
   Messages
   --------------------------------------------------------------------- */

// Messages this background page itself broadcasts. runtime.sendMessage can
// echo back here, and routing them would answer "unknown action" to nobody.
const BROADCASTS = new Set([
  'TTSFLOW_PIPER_PROGRESS',
  'TTSFLOW_PIPER_ENDED',
  'TTSFLOW_PIPER_ERROR'
]);

async function route(request, sender) {
  const tabId = sender.tab ? sender.tab.id : null;
  const { action } = request;

  // Ownership actions.
  const arbitrated = await Arbiter.handle(action, tabId, request);
  if (arbitrated !== null) return arbitrated;

  switch (action) {
    case 'TTSFLOW_PIPER_LIST':
      return Piper.list();

    case 'TTSFLOW_PIPER_DOWNLOAD':
      return Piper.download(request.voiceId, tabId);

    case 'TTSFLOW_PIPER_REMOVE':
      return Piper.remove(request.voiceId);

    case 'TTSFLOW_PIPER_FLUSH':
      return Piper.flush();

    case 'TTSFLOW_PIPER_SPEAK':
      return Piper.speak({
        text: request.text,
        nextText: request.nextText,
        voiceId: request.voiceId,
        rate: request.rate,
        tabId
      });

    case 'TTSFLOW_PIPER_PAUSE':
      return Piper.pause();

    case 'TTSFLOW_PIPER_RESUME':
      return Piper.resume();

    case 'TTSFLOW_PIPER_STOP':
      return Piper.stop();

    case 'TTSFLOW_PIPER_RATE':
      return Piper.setRate(request.rate);

    // Derived data only: saved reading positions and synthesised audio.
    // Downloaded voice models are deliberately untouched — those are large,
    // deliberate downloads with their own delete controls.
    case 'TTSFLOW_CLEAR_CACHE': {
      const { positions = {} } = await browser.storage.local.get('positions');
      const count = Object.keys(positions).length;
      await browser.storage.local.remove('positions');
      const audio = Piper.clearAudioCache();
      return { ok: true, positions: count, audio };
    }

    default:
      return { ok: false, error: `unknown action: ${action}` };
  }
}

browser.runtime.onMessage.addListener((request, sender) => {
  if (!request || typeof request.action !== 'string') return false;
  if (!request.action.startsWith('TTSFLOW_')) return false;
  if (BROADCASTS.has(request.action)) return false;

  // Returning a promise is the Firefox way to reply asynchronously.
  return route(request, sender).catch((error) => ({
    ok: false,
    error: String((error && error.message) || error)
  }));
});
