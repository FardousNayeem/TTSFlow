/* =========================================================================
   Voice picker.

   A <select> cannot host per-row buttons — <option> may only contain text —
   so the picker is a small panel: system voices at the top, then the Piper
   neural voices, each with a download or delete control and a live progress
   bar while it transfers.
   ========================================================================= */

(() => {
  'use strict';

  const NS = (globalThis.TTSFlow = globalThis.TTSFlow || {});
  if (NS.VoicePanel) return;

  const { bg } = NS.engines;

  const mb = (bytes) => (bytes >= 1048576 ? `${Math.round(bytes / 1048576)} MB` : `${Math.round(bytes / 1024)} KB`);

  class VoicePanel {
    constructor({ onSelect, onNotice }) {
      this.onSelect = onSelect;
      this.onNotice = onNotice || (() => {});

      this.systemVoices = [];
      this.piperVoices = [];
      this.piperError = '';
      this.downloading = new Map(); // voiceId -> {loaded, total}
      this.filter = '';
      this.open = false;

      this.selection = { engine: 'native', voiceName: '', voiceId: '' };

      this.root = null;
      this.button = null;
      this.panel = null;
    }

    /* ----------------------------------------------------------------
       Mounting
       ---------------------------------------------------------------- */

    mount(container) {
      this.root = document.createElement('div');
      this.root.id = 'ttsflow-voice';

      this.button = document.createElement('button');
      this.button.type = 'button';
      this.button.id = 'ttsflow-voice-button';
      this.button.textContent = 'Loading voices…';
      this.button.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggle();
      });

      this.panel = document.createElement('div');
      this.panel.id = 'ttsflow-voice-panel';
      this.panel.hidden = true;
      this.panel.addEventListener('click', (e) => e.stopPropagation());

      this.root.append(this.button, this.panel);
      container.appendChild(this.root);

      // Clicking anywhere else closes the panel.
      this.outsideClick = () => this.close();
      document.addEventListener('click', this.outsideClick, true);

      return this.root;
    }

    destroy() {
      document.removeEventListener('click', this.outsideClick, true);
      if (this.root) this.root.remove();
    }

    toggle() {
      this.open ? this.close() : this.show();
    }

    show() {
      this.open = true;
      this.panel.hidden = false;
      this.render();
    }

    close() {
      this.open = false;
      if (this.panel) this.panel.hidden = true;
    }

    /* ----------------------------------------------------------------
       Data
       ---------------------------------------------------------------- */

    setSystemVoices(voices) {
      this.systemVoices = voices;
      this.renderButton();
    }

    setSelection(selection) {
      this.selection = { ...this.selection, ...selection };
      this.renderButton();
      if (this.open) this.render();
    }

    // Loaded lazily the first time the panel is opened, so a reader that
    // only ever uses system voices never wakes the Piper worker.
    async loadPiperVoices() {
      if (this.piperVoices.length || this.piperLoading) return;
      this.piperLoading = true;
      if (this.open) this.render();

      const reply = await bg('TTSFLOW_PIPER_LIST');
      this.piperLoading = false;

      if (reply && reply.voices) {
        this.piperVoices = reply.voices;
        this.piperError = '';
      } else {
        this.piperError = (reply && reply.error) || 'Piper runtime unavailable';
      }
      if (this.open) this.render();
    }

    handleProgress(voiceId, loaded, total) {
      this.downloading.set(voiceId, { loaded, total });
      if (this.open) this.renderRow(voiceId);
    }

    /* ----------------------------------------------------------------
       Actions
       ---------------------------------------------------------------- */

    async download(voiceId) {
      this.downloading.set(voiceId, { loaded: 0, total: 0 });
      this.renderRow(voiceId);

      const reply = await bg('TTSFLOW_PIPER_DOWNLOAD', { voiceId });
      this.downloading.delete(voiceId);

      if (reply && reply.ok !== false && !reply.error) {
        const voice = this.piperVoices.find((v) => v.id === voiceId);
        if (voice) voice.installed = true;
        this.onNotice(`Downloaded ${voice ? voice.name : voiceId}.`);
      } else {
        this.onNotice(`Download failed: ${(reply && reply.error) || 'unknown error'}`);
      }
      if (this.open) this.render();
      this.renderButton();
    }

    async remove(voiceId) {
      const voice = this.piperVoices.find((v) => v.id === voiceId);
      const label = voice ? voice.name : voiceId;
      if (!window.confirm(`Delete the "${label}" voice? It can be downloaded again later.`)) {
        return;
      }

      const reply = await bg('TTSFLOW_PIPER_REMOVE', { voiceId });
      if (reply && !reply.error) {
        if (voice) voice.installed = false;
        // Fall back to a system voice if the active one was just deleted.
        if (this.selection.engine === 'piper' && this.selection.voiceId === voiceId) {
          if (this.systemVoices.length) {
            this.pickSystem(this.systemVoices[0]);
          } else {
            // No system voice to fall back to, which is the normal state on
            // a Linux box with no speech-dispatcher voices. Clear the
            // selection rather than leaving it aimed at a deleted model.
            this.setSelection({ engine: 'native', voiceId: '', voiceName: '' });
            this.onSelect(this.selection);
          }
        }
        this.onNotice(`Deleted ${label}.`);
      } else {
        this.onNotice(`Could not delete: ${(reply && reply.error) || 'unknown error'}`);
      }
      if (this.open) this.render();
    }

    pickSystem(voice) {
      if (!voice) return;
      this.setSelection({ engine: 'native', voiceName: voice.name, voiceId: '' });
      this.onSelect(this.selection);
      this.close();
    }

    async pickPiper(voice) {
      if (!voice.installed) {
        await this.download(voice.id);
        const fresh = this.piperVoices.find((v) => v.id === voice.id);
        if (!fresh || !fresh.installed) return;
      }
      this.setSelection({ engine: 'piper', voiceId: voice.id, voiceName: voice.name });
      this.onSelect(this.selection);
      this.close();
    }

    /* ----------------------------------------------------------------
       Rendering
       ---------------------------------------------------------------- */

    renderButton() {
      if (!this.button) return;
      const { engine, voiceName } = this.selection;
      const label = voiceName || 'Select voice';
      this.button.textContent = engine === 'piper' ? `${label} · neural` : label;
      this.button.title = label;
    }

    installedSummary() {
      const installed = this.piperVoices.filter((v) => v.installed);
      const bytes = installed.reduce((sum, v) => sum + v.bytes, 0);
      return { count: installed.length, bytes };
    }

    render() {
      if (!this.panel) return;
      this.panel.textContent = '';
      this.loadPiperVoices();

      /* --- search --- */
      const search = document.createElement('input');
      search.type = 'search';
      search.id = 'ttsflow-voice-search';
      search.placeholder = 'Search voices…';
      search.value = this.filter;
      search.addEventListener('input', (e) => {
        this.filter = e.target.value.toLowerCase();
        this.renderList();
      });
      this.panel.appendChild(search);

      this.list = document.createElement('div');
      this.list.id = 'ttsflow-voice-list';
      this.panel.appendChild(this.list);

      /* --- storage footer --- */
      const { count, bytes } = this.installedSummary();
      const footer = document.createElement('div');
      footer.id = 'ttsflow-voice-footer';

      const summary = document.createElement('span');
      summary.textContent = count
        ? `${count} voice${count === 1 ? '' : 's'} · ${mb(bytes)} on disk`
        : 'No neural voices downloaded';
      footer.appendChild(summary);

      if (count) {
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'ttsflow-link-btn';
        clear.textContent = 'Delete all';
        clear.addEventListener('click', async () => {
          if (!window.confirm(`Delete all ${count} downloaded voices (${mb(bytes)})?`)) return;
          await bg('TTSFLOW_PIPER_FLUSH');
          this.piperVoices.forEach((v) => (v.installed = false));
          if (this.selection.engine === 'piper') this.pickSystem(this.systemVoices[0]);
          this.onNotice('Deleted all downloaded voices.');
          this.render();
        });
        footer.appendChild(clear);
      }

      this.panel.appendChild(footer);
      this.renderList();
      search.focus();
    }

    renderList() {
      if (!this.list) return;
      this.list.textContent = '';
      const term = this.filter;

      /* --- system --- */
      const system = this.systemVoices.filter(
        (v) => !term || `${v.name} ${v.lang}`.toLowerCase().includes(term)
      );

      if (system.length) {
        this.list.appendChild(this.groupHeader('System voices', 'always available'));
        for (const voice of system) {
          const row = this.rowShell(
            voice.name,
            `${voice.lang}`,
            this.selection.engine === 'native' && this.selection.voiceName === voice.name
          );
          row.body.addEventListener('click', () => this.pickSystem(voice));
          this.list.appendChild(row.el);
        }
      }

      /* --- piper --- */
      this.list.appendChild(
        this.groupHeader('Neural voices (Piper)', 'downloaded to your computer')
      );

      if (this.piperLoading) {
        this.list.appendChild(this.note('Loading voice list…'));
        return;
      }
      if (this.piperError) {
        this.list.appendChild(this.note(this.piperError));
        return;
      }

      const piper = this.piperVoices.filter((v) => {
        if (!term) {
          // Default to English, or anything already installed — the full
          // catalogue is well over a hundred voices.
          return v.installed || v.languageCode.startsWith('en');
        }
        return `${v.name} ${v.languageCode} ${v.languageName} ${v.quality}`
          .toLowerCase()
          .includes(term);
      });

      if (!piper.length) {
        this.list.appendChild(this.note('No voices match. Try a language, e.g. "de".'));
        return;
      }

      // Installed first, then alphabetically.
      piper.sort((a, b) => Number(b.installed) - Number(a.installed) || a.name.localeCompare(b.name));

      for (const voice of piper) this.list.appendChild(this.piperRow(voice));
    }

    groupHeader(title, hint) {
      const el = document.createElement('div');
      el.className = 'ttsflow-voice-group';
      const strong = document.createElement('span');
      strong.textContent = title;
      const small = document.createElement('em');
      small.textContent = hint;
      el.append(strong, small);
      return el;
    }

    note(text) {
      const el = document.createElement('div');
      el.className = 'ttsflow-voice-note';
      el.textContent = text;
      return el;
    }

    rowShell(name, meta, selected) {
      const el = document.createElement('div');
      el.className = 'ttsflow-voice-row' + (selected ? ' selected' : '');

      const body = document.createElement('button');
      body.type = 'button';
      body.className = 'ttsflow-voice-body';

      const nameEl = document.createElement('span');
      nameEl.className = 'ttsflow-voice-name';
      if (selected) nameEl.appendChild(NS.icon('check', { size: 15, className: 'ttsflow-voice-check' }));
      nameEl.append(name);

      const metaEl = document.createElement('span');
      metaEl.className = 'ttsflow-voice-meta';
      metaEl.textContent = meta;

      body.append(nameEl, metaEl);
      el.appendChild(body);
      return { el, body };
    }

    piperRow(voice) {
      const selected = this.selection.engine === 'piper' && this.selection.voiceId === voice.id;
      const meta = `${voice.languageCode} · ${voice.quality} · ${mb(voice.bytes)}`;
      const { el, body } = this.rowShell(voice.name, meta, selected);
      el.dataset.voiceId = voice.id;

      body.addEventListener('click', () => this.pickPiper(voice));
      el.appendChild(this.piperAction(voice));
      return el;
    }

    // The download / progress / delete control at the end of a Piper row.
    piperAction(voice) {
      const wrap = document.createElement('div');
      wrap.className = 'ttsflow-voice-action';

      const progress = this.downloading.get(voice.id);

      if (progress) {
        const bar = document.createElement('div');
        bar.className = 'ttsflow-voice-progress';
        const fill = document.createElement('div');
        const pct = progress.total ? Math.round((progress.loaded / progress.total) * 100) : 0;
        fill.style.width = `${pct}%`;
        bar.appendChild(fill);

        const label = document.createElement('span');
        label.className = 'ttsflow-voice-pct';
        label.textContent = progress.total ? `${pct}%` : '…';

        wrap.append(bar, label);
        return wrap;
      }

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ttsflow-voice-icon';

      if (voice.installed) {
        button.classList.add('danger');
        button.title = `Delete ${voice.name} (${mb(voice.bytes)})`;
        button.setAttribute('aria-label', `Delete ${voice.name}`);
        button.appendChild(NS.icon('trash', { size: 17 }));
        button.addEventListener('click', (e) => {
          e.stopPropagation();
          this.remove(voice.id);
        });
      } else {
        button.title = `Download ${voice.name} (${mb(voice.bytes)})`;
        button.setAttribute('aria-label', `Download ${voice.name}`);
        button.appendChild(NS.icon('download', { size: 17 }));
        button.addEventListener('click', (e) => {
          e.stopPropagation();
          this.download(voice.id);
        });
      }

      wrap.appendChild(button);
      return wrap;
    }

    // Repaint one row in place so a download progress tick does not rebuild
    // the list under the user's cursor.
    renderRow(voiceId) {
      if (!this.list) return;
      const row = this.list.querySelector(`[data-voice-id="${CSS.escape(voiceId)}"]`);
      if (!row) return;
      const voice = this.piperVoices.find((v) => v.id === voiceId);
      if (!voice) return;
      const action = row.querySelector('.ttsflow-voice-action');
      if (action) action.replaceWith(this.piperAction(voice));
    }
  }

  NS.VoicePanel = VoicePanel;
})();
