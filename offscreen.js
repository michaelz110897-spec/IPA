// Runs in the offscreen document. Hosts a long-lived Tesseract.js worker and
// answers OCR requests from background.js.

let workerPromise = null;

async function getWorker() {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    const base = chrome.runtime.getURL("vendor/tesseract/");
    const worker = await Tesseract.createWorker("eng", 1, {
      workerPath: base + "worker.min.js",
      corePath: base, // tesseract.js will pick simd-lstm or lstm variant
      langPath: base,
      cacheMethod: "none",
      gzip: true,
    });
    await worker.setParameters({
      tessedit_pageseg_mode: "6", // assume a single uniform block of text
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

function flattenWords(data) {
  const out = [];
  if (!data || !data.blocks) return out;
  for (const block of data.blocks) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        for (const w of line.words || []) {
          if (!w || !w.text) continue;
          const t = w.text.trim();
          if (!t) continue;
          out.push({ text: t, bbox: w.bbox });
        }
      }
    }
  }
  return out;
}

async function runOcr(dataUrl, rect, dpr) {
  const worker = await getWorker();
  const bitmap = await dataUrlToBitmap(dataUrl);
  const canvas = await cropToCanvas(bitmap, rect, dpr);
  const result = await worker.recognize(canvas, {}, { blocks: true });
  bitmap.close && bitmap.close();
  return flattenWords(result.data);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen" || msg.type !== "pce-ocr") return;
  runOcr(msg.dataUrl, msg.rect, msg.dpr || 1)
    .then((words) => sendResponse({ ok: true, words }))
    .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
  return true; // async response
});
