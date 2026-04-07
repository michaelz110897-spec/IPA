(() => {
  if (window.__pceInjected) return;
  window.__pceInjected = true;

  const RECT_W = 150;
  const RECT_H = 160;
  const SETTLE_MS = 250;

  let active = false;
  let rectEl = null;
  let labelEl = null;
  let mouseX = 0;
  let mouseY = 0;
  let rafPending = false;
  let settleTimer = null;
  let scanInFlight = false;
  let lastScannedAt = 0;
  let lastResultText = "";

  function createOverlay() {
    rectEl = document.createElement("div");
    rectEl.className = "pce-rect";
    labelEl = document.createElement("div");
    labelEl.className = "pce-label";
    labelEl.style.display = "none";
    rectEl.appendChild(labelEl);
    document.documentElement.appendChild(rectEl);
  }

  function destroyOverlay() {
    if (rectEl && rectEl.parentNode) rectEl.parentNode.removeChild(rectEl);
    rectEl = null;
    labelEl = null;
  }

  function onMouseMove(e) {
    mouseX = e.clientX;
    mouseY = e.clientY;
    if (!rafPending) {
      rafPending = true;
      requestAnimationFrame(positionRect);
    }
    scheduleScan();
  }

  function positionRect() {
    rafPending = false;
    if (!active || !rectEl) return;
    rectEl.style.left = (mouseX - RECT_W / 2) + "px";
    rectEl.style.top = (mouseY - RECT_H / 2) + "px";
  }

  function scheduleScan() {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(triggerScan, SETTLE_MS);
  }

  function currentRect() {
    const left = Math.max(0, mouseX - RECT_W / 2);
    const top = Math.max(0, mouseY - RECT_H / 2);
    return { x: left, y: top, w: RECT_W, h: RECT_H };
  }

  async function triggerScan() {
    if (!active || scanInFlight) return;
    scanInFlight = true;
    const rect = currentRect();
    const dpr = window.devicePixelRatio || 1;
    try {
      const reply = await chrome.runtime.sendMessage({ type: "pce-scan", rect, dpr });
      if (!reply || !reply.ok) return;
      handleWords(reply.words || []);
    } catch (e) {
      // Background unreachable; ignore.
    } finally {
      scanInFlight = false;
      lastScannedAt = Date.now();
    }
  }

  // ---------- spatial parser ----------

  const NUM_RE = /^\$?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?$|^\$?\d+\.\d{1,2}$|^\$?\d+$/;
  const NUM_EXTRACT_RE = /\$?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+\.\d{1,2}|\d+)/;

  function bboxH(b) { return b.y1 - b.y0; }
  function bboxW(b) { return b.x1 - b.x0; }
  function bboxCenterY(b) { return (b.y0 + b.y1) / 2; }

  function vOverlap(a, b) {
    const top = Math.max(a.y0, b.y0);
    const bot = Math.min(a.y1, b.y1);
    return Math.max(0, bot - top);
  }

  function sameLine(a, b) {
    const overlap = vOverlap(a, b);
    const minH = Math.min(bboxH(a), bboxH(b));
    return minH > 0 && overlap >= 0.5 * minH;
  }

  function isWordy(text) { return /[A-Za-z]/.test(text); }
  function isNumeric(text) { return NUM_RE.test(text); }

  function parseAmount(text) {
    const m = text.match(NUM_EXTRACT_RE);
    if (!m) return null;
    const v = parseFloat(m[1].replace(/,/g, ""));
    if (!isFinite(v) || v < 0.01 || v > 99999) return null;
    return v;
  }

  function findSaveAmount(words) {
    for (const sw of words) {
      const txt = sw.text;
      if (!/save/i.test(txt)) continue;
      const isExactSave = /^save[:.,]?$/i.test(txt);
      // If the SAVE token already includes digits, parse them out directly.
      if (!isExactSave && /\d/.test(txt)) {
        const v = parseAmount(txt);
        if (v != null) return { value: v, source: sw, inline: true };
      }
      if (!isExactSave) continue;
      // Find nearest numeric word to the right on the same line.
      let best = null;
      let bestDist = Infinity;
      const slop = bboxH(sw.bbox) * 0.25;
      const maxDist = bboxW(sw.bbox) * 3 + bboxH(sw.bbox) * 4;
      for (const cand of words) {
        if (cand === sw) continue;
        if (!isNumeric(cand.text)) continue;
        if (!sameLine(sw.bbox, cand.bbox)) continue;
        if (cand.bbox.x0 < sw.bbox.x1 - slop) continue;
        const dist = cand.bbox.x0 - sw.bbox.x1;
        if (dist < bestDist && dist <= maxDist) {
          bestDist = dist;
          best = cand;
        }
      }
      if (best) {
        const v = parseAmount(best.text);
        if (v != null) return { value: v, source: sw, numeric: best };
      }
    }
    return null;
  }

  function findPrice(words, saveInfo) {
    const skip = saveInfo && saveInfo.numeric;
    const candidates = [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (w === skip) continue;
      if (!isNumeric(w.text)) continue;
      // Reject if a letter-only word is immediately to its left on the same line.
      let blocked = false;
      for (const other of words) {
        if (other === w) continue;
        if (!isWordy(other.text) || /\d/.test(other.text)) continue;
        if (!sameLine(w.bbox, other.bbox)) continue;
        if (other.bbox.x1 > w.bbox.x0) continue;
        const gap = w.bbox.x0 - other.bbox.x1;
        if (gap >= 0 && gap < bboxH(w.bbox) * 1.2) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      const v = parseAmount(w.text);
      if (v == null) continue;
      const hasDollar = w.text.startsWith("$");
      candidates.push({ value: v, height: bboxH(w.bbox), hasDollar });
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => {
      if (a.hasDollar !== b.hasDollar) return a.hasDollar ? -1 : 1;
      return b.height - a.height;
    });
    return candidates[0].value;
  }

  function formatMoney(n) { return "$" + n.toFixed(2); }

  function handleWords(words) {
    if (!labelEl) return;
    const saveInfo = findSaveAmount(words);
    const save = saveInfo ? saveInfo.value : null;
    const price = findPrice(words, saveInfo);

    let text = "";
    if (price != null && save != null && price + save > 0) {
      const pct = (save / (price + save)) * 100;
      text =
        "Price: " + formatMoney(price) +
        "  |  Save: " + formatMoney(save) +
        "  |  " + pct.toFixed(2) + "% off";
    } else if (price != null) {
      text = "Price: " + formatMoney(price);
    }

    if (text) {
      labelEl.textContent = text;
      labelEl.style.display = "";
      lastResultText = text;
    } else {
      labelEl.style.display = "none";
      lastResultText = "";
    }
  }

  function activate() {
    if (active) return;
    active = true;
    createOverlay();
    window.addEventListener("mousemove", onMouseMove, true);
  }

  function deactivate() {
    if (!active) return;
    active = false;
    window.removeEventListener("mousemove", onMouseMove, true);
    if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
    destroyOverlay();
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "pce-toggle") return;
    if (msg.active) activate();
    else deactivate();
  });
})();
