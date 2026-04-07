# Price Comparison Scanner

A Chrome/Edge (Manifest V3) browser extension that scans the visible page for
retail price stickers and draws highlights on every price and `SAVE` amount it
finds, labeled with the computed `%off`. Reads pixels via OCR, so it works on
plain HTML, images, PDFs, and cross-origin iframes alike.

## How it works

- Click the toolbar icon on any page. A small "Scanning page…" chip
  appears in the top-right while OCR runs.
- The extension captures the whole visible viewport, runs Tesseract.js over it,
  and spatially clusters the OCR words into per-sticker groups.
- For each sticker it identifies:
  - **Price** — a dollar amount that has no `Was`/`Reg`/`MSRP`-style word
    immediately to its left on the same visual line. Big-dollar + small-cents
    typographic splits (e.g. `$11` with a superscript `99`) are fused into one
    price. Prefixes like `FROM`, `NOW`, `ONLY` are recognised.
  - **Savings** — the nearest dollar amount in a local neighborhood around a
    `SAVE` marker word (handles `SAVE $X`, `SAVE UP TO $X`, multi-line bands,
    trailing disclaimer marks).
- Each identified pair is highlighted:
  - Lime-green outline around the price bbox.
  - Orange outline around the save bbox.
  - A dark pill floating above the price with e.g.
    `$21.99 · save $15.00 · 40.54% off`.
- Prices without a matching `SAVE` band are still highlighted, labeled with
  just the price.
- Click the icon again to clear all highlights.
- Formula: `%off = save / (price + save) * 100` (rounded to 2 decimals).

## Install (unpacked)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. Pin the extension and click its icon on any page to scan it.

## Quick test

Create a file `test.html` with:

```html
<div style="font-size:24px;padding:40px">$49.99 SAVE $10.00</div>
```

Open it and click the extension icon. Within a few seconds you should see a
green outline on `$49.99`, an orange outline on `$10.00`, and a label reading
`$49.99 · save $10.00 · 16.67% off`.

## Notes

- **First scan is slow.** The first OCR call in a session has to load the
  Tesseract WebAssembly runtime and the English language model (~13 MB
  vendored). A full-viewport scan on a 1920×1080 capture typically takes
  2–5 s warm. Subsequent scans reuse the warmed worker.
- **No cursor tracking.** Rev 6 replaced the cursor-following rectangle with
  a one-shot full-page scan: you get every price at once instead of having to
  hover each sticker.
- **Highlights scroll with the page.** Overlays are page-absolute, so
  scrolling after a scan still aligns them with the underlying content.
- **No special PDF mode.** Because everything is OCR over screen pixels, the
  extension reads PDFs in Chrome's built-in viewer, the Adobe Acrobat browser
  extension, image-only flyers, and cross-origin embedded viewers without any
  separate viewer page.

## Files

- `manifest.json` — MV3 manifest
- `background.js` — icon toggle + `captureVisibleTab` + offscreen-document routing
- `offscreen.html` / `offscreen.js` — hosts the long-lived Tesseract.js worker
- `content.js` — one-shot viewport scan, spatial clustering, highlight rendering
- `content.css` — highlight and toast styles
- `vendor/tesseract/` — vendored Tesseract.js v5 runtime, WASM, and English model
- `icons/` — toolbar icons
