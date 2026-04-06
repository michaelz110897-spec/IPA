# Price Comparison Scanner

A Chrome/Edge (Manifest V3) browser extension that draws a 100×162 px rectangle around your cursor and live-calculates the `%off` from a displayed price and `SAVE` amount inside that rectangle. Works on HTML pages and PDFs.

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

## PDF support

The extension can also scan prices inside PDF documents. Because Chrome does
not allow content scripts to inject into the built-in PDF viewer, the extension
ships its own viewer (built on Mozilla PDF.js) and automatically switches to it
when you click the toolbar icon on a PDF tab.

- Remote (http/https) PDFs work out of the box.
- For local `file://` PDFs, enable **Allow access to file URLs** for the
  extension at `chrome://extensions` → Details.
- After redirection, each page is rendered with a selectable text layer that
  the scanner reads from as you move your cursor.

## Known limitations

### Adobe Acrobat browser extension
If you have the **Adobe Acrobat: PDF edit, convert, sign tools** Chrome
extension installed, it intercepts PDF navigations and renders them inside
its own extension pages. Chrome forbids any other extension from injecting
into Adobe's viewer, so the scanner cannot read that content directly.

The extension will try a best-effort recovery: if Adobe exposes the original
PDF URL in its viewer's query string, clicking the toolbar icon will redirect
the tab to the bundled PDF.js viewer and scanning will work normally. When
Adobe hides the URL (e.g. it loads the PDF from `acrobat.adobe.com`), you will
see a notification explaining the limitation.

**Workaround**: disable the Adobe Acrobat extension on the page you want to
scan, or turn off its "Open in Acrobat" / default-PDF-handler setting, then
reload. The PDF will then open in Chrome's built-in viewer and the scanner
will redirect it to the bundled PDF.js viewer automatically.

## Files

- `manifest.json` — MV3 manifest
- `background.js` — toggles activation per tab on icon click; redirects PDFs to the bundled viewer
- `content.js` — overlay, cursor tracking, text scanning, price/save detection
- `content.css` — overlay + label styles
- `pdf-viewer.html` / `pdf-viewer.js` — PDF.js-based viewer with a text layer
- `vendor/pdfjs/` — vendored PDF.js build (legacy ESM)
- `icons/` — toolbar icons
