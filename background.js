// Background service worker.
//
// Responsibilities:
//   - Track which tabs have the cursor scanner enabled.
//   - When the content script asks to scan the 130x130 cursor box, capture
//     the visible viewport, crop the requested region in-worker via
//     OffscreenCanvas, and send the cropped PNG to Claude vision (Sonnet)
//     for structured price extraction.
//   - Read the Anthropic API key from chrome.storage.local (set via the
//     options page).

const STORAGE_KEY = "anthropicApiKey";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL_ID = "claude-sonnet-4-6";
const MAX_TOKENS = 200;

const PRICE_PROMPT = [
  "You are a price extraction tool. The image is a small screenshot crop",
  "(roughly 130x130 css px, upscaled 3x) showing the area around a user's",
  "cursor on a webpage, web app, or PDF document.",
  "",
  "Read every visible character carefully — the crop may contain a price",
  "tag, a product listing, a line in a PDF table, an invoice row, body",
  "text mentioning a dollar amount, or just an empty area. Extract the",
  "single most prominent monetary price you see, even if it is rendered",
  "in plain body text without bold or color emphasis.",
  "",
  "Return ONLY a JSON object on one line, with no prose, no markdown, no",
  "code fences. Schema:",
  '  {"price": number|null, "was": number|null, "save": number|null, "pct": number|null}',
  "",
  "Field semantics:",
  "  price : the current/sale price in dollars as a number (e.g. 49.99).",
  "          If only one price is shown, that is the price.",
  "  was   : the original/regular/list/MSRP price if shown (often",
  "          strikethrough or labelled was/reg/orig/list/msrp). Number,",
  "          or null.",
  "  save  : the savings amount in dollars (e.g. SAVE $10 -> 10). Number,",
  "          or null.",
  "  pct   : the discount percent as an integer (e.g. 25 means 25% off),",
  "          if explicitly shown. Number, or null.",
  "",
  "Recognise prices in any common format: $49.99, USD 49.99, 49.99, 49,99,",
  "1,299.00, $1.2K, 49.99 USD. Strip currency symbols and thousands",
  "separators when filling the JSON. If a price is partially cropped at",
  "the edge of the image but the full number is still readable, include",
  "it. If no price-like number is visible at all, return:",
  '  {"price": null, "was": null, "save": null, "pct": null}',
].join("\n");

const activeTabs = new Set();

// ---------- toolbar toggle ----------

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || tab.id == null) return;
  const nextActive = !activeTabs.has(tab.id);
  if (nextActive) {
    activeTabs.add(tab.id);
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

// ---------- scan handler ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "pce-scan-claude") return;
  (async () => {
    try {
      const tab = sender.tab;
      if (!tab || tab.windowId == null) {
        sendResponse({ ok: false, error: "no tab" });
        return;
      }
      const apiKey = await getApiKey();
      if (!apiKey) {
        sendResponse({ ok: false, error: "missing-key" });
        return;
      }
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      const cropB64 = await cropToBase64(dataUrl, msg.rect, msg.dpr || 1);
      const { result, rawText } = await callClaude(apiKey, cropB64);
      const isNull = result.price == null && result.was == null && result.save == null && result.pct == null;
      if (isNull) {
        console.warn("[pce] no price. rect:", msg.rect, "raw:", rawText);
        sendResponse({ ok: true, result, rawText, cropDataUrl: "data:image/png;base64," + cropB64 });
      } else {
        sendResponse({ ok: true, result });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err && err.message || err) });
    }
  })();
  return true;
});

async function getApiKey() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const key = data && data[STORAGE_KEY];
  return (typeof key === "string" && key.trim()) ? key.trim() : null;
}

// ---------- cropping (service-worker side) ----------
//
// Service workers in MV3 expose fetch, OffscreenCanvas, createImageBitmap,
// and btoa, so we can do the entire capture-and-crop pipeline here without
// needing an offscreen document.

// Upscale factor applied to the cropped region before sending to vision.
// Adobe's PDF viewer renders body text at ~10–14 px which, after a 130x130
// crop, leaves Claude with very few pixels per glyph. A 3x upscale gives
// the model enough resolution to read small document text reliably while
// staying well under Claude vision's ~1568 px max-dimension limit.
const UPSCALE = 3;

async function cropToBase64(dataUrl, rect, dpr) {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);

  const sx = Math.max(0, Math.round(rect.x * dpr));
  const sy = Math.max(0, Math.round(rect.y * dpr));
  const maxW = Math.max(1, bitmap.width - sx);
  const maxH = Math.max(1, bitmap.height - sy);
  const sw = Math.max(1, Math.min(Math.round(rect.w * dpr), maxW));
  const sh = Math.max(1, Math.min(Math.round(rect.h * dpr), maxH));

  const dw = sw * UPSCALE;
  const dh = sh * UPSCALE;

  const canvas = new OffscreenCanvas(dw, dh);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, dw, dh);
  bitmap.close && bitmap.close();

  const outBlob = await canvas.convertToBlob({ type: "image/png" });
  return await blobToBase64(outBlob);
}

async function blobToBase64(blob) {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  // btoa requires a binary string. Build it in chunks to avoid blowing the
  // call-stack on large images (a 130x130@2dpr crop is small but be safe).
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// ---------- Anthropic vision call ----------

async function callClaude(apiKey, base64Png) {
  const body = {
    model: MODEL_ID,
    max_tokens: MAX_TOKENS,
    messages: [{
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: base64Png },
        },
        { type: "text", text: PRICE_PROMPT },
      ],
    }],
  };
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      // Required for direct browser-context calls; without it Anthropic
      // refuses to serve requests that originate from a browser to prevent
      // accidental key exposure on a public web page. We're in an extension
      // service worker, not a public page, so this is the intended use.
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error("Anthropic API " + res.status + ": " + errText.slice(0, 200));
  }
  const json = await res.json();
  const block = json && json.content && json.content[0];
  if (!block || block.type !== "text" || !block.text) {
    throw new Error("Anthropic response had no text block");
  }
  const rawText = block.text;
  const result = parsePriceJson(rawText);
  return { result, rawText };
}

function parsePriceJson(text) {
  const trimmed = (text || "").trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  let parsed = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch (_) {
    // Try to extract the first {...} block.
    const m = trimmed.match(/\{[\s\S]*\}/);
    if (m) {
      try { parsed = JSON.parse(m[0]); } catch (_) {}
    }
  }
  if (!parsed || typeof parsed !== "object") {
    return { price: null, was: null, save: null, pct: null };
  }
  return {
    price: numOrNull(parsed.price),
    was: numOrNull(parsed.was),
    save: numOrNull(parsed.save),
    pct: numOrNull(parsed.pct),
  };
}

function numOrNull(v) {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  if (!isFinite(n)) return null;
  if (n < 0 || n > 9999999) return null;
  return n;
}
