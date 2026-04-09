# Price Comparison Scanner

A Chrome/Edge (Manifest V3) browser extension that reads retail prices from
the area around your cursor on any webpage. The 130&times;130&nbsp;px region
under the cursor is captured as an image and sent to Claude Sonnet's vision
API, which returns the current price, save amount, and percent off.

Because detection is purely visual, it works the same way on plain HTML,
JavaScript-rendered text, image-baked prices, canvas/SVG, and PDF viewers.

## How it works

- Click the toolbar icon on any page. A small viewfinder (4 emerald corner
  brackets + a centre dot) follows the cursor.
- Hover over a price. After ~500&nbsp;ms of stillness the corners pulse,
  the extension captures that 130&times;130 box as a PNG, and sends it to
  Claude Sonnet's vision endpoint.
- Claude returns a small JSON object: `{price, was, save, pct}`.
- A glass HUD pill renders next to the cursor: white price, gray
  strike-through `was`, amber `save`, and an emerald `&minus;%` chip.
- Move the cursor and the next stop fires another scan. Recent scans are
  cached for ~5&nbsp;s so re-hovering the same spot is instant.
- Click the icon again to disable.

## Setup

The extension needs an Anthropic API key.

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. Click **Details** on the extension &rarr; **Extension options**.
5. Paste your Anthropic API key (starts with `sk-ant-`) and click **Save**.
   Get a key at <https://console.anthropic.com/settings/keys>.

The key is stored in `chrome.storage.local` and is only sent to
`https://api.anthropic.com`.

## Quick test

`test.html` ships with nine sample price layouts (flat, strikethrough,
percent-off, split typography, JS-rendered, image-baked, canvas-rendered, and
an irrelevant control). Open it from disk, click the toolbar icon, hover any
price, and the HUD should populate within ~1&ndash;2&nbsp;s of the cursor
stopping.

## Notes

- **Cost.** Each scan sends one small image (~130&times;130) to Claude
  Sonnet plus a short prompt and gets back &lt;60 tokens. Scans are
  debounced (500&nbsp;ms idle), thresholded (must move 50&nbsp;px before a
  new scan fires), and cached for 5&nbsp;s, so a typical browsing session
  fires only a few calls per minute.
- **Latency.** A scan typically lands in 1&ndash;2&nbsp;s. The viewfinder
  pulses while the request is in flight.
- **Cross-origin iframes.** The content script runs in every frame
  (`all_frames: true`) and sub-frames forward mousemove coordinates to the
  top frame, so the scanner works inside Adobe's PDF viewer and similar
  embedded contexts.
- **No local OCR.** Earlier revisions used Tesseract.js with a vendored
  language model. The vision-only design removes that ~13&nbsp;MB vendor
  bundle entirely.

## Files

- `manifest.json` &mdash; MV3 manifest, options page, host permissions for
  `api.anthropic.com`.
- `background.js` &mdash; toolbar toggle, `captureVisibleTab` &rarr; in-worker
  crop &rarr; Anthropic Messages API call &rarr; structured JSON parse.
- `content.js` &mdash; cursor viewfinder, mouse handling, debounced scan
  scheduling, label rendering, cross-frame postMessage bridge.
- `content.css` &mdash; viewfinder + glass HUD styles.
- `options.html` / `options.js` &mdash; API key entry/storage.
- `test.html` &mdash; sample price layouts for smoke-testing.
- `icons/` &mdash; toolbar icons.
