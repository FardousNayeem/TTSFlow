/* =========================================================================
   Reader ownership arbiter.

   Exactly one tab may speak at a time. A tab must claim ownership here
   before reading, and chapter-to-chapter autoplay travels as a single-use,
   tab-bound, expiring token rather than a localStorage flag — which was
   origin-wide, so it started every other tab of the same site, and survived
   restarts, so pages started talking unprompted.
   ========================================================================= */

globalThis.TTSFlowArbiter = (() => {
  const STATE_KEY = 'ttsflow_state';

  // A resume token covers one navigation. 90s allows a slow chapter load;
  // longer than that means the user went somewhere on their own.
  const RESUME_TTL_MS = 90000;

  // storage.session is cleared when the browser closes, which is what we
  // want. Older builds fall back to storage.local, cleared on startup.
  const area = browser.storage.session || browser.storage.local;

  const EMPTY = { ownerTabId: null, resume: null };

  async function readState() {
    try {
      const got = await area.get(STATE_KEY);
      return got[STATE_KEY] || { ...EMPTY };
    } catch (e) {
      return { ...EMPTY };
    }
  }

  async function writeState(state) {
    try {
      await area.set({ [STATE_KEY]: state });
    } catch (e) {
      /* storage unavailable; ownership degrades to first-come this run */
    }
  }

  async function clearState() {
    try {
      await area.remove(STATE_KEY);
    } catch (e) {
      /* nothing to clear */
    }
  }

  function tellTab(tabId, message) {
    if (tabId == null) return;
    Promise.resolve(browser.tabs.sendMessage(tabId, message)).catch(() => {});
  }

  async function releaseTab(tabId) {
    const state = await readState();
    let dirty = false;
    if (state.ownerTabId === tabId) {
      state.ownerTabId = null;
      dirty = true;
    }
    if (state.resume && state.resume.tabId === tabId) {
      state.resume = null;
      dirty = true;
    }
    if (dirty) await writeState(state);
  }

  async function handle(action, tabId, request) {
    const state = await readState();

    switch (action) {
      // Take the reader lock, stopping whichever tab held it before.
      case 'TTSFLOW_CLAIM': {
        if (tabId == null) return { ok: false };
        if (state.ownerTabId != null && state.ownerTabId !== tabId) {
          tellTab(state.ownerTabId, { action: 'TTSFLOW_RELEASE' });
        }
        await writeState({ ownerTabId: tabId, resume: null });
        return { ok: true };
      }

      case 'TTSFLOW_RELEASE_SELF': {
        if (tabId != null && state.ownerTabId === tabId) {
          await writeState({ ownerTabId: null, resume: null });
        }
        return { ok: true };
      }

      // About to navigate: leave a note for the page about to load in this
      // tab, and only it.
      case 'TTSFLOW_ARM_RESUME': {
        if (tabId == null || state.ownerTabId !== tabId) return { ok: false };
        state.resume = { tabId, expiresAt: Date.now() + RESUME_TTL_MS };
        await writeState(state);
        return { ok: true };
      }

      // Read and burn the note. Another tab asking gets nothing, and must
      // not consume a token that still belongs to the tab that armed it.
      case 'TTSFLOW_CONSUME_RESUME': {
        const token = state.resume;
        const valid = !!token && token.tabId === tabId && Date.now() < token.expiresAt;
        if (token && (token.tabId === tabId || Date.now() >= token.expiresAt)) {
          state.resume = null;
          if (valid) state.ownerTabId = tabId;
          await writeState(state);
        }
        return { resume: valid };
      }

      case 'TTSFLOW_IS_OWNER':
        return { isOwner: tabId != null && state.ownerTabId === tabId };

      default:
        return null; // not ours
    }
  }

  const ACTIONS = new Set([
    'TTSFLOW_CLAIM',
    'TTSFLOW_RELEASE_SELF',
    'TTSFLOW_ARM_RESUME',
    'TTSFLOW_CONSUME_RESUME',
    'TTSFLOW_IS_OWNER'
  ]);

  return { handle, clearState, releaseTab, readState, ACTIONS };
})();
