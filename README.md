# TTSFlow

### Turn your web novels into your own private audiobook.

**TTSFlow is a Firefox extension made for people who read web novels on sites like Royal Road, WebNovels, Scribble Hub, and similar platforms.**

Press **Start Reading**, put your headphones on, and let TTSFlow handle the rest.

**No copying chapters. No uploading text. No cloud required.**

[🦊 Get TTSFlow for Firefox](https://addons.mozilla.org/en-US/firefox/addon/ttsflow/?utm_source=chatgpt.com)

---

## 📖 Read. Listen. Keep going.

TTSFlow turns long web-novel sessions into a continuous listening experience.

It can:

* **Start reading the current chapter**
* **Automatically continue to the next chapter**
* **Highlight the sentence currently being spoken**
* **Click any sentence to jump there**
* **Remember where you stopped**
* **Adjust reading speed from 0.5× to 2.5×**
* **Adjust voice pitch, on system and neural voices alike**
* **Preview any voice before you commit to it**
* **Use your system's voices**
* **Use offline neural Piper voices**
* **Keep neural speech processing on your own machine**

You don't have to babysit the page.

**Start a chapter → put the browser aside → keep listening.**

---

## Install it in seconds

TTSFlow is already available on the Firefox Add-ons store.

[Install TTSFlow → Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/ttsflow/?utm_source=chatgpt.com)

After installing:

1. Open a chapter on your favourite web-novel site.
2. Click the **TTSFlow** icon in Firefox.
3. Click **Start Reading**.
4. Listen.

That's it.

> **Nothing starts playing automatically just because you opened a page.**
> You always choose when reading begins.

---

## 🎧 Two ways to listen

### System voices

Works immediately after installation.

TTSFlow uses the voices exposed by your operating system and Firefox, so there is **nothing to download**.

Perfect if you just want to install the extension and start listening.

### Offline neural voices

Want something more natural?

TTSFlow can use **Piper neural TTS voices** that run locally on your computer.

Each voice is downloaded separately, so you decide which voices you keep.

Once downloaded:

**No cloud API.
No account.
No subscription.
No internet connection required for synthesis.**

The models run through WebAssembly on your CPU.

---

## Built for long-form web fiction

Most browser TTS tools are designed around reading an article or a selected block of text.

TTSFlow is designed around something different:

**reading chapter after chapter.**

When it reaches the end of a chapter, TTSFlow looks for the site's **Next Chapter** link and can continue reading without making you restart the reader.

That means your workflow can become:

> **Open novel → Start Reading → listen**

instead of:

> Open chapter → copy text → start TTS → finish → find next chapter → restart → repeat...

---

## Stay in the story

While TTSFlow is reading:

**The current sentence is highlighted.**

The page follows along as the narration progresses, making it easy to keep your eyes on the story if you want to read along.

And if you hear something you want to revisit:

**Click the sentence.**

Playback jumps there immediately.

---

## Never lose your place

TTSFlow remembers your reading position.

Close the chapter.

Come back later.

**Pick up where you left off.**

Your reading position is stored locally.

---

## Local-first by design

TTSFlow is designed to keep your reading experience on your machine.

There is:

* No account
* No text-to-speech subscription
* No cloud TTS requirement
* No need to upload chapters to a server for neural voices

System voices run through your browser/OS.

Piper voices run locally through WebAssembly.

Your web novel stays where it belongs:

**in your browser.**

---

## Simple controls

TTSFlow reads the page you already have open. There's no separate reader view: the sentence being spoken is highlighted right in the chapter, in the site's own layout and theme.

The controls sit in a slim dock on the right edge, out of the text column, and fade back while you listen. Drag the TTSFlow logo to move the dock up or down. On narrow screens it becomes a small bar along the bottom.

**Play / Pause**
**Previous sentence**
**Next sentence**
**Speed** (presets, a slider, or scroll the wheel over the speed readout)
**Voice**
**Close**

Scroll away to reread something and the page stops following the voice for a few seconds.

Keyboard shortcuts:

| Key     | Action            |
| ------- | ----------------- |
| `Space` | Play / Pause      |
| `←`     | Previous sentence |
| `→`     | Next sentence     |
| `Esc`   | Close reader      |

---

## One reader at a time

TTSFlow deliberately allows only one active reader.

Start TTSFlow in another tab and the previous reader stops.

This prevents the classic:

> "Why are two chapters talking at the same time?"

problem.

Chapter-to-chapter autoplay is also protected by a short-lived, tab-bound handoff token, so an old page cannot unexpectedly start speaking later.

---

# Want better voices?

Enable the optional **Piper neural voices**.

The runtime is not included in the source tree because it is roughly 28 MB.

For development/building:

```bash
npm install
npm run vendor
```

Then reload the extension.

The Settings page will show the available neural voice catalogue.

Each voice has its own:

**Download → Use → Delete**

controls.

Keep only the voices you actually want.

---

## Installation for developers

Clone or download the repository.

Open:

```text
about:debugging#/runtime/this-firefox
```

Then:

1. Click **Load Temporary Add-on...**
2. Select `manifest.json`.
3. Open a web-novel chapter.
4. Click the TTSFlow toolbar icon.

TTSFlow requires **Firefox 140 or newer**.

---

## Development

```bash
npm install
npm run vendor
node build/icons.mjs
npx web-ext lint
```

`npm install` is build tooling only. The extension itself is plain files.

`npm run vendor`:

* fetches the espeak-ng phonemizer
* copies the ONNX Runtime binary
* bundles the Piper worker
* verifies that no remote-code reference remains in the generated bundle

The packaged extension therefore does not load executable code from the network.

---

## How it works

TTSFlow separates the reader from the speech engine.

### `background/arbiter.js`

Controls which browser tab owns the reader.

Chapter-to-chapter autoplay uses a single-use token tied to the originating tab and expiring after 90 seconds.

### `background/piper.js`

Owns the neural inference worker and audio playback.

Keeping inference in the background prevents a host page's CSP from interfering with the runtime.

### `content/engines.js`

Provides one interface for both system and neural voices, keeping the reader independent from the selected TTS engine.

### Pitch

Piper's VITS models accept only `[noise_scale, length_scale, noise_w]`, so there is no pitch input to synthesis.

Instead the generated WAV is re-labelled with a scaled sample rate. That resamples it on playback, raising pitch and shortening duration by the same factor, and the audio element's pitch-preserving time-stretch restores the original duration.

Pitch and tempo end up independent for the cost of rewriting eight header bytes.

### `piper/worker.src.js`

The Piper worker source is bundled into:

```text
piper/worker.js
```

by:

```bash
npm run vendor
```

---

## Linux note

On Linux, Firefox system voices commonly come through speech-dispatcher, often using espeak-ng.

They're useful and lightweight, but they can sound robotic.

If Firefox exposes no system voices, make sure speech-dispatcher has a voice configured.

For a more natural experience, use a Piper neural voice instead.

---

# Give your eyes a break.

If you're already spending hours reading web novels, let TTSFlow turn some of that reading time into listening time.

**Install it. Open a chapter. Press Start Reading.**

[🦊 Install TTSFlow on Firefox](https://addons.mozilla.org/en-US/firefox/addon/ttsflow/?utm_source=chatgpt.com)

---

## License

Icon path data comes from [Tabler Icons](https://tabler.io/icons) and is licensed under MIT.
