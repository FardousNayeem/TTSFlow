/* =========================================================================
   TTSFlow settings page.

   Writes straight to browser.storage.local; an open reader picks the changes
   up through its storage.onChanged listener, so nothing needs restarting.
   ========================================================================= */

const DEFAULTS = {
  speed: 1.0,
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

/* ---------------------------------------------------------------------
   Playback preferences
   --------------------------------------------------------------------- */

function bindPlayback() {
  const speed = $('speed');
  speed.value = String(settings.speed);
  $('speed-value').textContent = `${settings.speed.toFixed(1)}x`;
  speed.addEventListener('input', () => {
    const value = parseFloat(speed.value);
    $('speed-value').textContent = `${value.toFixed(1)}x`;
    save({ speed: value });
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
  if (!request || request.action !== 'TTSFLOW_PIPER_PROGRESS') return false;
  if (!downloading.has(request.voiceId)) return false;
  downloading.set(request.voiceId, { loaded: request.loaded, total: request.total });

  // Repaint just this row so a progress tick does not rebuild the list.
  const row = document.querySelector(`.voice[data-voice-id="${CSS.escape(request.voiceId)}"]`);
  const voice = piperVoices.find((v) => v.id === request.voiceId);
  if (row && voice) row.lastElementChild.replaceWith(voiceActions(voice));
  return false;
});

async function init() {
  $('logo').src = browser.runtime.getURL('icon-128.png');

  const stored = await browser.storage.local.get(Object.keys(DEFAULTS));
  for (const [key, value] of Object.entries(stored)) {
    if (value !== undefined) settings[key] = value;
  }

  bindPlayback();
  await bindSystemVoices();

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
