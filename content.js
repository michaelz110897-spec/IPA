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
  //
  // Operates over a spatial word graph of the OCR output. Each word is tagged
  // with a semantic role (price-prefix / price-suppress / save-marker / noise /
  // numeric / word) and then scored geometrically. Handles the real retail
  // sticker conventions: big-dollar + superscript-cents split, prefix flags
  // like FROM / NOW, unit suffixes like `ea`, and SAVE bands with filler
  // words (`UP TO`, `OFF`, `YOU`).

  const FULL_PRICE_RE = /^\$?\d{1,3}(?:,\d{3})*\.\d{2}$/;
  const DOLLAR_RE = /^\$?\d{1,4}$/;          // e.g. "$11", "8", "$15"
  const CENTS_RE = /^\d{2}$/;                // e.g. "99", "49"
  const ANY_NUM_RE =
    /^\$?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?$|^\$?\d+\.\d{1,2}$|^\$?\d+$/;
  const NUM_EXTRACT_RE =
    /\$?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+\.\d{1,2}|\d+)/;

  const PRICE_PREFIX_WORDS = new Set([
    "from", "now", "only", "just", "starting",
  ]);
  const PRICE_SUPPRESS_WORDS = new Set([
    "was", "reg", "regular", "orig", "original", "retail",
    "msrp", "list", "compare", "value",
  ]);
  const NOISE_WORDS = new Set([
    "ea", "ea.", "each", "lb", "lb.", "kg", "pk", "ct", "oz",
    "*", "†", "/", "up", "to", "off", "you", "-", "—",
  ]);

  function bboxH(b) { return b.y1 - b.y0; }
  function bboxW(b) { return b.x1 - b.x0; }
  function bboxCenterX(b) { return (b.x0 + b.x1) / 2; }
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

  function cleanText(t) {
    return t.replace(/[:;,.\u00a0]+$/g, "").trim();
  }
  function normLower(t) {
    return cleanText(t).toLowerCase();
  }

  function classify(text) {
    const raw = cleanText(text);
    const low = raw.toLowerCase();
    if (ANY_NUM_RE.test(raw)) return "numeric";
    if (/^save$/i.test(low) || /save/i.test(low) && /\d/.test(raw)) return "save-marker";
    if (PRICE_PREFIX_WORDS.has(low)) return "price-prefix";
    if (PRICE_SUPPRESS_WORDS.has(low)) return "price-suppress";
    if (NOISE_WORDS.has(low)) return "noise";
    if (/[A-Za-z]/.test(raw)) return "word";
    return "noise";
  }

  function parseAmount(text) {
    const m = text.match(NUM_EXTRACT_RE);
    if (!m) return null;
    const v = parseFloat(m[1].replace(/,/g, ""));
    if (!isFinite(v) || v < 0.01 || v > 99999) return null;
    return v;
  }

  // Fuse big-dollar + small-cents splits, e.g. ("$11" big) + ("99" small) ->
  // synthetic word "$11.99" with the dollar's bbox unioned with the cents box.
  // Geometric rule, not textual: cents must be adjacent right, smaller,
  // and in superscript position relative to the dollar word.
  function fuseDollarCents(words) {
    const consumed = new Set();
    const extras = [];

    // Skip fusion for words that already look like a complete price ($X.YY):
    // those are their own fused token.
    const dollarCandidates = words.filter((w) => {
      const t = cleanText(w.text);
      return DOLLAR_RE.test(t) && !FULL_PRICE_RE.test(t);
    });
    const centsCandidates = words.filter((w) => CENTS_RE.test(cleanText(w.text)));

    for (const d of dollarCandidates) {
      if (consumed.has(d)) continue;
      const dh = bboxH(d.bbox);
      const dw = bboxW(d.bbox);
      if (dh <= 0 || dw <= 0) continue;
      let best = null;
      let bestScore = Infinity;
      for (const c of centsCandidates) {
        if (consumed.has(c) || c === d) continue;
        const ch = bboxH(c.bbox);
        if (ch <= 0 || ch > dh * 0.85) continue; // cents noticeably smaller
        const gap = c.bbox.x0 - d.bbox.x1;
        if (gap < -dw * 0.2 || gap > dw * 1.5) continue; // adjacent-right
        // cents top must sit near or above dollar top (superscript)
        if (c.bbox.y0 > d.bbox.y0 + dh * 0.35) continue;
        // and must overlap the dollar's vertical band at all
        if (c.bbox.y1 < d.bbox.y0 + dh * 0.05) continue;
        const score = Math.abs(gap) + Math.abs(c.bbox.y0 - d.bbox.y0);
        if (score < bestScore) {
          bestScore = score;
          best = c;
        }
      }
      if (!best) continue;
      const dollarsStr = cleanText(d.text).replace(/^\$/, "");
      const centsStr = cleanText(best.text);
      const fusedText = "$" + dollarsStr + "." + centsStr;
      extras.push({
        text: fusedText,
        bbox: {
          x0: d.bbox.x0,
          y0: Math.min(d.bbox.y0, best.bbox.y0),
          x1: best.bbox.x1,
          y1: d.bbox.y1,
        },
        lineId: d.lineId,
        merged: true,
      });
      consumed.add(d);
      consumed.add(best);
    }

    const out = [];
    for (const w of words) if (!consumed.has(w)) out.push(w);
    for (const e of extras) out.push(e);
    return out;
  }

  function tagWords(words) {
    return words.map((w) => ({ ...w, role: classify(w.text) }));
  }

  // Non-noise words on the same visual line, sorted left-to-right.
  function lineNeighborsLeftOf(target, words) {
    const out = [];
    for (const w of words) {
      if (w === target) continue;
      if (w.role === "noise") continue;
      if (!sameLine(w.bbox, target.bbox)) continue;
      if (w.bbox.x1 > target.bbox.x0) continue;
      out.push(w);
    }
    out.sort((a, b) => b.bbox.x1 - a.bbox.x1); // closest first
    return out;
  }

  function findSaveAmount(words) {
    const numerics = words.filter((w) => w.role === "numeric");
    const markers = words.filter((w) => w.role === "save-marker");
    for (const sw of markers) {
      const rawNoDollar = cleanText(sw.text).replace(/^\$/, "");
      // SAVE token glued to digits (e.g. "SAVE$3.96").
      if (/\d/.test(rawNoDollar)) {
        const v = parseAmount(sw.text);
        if (v != null) return { value: v, source: sw, inline: true };
      }
      const slop = bboxH(sw.bbox) * 0.25;
      const saveLeft = sw.bbox.x0 - slop;

      // Candidate numerics: within 2 lines of SAVE, at or right of SAVE's
      // left edge, and at most 4 non-noise words away when walking in reading
      // order.
      const candidates = [];
      for (const cand of numerics) {
        if (Math.abs(cand.lineId - sw.lineId) > 2) continue;
        if (cand.bbox.x0 < saveLeft) continue;
        // word-index walk: count non-noise words strictly between sw and cand
        // on the same line(s). Use spatial cursor: any non-noise word whose
        // center is between sw and cand (in reading order) counts.
        let between = 0;
        for (const w of words) {
          if (w === sw || w === cand) continue;
          if (w.role === "noise") continue;
          if (Math.abs(w.lineId - sw.lineId) > 2) continue;
          const cxW = bboxCenterX(w.bbox);
          const cyW = bboxCenterY(w.bbox);
          const afterSave =
            w.lineId > sw.lineId ||
            (w.lineId === sw.lineId && cxW > bboxCenterX(sw.bbox));
          const beforeCand =
            w.lineId < cand.lineId ||
            (w.lineId === cand.lineId && cxW < bboxCenterX(cand.bbox));
          if (afterSave && beforeCand) between++;
        }
        if (between > 4) continue;
        const dx = bboxCenterX(cand.bbox) - bboxCenterX(sw.bbox);
        const dy = bboxCenterY(cand.bbox) - bboxCenterY(sw.bbox);
        const dist = Math.sqrt(dx * dx + dy * dy);
        candidates.push({ cand, dist });
      }
      candidates.sort((a, b) => a.dist - b.dist);
      for (const { cand } of candidates) {
        const v = parseAmount(cand.text);
        if (v != null) return { value: v, source: sw, numeric: cand };
      }
    }
    return null;
  }

  function findPrice(words, saveInfo) {
    const skip = saveInfo && saveInfo.numeric;
    const candidates = [];
    for (const w of words) {
      if (w === skip) continue;
      if (w.role !== "numeric") continue;
      const v = parseAmount(w.text);
      if (v == null) continue;

      // Suppress if a price-suppress word is immediately to the left on the
      // same line (skipping noise words).
      const leftNeighbors = lineNeighborsLeftOf(w, words);
      let suppressed = false;
      let prefixed = false;
      if (leftNeighbors.length) {
        const nearest = leftNeighbors[0];
        const gap = w.bbox.x0 - nearest.bbox.x1;
        if (gap >= -bboxH(w.bbox) * 0.1 && gap < bboxH(w.bbox) * 1.5) {
          if (nearest.role === "price-suppress") suppressed = true;
          if (nearest.role === "price-prefix") prefixed = true;
        }
      }
      if (suppressed) continue;

      const hasDollar = cleanText(w.text).startsWith("$");
      let score = 0;
      if (prefixed) score += 3;
      if (hasDollar) score += 2;
      score += bboxH(w.bbox) / 10;
      if (w.merged) score += 1;
      candidates.push({ value: v, score, height: bboxH(w.bbox), x0: w.bbox.x0 });
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.height !== a.height) return b.height - a.height;
      return a.x0 - b.x0;
    });
    return candidates[0].value;
  }

  function formatMoney(n) { return "$" + n.toFixed(2); }

  function handleWords(rawWords) {
    if (!labelEl) return;
    const fused = fuseDollarCents(rawWords);
    const words = tagWords(fused);
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
