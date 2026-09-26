/* =========================================================================
   TTSFlow settings page.

   Writes straight to browser.storage.local; an open reader picks the changes
   up through its storage.onChanged listener, so nothing needs restarting.
   ========================================================================= */

// Two sentences: enough to judge a voice's cadence and consonants without
// making the user sit through a paragraph.
const SAMPLE_TEXT =
  'The lantern swung once, then went out. ' +
  'Somewhere below, a door closed and the stairs began to creak.';

const DEFAULTS = {
  speed: 1.0,
  pitch: 1.0,
  engine: 'native',
  voiceName: '',
  voiceId: '',
  autoAdvance: true,
  resumePosition: true,
  autoScroll: true
};

const $ = (id) => document.getElementById(id);
const mb = (bytes) =>
  bytes >= 1048576 ? `${Math.round(bytes / 1048576)} MB` : `${Math.round(bytes / 1024)} KB`;

let settings = { ...DEFAULTS };
let piperVoices = [];
const downloading = new Map();
let statusTimer = null;

// Which voice is auditioning right now: 'system', a voiceId, or null.
let previewing = null;

function status(message, isError = false) {
  const el = $('status');
  el.textContent = message;
  el.classList.toggle('error', isError);
  clearTimeout(statusTimer);
  if (message) statusTimer = setTimeout(() => (el.textContent = ''), 4000);
}

async function bg(action, extra) {
  try {
    return (await browser.runtime.sendMessage({ action, ...extra })) || {};
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

async function save(patch) {
  Object.assign(settings, patch);
  await browser.storage.local.set(patch);
}

// Sliders fire on every pixel of a drag, and an open reader re-speaks its
// sentence on each speed or pitch change it hears. Write once it settles.
const saveTimers = {};
function saveSoon(key, value) {
  settings[key] = value;
  clearTimeout(saveTimers[key]);
  saveTimers[key] = setTimeout(() => save({ [key]: value }), 250);
}

// Matches the reader: 1.25× stays 1.25×, 1.00× reads as 1.0×.
const formatSpeed = (value) => `${value.toFixed(2).replace(/0$/, '')}×`;

/* ---------------------------------------------------------------------
   Playback preferences
   --------------------------------------------------------------------- */

function bindPlayback() {
  const speed = $('speed');
  speed.value = String(settings.speed);
  $('speed-value').textContent = formatSpeed(settings.speed);
  speed.addEventListener('input', () => {
    const value = parseFloat(speed.value);
    $('speed-value').textContent = formatSpeed(value);
    saveSoon('speed', value);
  });

  const pitch = $('pitch');
  pitch.value = String(settings.pitch);
  $('pitch-value').textContent = settings.pitch.toFixed(2);
  pitch.addEventListener('input', () => {
    const value = parseFloat(pitch.value);
    $('pitch-value').textContent = value.toFixed(2);
    saveSoon('pitch', value);
  });

  for (const key of ['autoAdvance', 'resumePosition', 'autoScroll']) {
    const box = $(key);
    box.checked = settings[key];
    box.addEventListener('change', () => save({ [key]: box.checked }));
  }
}

/* ---------------------------------------------------------------------
   System voices
   --------------------------------------------------------------------- */

function systemVoices() {
  const synth = window.speechSynthesis;
  const immediate = synth.getVoices();
  if (immediate.length) return Promise.resolve(immediate);

  // Never hang: on Linux an unconfigured speech-dispatcher simply has none,
  // and voiceschanged will not fire.
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      synth.removeEventListener('voiceschanged', finish);
      resolve(synth.getVoices());
    };
    synth.addEventListener('voiceschanged', finish);
    setTimeout(finish, 2000);
  });
}

async function bindSystemVoices() {
  const select = $('system-voice');
  const voices = await systemVoices();

  if (!voices.length) {
    $('system-voice-note').textContent =
      'None available. On Linux, install a speech-dispatcher voice, or use a neural voice.';
    select.disabled = true;
    $('system-preview').disabled = true;
    select.appendChild(new Option('No system voices found', ''));
    return;
  }

  $('system-voice-note').textContent = `${voices.length} available from your system.`;
  for (const voice of voices) {
    const option = new Option(`${voice.name} (${voice.lang})`, voice.name);
    if (voice.name === settings.voiceName) option.selected = true;
    select.appendChild(option);
  }

  select.addEventListener('change', () => {
    // Choosing a system voice also switches the engine back to system.
    save({ voiceName: select.value, engine: 'native' });
    status(`System voice set to ${select.value}.`);
    renderVoices();
  });
}

/* ---------------------------------------------------------------------
   Previews

   System voices are spoken straight from this page; neural ones are
   synthesised in the background on a dedicated element, so auditioning a
   voice never disturbs a reader that is mid-sentence in another tab.
   --------------------------------------------------------------------- */

function refreshPreviewButtons() {
  const sys = $('system-preview');
  sys.textContent = '';
  sys.appendChild(TTSFlow.icon(previewing === 'system' ? 'stop' : 'play', { size: 16 }));
  sys.title = previewing === 'system' ? 'Stop preview' : 'Preview this voice';
  sys.setAttribute('aria-label', sys.title);
  if (piperVoices.length) renderVoices();
}

async function stopPreview() {
  window.speechSynthesis.cancel();
  await bg('TTSFLOW_PIPER_PREVIEW_STOP');
  previewing = null;
  refreshPreviewButtons();
}

async function previewSystem() {
  if (previewing === 'system') return stopPreview();
  await stopPreview();

  const name = $('system-voice').value;
  const utterance = new SpeechSynthesisUtterance(SAMPLE_TEXT);
  const voice = window.speechSynthesis.getVoices().find((v) => v.name === name);
  if (voice) utterance.voice = voice;
  utterance.rate = settings.speed;
  utterance.pitch = Math.min(2, Math.max(0, settings.pitch));
  utterance.onend = () => {
    if (previewing === 'system') {
      previewing = null;
      refreshPreviewButtons();
    }
  };
  utterance.onerror = utterance.onend;

  previewing = 'system';
  refreshPreviewButtons();
  window.speechSynthesis.speak(utterance);
}

async function previewNeural(voice) {
  if (previewing === voice.id) return stopPreview();
  await stopPreview();

  previewing = voice.id;
  refreshPreviewButtons();
  status(`Preparing ${voice.name}…`);

  const reply = await bg('TTSFLOW_PIPER_PREVIEW', {
    voiceId: voice.id,
    rate: settings.speed,
    pitch: settings.pitch,
    text: SAMPLE_TEXT
  });

  if (reply.error) {
    previewing = null;
    refreshPreviewButtons();
    status(`Could not preview ${voice.name}: ${reply.error}`, true);
    return;
  }
  status(`Playing ${voice.name}.`);
}

/* ---------------------------------------------------------------------
   Neural voices
   --------------------------------------------------------------------- */

async function loadPiperVoices() {
  const list = $('voice-list');
  list.textContent = '';
  list.appendChild(Object.assign(document.createElement('p'), {
    className: 'muted',
    textContent: 'Loading voice catalogue…'
  }));

  const reply = await bg('TTSFLOW_PIPER_LIST');
  if (reply.voices) {
    piperVoices = reply.voices;
  } else {
    list.textContent = '';
    list.appendChild(Object.assign(document.createElement('p'), {
      className: 'muted',
      textContent:
        reply.error ||
        'The Piper runtime is not built. Run `npm install && npm run vendor` in the extension folder, then reload the add-on.'
    }));
    return;
  }
  renderVoices();
}

function visibleVoices() {
  const term = $('voice-search').value.trim().toLowerCase();
  if (!term) {
    // The catalogue is well over a hundred voices; default to English plus
    // anything already downloaded.
    return piperVoices.filter((v) => v.installed || v.languageCode.startsWith('en'));
  }
  return piperVoices.filter((v) =>
    `${v.name} ${v.languageCode} ${v.languageName} ${v.quality}`.toLowerCase().includes(term)
  );
}

function renderVoices() {
  const list = $('voice-list');
  list.textContent = '';

  const installed = piperVoices.filter((v) => v.installed);
  const bytes = installed.reduce((sum, v) => sum + v.bytes, 0);
  $('voice-summary').textContent = installed.length
    ? `${installed.length} voice${installed.length === 1 ? '' : 's'} downloaded · ${mb(bytes)}`
    : 'No neural voices downloaded';
  $('delete-all').disabled = installed.length === 0;

  const voices = visibleVoices().sort(
    (a, b) => Number(b.installed) - Number(a.installed) || a.name.localeCompare(b.name)
  );

  if (!voices.length) {
    list.appendChild(Object.assign(document.createElement('p'), {
      className: 'muted',
      textContent: 'No voices match that search.'
    }));
    return;
  }

  for (const voice of voices) list.appendChild(voiceRow(voice));
}

function voiceRow(voice) {
  const row = document.createElement('div');
  row.className = 'voice';
  row.dataset.voiceId = voice.id;

  const info = document.createElement('div');
  info.className = 'info';
  const name = document.createElement('strong');
  name.textContent = voice.name;
  const meta = document.createElement('span');
  const active = settings.engine === 'piper' && settings.voiceId === voice.id;
  meta.textContent = `${voice.languageCode} · ${voice.quality} · ${mb(voice.bytes)}${active ? ' · in use' : ''}`;
  info.append(name, meta);

  row.append(info, voiceActions(voice));
  return row;
}

function voiceActions(voice) {
  const wrap = document.createElement('div');
  wrap.className = 'row';

  const progress = downloading.get(voice.id);
  if (progress) {
    const bar = document.createElement('div');
    bar.className = 'bar';
    const fill = document.createElement('div');
    const pct = progress.total ? Math.round((progress.loaded / progress.total) * 100) : 0;
    fill.style.width = `${pct}%`;
    bar.appendChild(fill);

    const label = document.createElement('span');
    label.className = 'pct';
    label.textContent = progress.total ? `${pct}%` : '…';

    wrap.append(bar, label);
    return wrap;
  }

  if (voice.installed) {
    const play = document.createElement('button');
    play.className = 'icon-btn';
    play.appendChild(TTSFlow.icon(previewing === voice.id ? 'stop' : 'play', { size: 16 }));
    play.title = previewing === voice.id ? 'Stop preview' : `Preview ${voice.name}`;
    play.setAttribute('aria-label', play.title);
    play.addEventListener('click', () => previewNeural(voice));
    wrap.appendChild(play);

    const use = document.createElement('button');
    use.textContent = 'Use';
    use.disabled = settings.engine === 'piper' && settings.voiceId === voice.id;
    use.addEventListener('click', async () => {
      await save({ engine: 'piper', voiceId: voice.id, voiceName: voice.name });
      status(`Now reading with ${voice.name}.`);
      renderVoices();
    });

    const del = document.createElement('button');
    del.className = 'icon-btn danger';
    del.appendChild(TTSFlow.icon('trash', { size: 17 }));
    del.title = `Delete ${voice.name} (${mb(voice.bytes)})`;
    del.setAttribute('aria-label', `Delete ${voice.name}`);
    del.addEventListener('click', () => removeVoice(voice));

    wrap.append(use, del);
  } else {
    const get = document.createElement('button');
    get.className = 'icon-btn';
    get.appendChild(TTSFlow.icon('download', { size: 17 }));
    get.title = `Download ${voice.name} (${mb(voice.bytes)})`;
    get.setAttribute('aria-label', `Download ${voice.name}`);
    get.addEventListener('click', () => downloadVoice(voice));
    wrap.appendChild(get);
  }

  return wrap;
}

async function downloadVoice(voice) {
  downloading.set(voice.id, { loaded: 0, total: voice.bytes });
  renderVoices();
  status(`Downloading ${voice.name} (${mb(voice.bytes)})…`);

  const reply = await bg('TTSFLOW_PIPER_DOWNLOAD', { voiceId: voice.id });
  downloading.delete(voice.id);

  if (reply.error) {
    status(`Could not download ${voice.name}: ${reply.error}`, true);
  } else {
    voice.installed = true;
    status(`${voice.name} is ready to use.`);
  }
  renderVoices();
}

async function removeVoice(voice) {
  if (!confirm(`Delete the "${voice.name}" voice (${mb(voice.bytes)})? You can download it again later.`)) {
    return;
  }
  const reply = await bg('TTSFLOW_PIPER_REMOVE', { voiceId: voice.id });
  if (reply.error) {
    status(`Could not delete ${voice.name}: ${reply.error}`, true);
    return;
  }
  voice.installed = false;
  // Do not leave the reader pointed at a voice that is no longer there.
  if (settings.engine === 'piper' && settings.voiceId === voice.id) {
    await save({ engine: 'native', voiceId: '', voiceName: $('system-voice').value || '' });
  }
  status(`Deleted ${voice.name}.`);
  renderVoices();
}

/* ---------------------------------------------------------------------
   Storage
   --------------------------------------------------------------------- */

async function refreshCacheSummary() {
  const { positions = {} } = await browser.storage.local.get('positions');
  const count = Object.keys(positions).length;
  $('cache-summary').textContent = count
    ? `${count} saved reading position${count === 1 ? '' : 's'}, plus recently synthesised audio.`
    : 'Nothing cached.';
}

async function clearCache() {
  const reply = await bg('TTSFLOW_CLEAR_CACHE');
  if (reply.error) {
    status(`Could not clear the cache: ${reply.error}`, true);
    return;
  }
  status(
    reply.positions
      ? `Cleared ${reply.positions} saved reading position${reply.positions === 1 ? '' : 's'} and the audio cache.`
      : 'Cache cleared.'
  );
  refreshCacheSummary();
}

/* ---------------------------------------------------------------------
   Boot
   --------------------------------------------------------------------- */

browser.runtime.onMessage.addListener((request) => {
  if (!request || typeof request.action !== 'string') return false;

  if (request.action === 'TTSFLOW_PIPER_PREVIEW_ENDED') {
    if (previewing && previewing !== 'system') {
      previewing = null;
      refreshPreviewButtons();
    }
    return false;
  }

  if (request.action !== 'TTSFLOW_PIPER_PROGRESS') return false;
  if (!downloading.has(request.voiceId)) return false;
  downloading.set(request.voiceId, { loaded: request.loaded, total: request.total });

  // Repaint just this row so a progress tick does not rebuild the list.
  const row = document.querySelector(`.voice[data-voice-id="${CSS.escape(request.voiceId)}"]`);
  const voice = piperVoices.find((v) => v.id === request.voiceId);
  if (row && voice) row.lastElementChild.replaceWith(voiceActions(voice));
  return false;
});

// Speed changed from the reader's dock while this page is open.
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.speed) return;
  const value = parseFloat(changes.speed.newValue);
  const slider = $('speed');
  if (!Number.isFinite(value) || document.activeElement === slider) return;
  settings.speed = value;
  slider.value = String(value);
  $('speed-value').textContent = formatSpeed(value);
});

async function init() {
  $('logo').src = browser.runtime.getURL('icon-128.png');

  const stored = await browser.storage.local.get(Object.keys(DEFAULTS));
  for (const [key, value] of Object.entries(stored)) {
    if (value !== undefined) settings[key] = value;
  }

  bindPlayback();
  await bindSystemVoices();

  $('system-preview').addEventListener('click', previewSystem);
  refreshPreviewButtons();
  window.addEventListener('pagehide', () => {
    window.speechSynthesis.cancel();
    bg('TTSFLOW_PIPER_PREVIEW_STOP');
  });

  $('voice-search').addEventListener('input', renderVoices);
  $('delete-all').addEventListener('click', async () => {
    const installed = piperVoices.filter((v) => v.installed);
    const bytes = installed.reduce((sum, v) => sum + v.bytes, 0);
    if (!confirm(`Delete all ${installed.length} downloaded voices (${mb(bytes)})?`)) return;

    const reply = await bg('TTSFLOW_PIPER_FLUSH');
    if (reply.error) {
      status(`Could not delete voices: ${reply.error}`, true);
      return;
    }
    piperVoices.forEach((v) => (v.installed = false));
    if (settings.engine === 'piper') {
      await save({ engine: 'native', voiceId: '', voiceName: $('system-voice').value || '' });
    }
    status('Deleted all downloaded voices.');
    renderVoices();
  });

  $('clear-cache').addEventListener('click', clearCache);

  refreshCacheSummary();
  loadPiperVoices();
}

init();
