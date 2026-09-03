# TTSFlow

A lightweight, continuous Text-to-Speech (TTS) Firefox extension built specifically for web novel readers. It scrapes chapter text, highlights sentences in real-time, features customizable speeds and native browser voices, and auto-navigates through chapters with seamless autoplay.

---

## Features

* **Continuous Auto-Play:** Automatically detects "Next Chapter" links, loads the next page in the background without closing the reader, and keeps reading.
* **Smart Text Scraper:** Automatically cuts off footers, comments, and author notes to focus purely on the story text.
* **Interactive Reader Modal:** Dark, distraction-free overlay with a glassmorphism sticky top navbar.
* **Click-to-Jump:** Click any sentence to instantly jump the audio playback to that exact line.
* **Persistent Settings:** Remembers your preferred voice model and playback speed via local storage.

---

## Installation (Firefox Temporary Add-on)

1. Clone or download this project folder to your computer.
2. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`.
3. Click the **Load Temporary Add-on...** button.
4. Select the `manifest.json` file inside your `TTSFlow` folder.

---

## Usage

1. Open any web novel chapter (e.g., on Royal Road or Scribble Hub).
2. Click the **TTSFlow** extension icon in your Firefox toolbar.
3. The reader overlay will open, and playback will start automatically.
4. Use the navbar controls to pause, change speed, switch voice models, or skip sentences.