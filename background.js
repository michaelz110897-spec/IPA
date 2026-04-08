// Background service worker.
//   - Tracks which tabs have the cursor scanner enabled.
//   - Routes 130x130 crop OCR requests from the content script to the
//     offscreen Tesseract worker.

const activeTabs = new Set();

let creatingOffscreen = null;

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }
  creatingOffscreen = chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["WORKERS"],
    justification: "Run Tesseract.js OCR worker for the price scanner.",
  });
  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || tab.id == null) return;
  const nextActive = !activeTabs.has(tab.id);
  if (nextActive) {
    activeTabs.add(tab.id);
    // Warm up the OCR worker as soon as scanning is enabled so the first
    // image-baked price doesn't have to wait for Tesseract bootstrap.
    ensureOffscreen().catch(() => {});
  } else {
    activeTabs.delete(tab.id);
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "pce-toggle", active: nextActive });
  } catch (err) {
    if (nextActive) activeTabs.delete(tab.id);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  activeTabs.delete(tabId);
});

// Content script asks us to OCR a 130x130 crop around the cursor.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "pce-scan-crop") return;
  (async () => {
    try {
      const tab = sender.tab;
      if (!tab || tab.windowId == null) {
        sendResponse({ ok: false, error: "no tab" });
        return;
      }
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      await ensureOffscreen();
      const reply = await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "pce-ocr",
        dataUrl,
        rect: msg.rect,
        dpr: msg.dpr,
      });
      sendResponse(reply || { ok: false, error: "no reply" });
    } catch (err) {
      sendResponse({ ok: false, error: String(err && err.message || err) });
    }
  })();
  return true;
});
