# TTSFlow

A continuous text-to-speech reader for web novels, built for Firefox. It scrapes
chapter text, highlights sentences as they are read, follows "next chapter"
links on its own, and can read with either your system voices or offline neural
voices that run entirely on your own machine.

---

## Features

* **Continuous auto-play.** Detects the next-chapter link and keeps reading.
* **Two voice engines.** Your operating system's voices work with no download.
  Piper neural voices sound dramatically better and run locally and offline.
* **Per-voice downloads.** Each neural voice is a self-contained model with its
  own download and delete control, so you keep only the ones you want.
* **One tab at a time.** Starting TTSFlow in a second tab stops the first, and
  no page ever begins reading on its own.
* **Click to jump.** Click any sentence to move playback there.
* **Remembers your place.** Reopen a chapter where you left off.
* **Settings page.** Speed, voices, chapter behaviour, and storage.

---

## Installation

1. Clone or download this folder.
2. Open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on...** and select `manifest.json`.

This works immediately with your system voices. Needs Firefox 140 or newer.

### Enabling neural voices

The Piper runtime is not checked in, because it is roughly 28 MB of
WebAssembly. Build it once:

```
npm install
npm run vendor
```

Then reload the add-on. The **Neural voices** section of the settings page will
list the catalogue, and each voice downloads on demand.

`npm run vendor` fetches the espeak-ng phonemizer, copies the ONNX Runtime
binary, and bundles the worker. It refuses to finish if any remote-code
reference survives into the bundle, so the packaged extension never loads code
over the network.

---

## Usage

1. Open a chapter, for example on Royal Road or wtr-lab.
2. Click the **TTSFlow** icon, then **Start Reading**.
3. Use the overlay controls to pause, change speed, switch voice, or skip.

Keyboard: `Space` play/pause, `Left`/`Right` skip a sentence, `Esc` close.

The popup also has **Settings** and **Clear Cache**. Clearing the cache removes
saved reading positions and recently synthesised audio; it never deletes
downloaded voices, which have their own controls in Settings.

---

## Voice quality on Linux

Firefox gets its system voices from speech-dispatcher, which usually means
espeak-ng. It is intelligible but robotic. If TTSFlow reports no system voices
at all, speech-dispatcher has none configured.

The Piper voices avoid this entirely. They are ordinary neural TTS models
running through WebAssembly on your CPU, so they need no GPU and no network
once downloaded. Medium-quality English voices are around 60 MB each.

---

## How it works

* `background/arbiter.js` decides which tab owns the reader. Chapter-to-chapter
  autoplay is carried by a single-use token bound to one tab and expiring in 90
  seconds, so a stale flag can never make an unrelated tab start talking.
* `background/piper.js` owns the inference worker and plays neural audio from
  the background page, where no host page's CSP can interfere with it and the
  speed control can change tempo without changing pitch.
* `content/engines.js` puts the system and neural engines behind one interface,
  so the reader never branches on which is in use.
* `piper/worker.src.js` is bundled into `piper/worker.js` by `npm run vendor`.

---

## Development

```
npm install          # build tooling only; the extension itself is plain files
npm run vendor       # build the Piper runtime into piper/vendor/
node build/icons.mjs # regenerate content/icons.js from @tabler/icons
npx web-ext lint     # Mozilla's validator
```

Icon path data comes from [Tabler Icons](https://tabler.io/icons) (MIT).
