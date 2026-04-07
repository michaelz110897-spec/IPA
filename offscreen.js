// Runs in the offscreen document. Hosts a long-lived Tesseract.js worker and
// answers OCR requests from background.js.

let workerPromise = null;

async function getWorker() {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    const base = chrome.runtime.getURL("vendor/tesseract/");
    const worker = await Tesseract.createWorker("eng", 1, {
      workerPath: base + "worker.min.js",
      corePath: base,
      langPath: base,
      cacheMethod: "none",
      gzip: true,
    });
    await worker.setParameters({
      // PSM 11: sparse text, no layout assumption. Retail price stickers
      // are multi-size, multi-line, and sparse; PSM 6 (uniform block)
      // misreads them badly.
      tessedit_pageseg_mode: "11",
    });
    return worker;
  })();
  return workerPromise;
}

async function dataUrlToBitmap(dataUrl) {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  return await createImageBitmap(blob);
}

async function cropToCanvas(bitmap, rect, dpr) {
  const sx = Math.max(0, Math.round(rect.x * dpr));
  const sy = Math.max(0, Math.round(rect.y * dpr));
  const sw = Math.max(1, Math.round(rect.w * dpr));
  const sh = Math.max(1, Math.round(rect.h * dpr));
  const canvas = new OffscreenCanvas(sw, sh);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvas;
}

// Prepares a crop for OCR:
//   1. Optional 3x upscale for small crops (Tesseract accuracy rises sharply
//      once cap-height >= 30 px). Skipped for full-viewport scans -- upscaling
//      a 1920x1080 capture to ~5760x3240 would blow memory and take 30+ s.
//   2. Grayscale via luminance.
//   3. Contrast stretch to [0,255].
// Auto-invert is intentionally NOT done here: on a whole-viewport image the
// mean luminance is dominated by light background, so a global invert either
// never fires or fires on the wrong region. Tesseract's per-region adaptive
// thresholding (PSM 11) handles mixed-contrast pages itself.
function preprocess(srcCanvas, upscale) {
  const scale = upscale ? 3 : 1;
  const w = srcCanvas.width * scale;
  const h = srcCanvas.height * scale;
  const out = new OffscreenCanvas(w, h);
  const ctx = out.getContext("2d", { willReadFrequently: true });
  if (upscale) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
  }
  ctx.drawImage(srcCanvas, 0, 0, w, h);

  const img = ctx.getImageData(0, 0, w, h);
  const data = img.data;
  const n = data.length;

  // Pass 1: grayscale + track min/max for contrast stretch.
  let min = 255;
  let max = 0;
  for (let i = 0; i < n; i += 4) {
    const g = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
    data[i] = data[i + 1] = data[i + 2] = g;
    if (g < min) min = g;
    if (g > max) max = g;
  }

  // Pass 2: contrast stretch to [0,255].
  const range = Math.max(1, max - min);
  for (let i = 0; i < n; i += 4) {
    let g = data[i];
    g = ((g - min) * 255 / range) | 0;
    if (g < 0) g = 0;
    else if (g > 255) g = 255;
    data[i] = data[i + 1] = data[i + 2] = g;
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

function flattenWords(data) {
  const out = [];
  if (!data || !data.blocks) return out;
  let lineId = 0;
  for (const block of data.blocks) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        for (const w of line.words || []) {
          if (!w || !w.text) continue;
          const t = w.text.trim();
          if (!t) continue;
          out.push({ text: t, bbox: w.bbox, lineId });
        }
        lineId++;
      }
    }
  }
  return out;
}

async function runOcr(dataUrl, rect, dpr, fullViewport) {
  const worker = await getWorker();
  const bitmap = await dataUrlToBitmap(dataUrl);
  const cropped = await cropToCanvas(bitmap, rect, dpr);
  const prepped = preprocess(cropped, !fullViewport);
  const result = await worker.recognize(prepped, {}, { blocks: true });
  bitmap.close && bitmap.close();
  return flattenWords(result.data);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen" || msg.type !== "pce-ocr") return;
  runOcr(msg.dataUrl, msg.rect, msg.dpr || 1, !!msg.fullViewport)
    .then((words) => sendResponse({ ok: true, words }))
    .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
  return true;
});
