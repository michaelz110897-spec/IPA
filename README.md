# Price Comparison Scanner

A Chrome/Edge (Manifest V3) browser extension that draws a 150×160 px rectangle
around your cursor and live-calculates the `%off` from a displayed price and
`SAVE` amount inside that rectangle. Reads pixels via OCR, so it works on
plain HTML, images, PDFs, and cross-origin iframes alike.

## How it works

- Click the toolbar icon to activate on the current tab (click again to deactivate).
- A dashed rectangle follows your cursor.
- When the cursor settles for ~250 ms, the extension captures the visible tab,
  crops to the rectangle, and runs Tesseract.js OCR on the crop.
- The word boxes returned by OCR are parsed for:
  - **Price** — a dollar amount that has no letter word immediately to its left
    on the same visual line (so `Was $10` and `Reg $15` are skipped). The largest
    such number wins, with `$`-prefixed numbers preferred.
  - **Savings** — the dollar amount physically next to the word `SAVE` on the
    same visual line (spatial association, not just regex order).
- When both are detected, a small label above the top border shows:

  ```
  Price: $49.99  |  Save: $10.00  |  16.67% off
  ```

- Formula: `%off = save / (price + save) * 100` (rounded to 2 decimals).

## Install (unpacked)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. Pin the extension and click its icon on any page to toggle the scanner.

## Quick test

Create a file `test.html` with:

```html
<div style="font-size:24px;padding:40px">$49.99 SAVE $10.00</div>
```

Open it, click the extension icon, hover over the text, and hold still for
~300 ms. The label should read `16.67% off`.

## Notes

- **First scan is slow.** The first OCR call in a session has to load the
  Tesseract WebAssembly runtime and the English language model (~13 MB
  vendored). Expect ~1 s. Subsequent scans reuse the warmed worker and
  typically take 150–400 ms on a 150×160 crop.
- **Capture rate.** Chrome rate-limits `captureVisibleTab` to about 2 Hz.
  The 250 ms settle debounce keeps us well under that.
- **No special PDF mode.** Because everything is OCR over screen pixels, the
  extension reads PDFs in Chrome's built-in viewer, the Adobe Acrobat browser
  extension, image-only flyers, and cross-origin embedded viewers without any
  separate viewer page.

## Files

- `manifest.json` — MV3 manifest
- `background.js` — icon toggle + `captureVisibleTab` + offscreen-document routing
- `offscreen.html` / `offscreen.js` — hosts the long-lived Tesseract.js worker
- `content.js` — overlay, cursor tracking, debounced scan request, spatial parser
- `content.css` — overlay + label styles
- `vendor/tesseract/` — vendored Tesseract.js v5 runtime, WASM, and English model
- `icons/` — toolbar icons
