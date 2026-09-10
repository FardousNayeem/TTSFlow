/* =========================================================================
   Piper inference worker (source — bundled by build/vendor.mjs).

   Runs off the background page's main thread so a slow synthesis never
   stalls message handling. Everything it loads is local: the library is
   bundled in, and the ONNX runtime plus the espeak-ng phonemizer are read
   from piper/vendor/ rather than a CDN.
   ========================================================================= */

import { TtsSession, download, remove, stored, flush, voices } from '@mintplex-labs/piper-tts-web';

// worker.js sits in piper/, the binaries in piper/vendor/.
const VENDOR = new URL('./vendor/', import.meta.url).href;

// The library reads these from the object handed to each session, not from
// the mutable TtsSession.WASM_LOCATIONS static, so they must be passed every
// time a session is constructed.
//   onnxWasm  — a directory; ORT appends the binary name itself
//   piperWasm — the phonemizer binary
//   piperData — the espeak-ng voice data
const WASM_PATHS = {
  onnxWasm: VENDOR,
  piperWasm: `${VENDOR}piper_phonemize.wasm`,
  piperData: `${VENDOR}piper_phonemize.data`
};

let session = null;
let sessionVoiceId = null;

function post(id, ok, payload) {
  self.postMessage({ id, ok, ...payload });
}

function progressReporter(voiceId) {
  let lastSent = 0;
  return ({ url, loaded, total }) => {
    // The library also reports inference progress on a tts:// URL; only
    // real downloads carry a byte total worth showing.
    if (!total || !url || url.startsWith('tts://')) return;
    const now = Date.now();
    if (now - lastSent < 120 && loaded < total) return;
    lastSent = now;
    self.postMessage({ event: 'progress', voiceId, loaded, total });
  };
}

async function getSession(voiceId) {
  if (session && sessionVoiceId === voiceId) return session;

  // The library keeps one TtsSession on a static, and its *constructor*
  // returns that instance for every later create(). It assigns the new
  // voiceId to the field but never re-runs init(), so the loaded ONNX model
  // stays on whichever voice was used first: picking a different voice
  // silently kept speaking in the old one. Dropping the static forces a
  // genuinely new session, which loads the right model.
  TtsSession._instance = null;

  session = await TtsSession.create({
    voiceId,
    wasmPaths: WASM_PATHS,
    progress: progressReporter(voiceId)
  });
  sessionVoiceId = voiceId;
  return session;
}

/* -------------------------------------------------------------------------
   Job serialisation.

   The reader deliberately fires the next sentence's synthesis off without
   awaiting it, so two synth jobs are routinely in flight together. That is
   not safe: an ORT InferenceSession cannot be run() concurrently, and two
   getSession calls for different voices would interleave and leave the
   session pointing at one voice's model while reporting the other's id.

   Model-touching jobs therefore run one at a time. Downloads and catalogue
   reads stay off the queue, so fetching a 60MB voice never blocks playback.
   ------------------------------------------------------------------------- */

const SERIALIZED = new Set(['synth', 'remove', 'flush']);

let queue = Promise.resolve();

function serialize(job) {
  const run = queue.then(job, job);
  // Keep the chain alive regardless of how this job ended.
  queue = run.then(
    () => {},
    () => {}
  );
  return run;
}

function resetSession() {
  session = null;
  sessionVoiceId = null;
  TtsSession._instance = null;
}

const handlers = {
  // Voice catalogue joined with what is actually on disk. Sizes come from
  // the catalogue's per-file metadata so the UI can show them before
  // anything is downloaded.
  async list() {
    const [catalogue, onDisk] = await Promise.all([voices(), stored()]);
    const installed = new Set(onDisk);

    const list = catalogue.map((voice) => {
      let bytes = 0;
      for (const [name, meta] of Object.entries(voice.files || {})) {
        if (name.endsWith('.onnx') || name.endsWith('.onnx.json')) bytes += meta.size_bytes || 0;
      }
      return {
        id: voice.key,
        name: voice.name,
        quality: voice.quality,
        languageCode: voice.language?.code || '',
        languageName: voice.language?.name_english || '',
        bytes,
        installed: installed.has(voice.key)
      };
    });

    return { voices: list };
  },

  async download({ voiceId }) {
    await download(voiceId, progressReporter(voiceId));
    return { voiceId };
  },

  async remove({ voiceId }) {
    if (sessionVoiceId === voiceId) resetSession();
    await remove(voiceId);
    return { voiceId };
  },

  async flush() {
    resetSession();
    await flush();
    return {};
  },

  // Returns raw WAV bytes; the background page turns them into audio.
  async synth({ text, voiceId }) {
    const active = await getSession(voiceId);
    const blob = await active.predict(text);
    const wav = await blob.arrayBuffer();
    return { wav, transfer: [wav] };
  }
};

self.onmessage = async (event) => {
  const { id, action, payload } = event.data || {};
  const handler = handlers[action];

  if (!handler) {
    post(id, false, { error: `unknown action: ${action}` });
    return;
  }

  try {
    const job = () => handler(payload || {});
    const { transfer, ...result } =
      (await (SERIALIZED.has(action) ? serialize(job) : job())) || {};
    self.postMessage({ id, ok: true, ...result }, transfer || []);
  } catch (error) {
    post(id, false, { error: String((error && error.message) || error) });
  }
};

self.postMessage({ event: 'ready' });
