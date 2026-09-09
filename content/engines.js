/* =========================================================================
   Speech engines.

   Both expose the same surface so the reader never branches on engine:

     init()                       prepare, may reject
     speak(text, opts)            begin one sentence
     pause() / resume()           may restart the sentence (see below)
     stop()                       cancel everything
     setRate(rate)                live speed change
     onended / onerror            callbacks the reader assigns

   `native` drives the browser's own speechSynthesis. `piper` is a remote
   control for the neural voices, which are synthesised and played in the
   background page.
   ========================================================================= */

(() => {
  'use strict';

  const NS = (globalThis.TTSFlow = globalThis.TTSFlow || {});
  if (NS.engines) return;

  async function bg(action, extra) {
    try {
      const reply = await browser.runtime.sendMessage({ action, ...extra });
      return reply || {};
    } catch (e) {
      return { ok: false, error: 'extension is reloading' };
    }
  }

  /* ===================================================================
     Native — window.speechSynthesis
     =================================================================== */

  class NativeEngine {
    constructor() {
      this.id = 'native';
      this.synth = window.speechSynthesis;
      this.onended = () => {};
      this.onerror = () => {};

      this.utterance = null;
      this.token = 0;
      this.watchdog = null;
      this.retriedText = null;
      this.hasEverSpoken = false;

      this.lastText = '';
      this.rate = 1;
      this.voiceName = '';
      this.paused = false;
    }

    async init() {
      const voices = await this.listVoices();
      if (voices.length === 0) {
        // On Linux this means speech-dispatcher has no voices configured,
        // in which case voiceschanged never fires and waiting is pointless.
        throw new Error(
          'Firefox reports no system voices. On Linux these come from ' +
            'speech-dispatcher; install a voice package, or use a Piper voice instead.'
        );
      }
    }

    // Resolves once voices are known, rather than hanging forever when the
    // platform has none to give.
    listVoices() {
      const immediate = this.synth.getVoices();
      if (immediate.length) return Promise.resolve(immediate);

      return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          this.synth.removeEventListener('voiceschanged', finish);
          resolve(this.synth.getVoices());
        };
        this.synth.addEventListener('voiceschanged', finish);
        setTimeout(finish, 2000);
      });
    }

    speak(text, { rate = 1, voiceName = '' } = {}) {
      this.stop();
      this.lastText = text;
      this.rate = rate;
      this.voiceName = voiceName;
      this.paused = false;

      const token = ++this.token;
      const utterance = new SpeechSynthesisUtterance(text);

      // Look the voice up fresh; an object held across a voiceschanged
      // event can go stale and be silently ignored.
      const voice = this.synth.getVoices().find((v) => v.name === voiceName);
      if (voice) utterance.voice = voice;
      utterance.rate = rate;

      utterance.onstart = () => {
        if (token === this.token) this.hasEverSpoken = true;
      };

      utterance.onend = () => this.#finish(token);

      utterance.onerror = (event) => {
        if (token !== this.token) return;
        if (event.error === 'interrupted' || event.error === 'canceled') return;
        if (event.error === 'not-allowed' || !this.hasEverSpoken) {
          this.#stopWatchdog();
          this.onerror({ blocked: true, error: event.error });
          return;
        }
        this.#finish(token);
      };

      this.utterance = utterance;

      // Firefox can drop an utterance queued in the same tick as a cancel().
      setTimeout(() => {
        if (token !== this.token) return;
        this.synth.speak(utterance);
        this.#startWatchdog(token);
      }, 0);
    }

    // Deliberately not speechSynthesis.pause(): Firefox bug 1258526 leaves
    // the engine wedged with speaking === true until the browser restarts.
    // Cancelling and re-speaking the sentence costs at most one sentence of
    // position and always recovers.
    pause() {
      this.paused = true;
      this.stop();
    }

    resume() {
      if (!this.paused) return;
      this.paused = false;
      if (this.lastText) {
        this.speak(this.lastText, { rate: this.rate, voiceName: this.voiceName });
      }
    }

    setRate(rate) {
      this.rate = rate;
      if (!this.paused && this.lastText) {
        this.speak(this.lastText, { rate, voiceName: this.voiceName });
      }
    }

    stop() {
      this.token++;
      this.#stopWatchdog();
      if (this.utterance) {
        this.utterance.onend = null;
        this.utterance.onerror = null;
        this.utterance.onstart = null;
        this.utterance = null;
      }
      this.synth.cancel();
    }

    destroy() {
      this.stop();
    }

    #finish(token) {
      if (token !== this.token) return;
      this.#stopWatchdog();
      this.onended();
    }

    // Firefox sometimes never fires onend, which used to strand playback
    // with no way back but a reload. Watch the engine instead.
    #startWatchdog(token) {
      this.#stopWatchdog();
      let started = false;
      const startedAt = Date.now();

      this.watchdog = setInterval(() => {
        if (token !== this.token) {
          this.#stopWatchdog();
          return;
        }
        if (this.synth.speaking || this.synth.pending) {
          started = true;
          return;
        }
        if (!started) {
          if (Date.now() - startedAt < 3000) return;
          this.#stopWatchdog();
          // Retry a sentence once before giving up on it.
          if (this.retriedText !== this.lastText) {
            this.retriedText = this.lastText;
            this.speak(this.lastText, { rate: this.rate, voiceName: this.voiceName });
            return;
          }
          // Nothing has ever spoken here, so the engine is unavailable
          // rather than stuck on one sentence. Skipping would silently burn
          // the whole chapter.
          if (!this.hasEverSpoken) {
            this.onerror({ blocked: true, error: 'engine-unavailable' });
            return;
          }
        }
        this.#finish(token);
      }, 500);
    }

    #stopWatchdog() {
      if (this.watchdog) {
        clearInterval(this.watchdog);
        this.watchdog = null;
      }
    }
  }

  /* ===================================================================
     Piper — neural voices, synthesised and played in the background page
     =================================================================== */

  class PiperEngine {
    constructor() {
      this.id = 'piper';
      this.onended = () => {};
      this.onerror = () => {};

      this.voiceId = '';
      this.rate = 1;
      this.token = 0;
      this.paused = false;
    }

    async init() {
      // Nothing to prepare here; the worker starts on first use so that
      // merely opening the reader does not load 28MB of runtime.
    }

    handleBackgroundMessage(request) {
      if (request.action === 'TTSFLOW_PIPER_ENDED') {
        if (!this.paused) this.onended();
        return true;
      }
      if (request.action === 'TTSFLOW_PIPER_ERROR') {
        this.onerror({ error: request.error });
        return true;
      }
      return false;
    }

    async speak(text, { rate = 1, voiceId = '', nextText = '' } = {}) {
      this.voiceId = voiceId || this.voiceId;
      this.rate = rate;
      this.paused = false;
      const token = ++this.token;

      const reply = await bg('TTSFLOW_PIPER_SPEAK', {
        text,
        nextText,
        voiceId: this.voiceId,
        rate
      });

      if (token !== this.token) return;
      if (!reply.ok) this.onerror({ error: reply.error || 'synthesis failed' });
    }

    pause() {
      this.paused = true;
      bg('TTSFLOW_PIPER_PAUSE');
    }

    resume() {
      this.paused = false;
      bg('TTSFLOW_PIPER_RESUME');
    }

    setRate(rate) {
      this.rate = rate;
      bg('TTSFLOW_PIPER_RATE', { rate });
    }

    stop() {
      this.token++;
      this.paused = false;
      bg('TTSFLOW_PIPER_STOP');
    }

    destroy() {
      this.stop();
    }
  }

  NS.engines = { NativeEngine, PiperEngine, bg };
})();
