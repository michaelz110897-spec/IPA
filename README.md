# Price Comparison Scanner

A Chrome/Edge (Manifest V3) browser extension that draws a 100×262 px rectangle around your cursor and live-calculates the `%off` from a displayed price and `SAVE` amount inside that rectangle.

## How it works

- Click the toolbar icon to activate on the current tab (click again to deactivate).
- A dashed rectangle follows your cursor.
- The extension scans text nodes inside the rectangle for:
  - **Price** — a plain dollar amount (e.g. `$49.99`) *not* preceded by a letter/word.
  - **Savings** — a dollar amount preceded by the word `SAVE` (e.g. `SAVE $10.00`).
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

Open it, click the extension icon, and hover over the text. The label should read `16.67% off`.

## Files

- `manifest.json` — MV3 manifest
- `background.js` — toggles activation per tab on icon click
- `content.js` — overlay, cursor tracking, text scanning, price/save detection
- `content.css` — overlay + label styles
- `icons/` — toolbar icons
