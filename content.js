(() => {
  if (window.__pceInjected) return;
  window.__pceInjected = true;

  // State machine: idle -> scanning -> showing -> idle.
  let state = "idle";
  let layerEl = null;
  let toastEl = null;
  // Bumped on every teardown so in-flight scans can detect they've been
  // cancelled by a second icon click before their OCR reply arrives.
  let scanGen = 0;

  // ---------- message entry point ----------

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "pce-toggle") return;
    if (msg.active) {
      if (state === "idle") runViewportScan();
      // If a scan is already in flight or highlights are showing, the user
      // expects a second click to clear; background toggles `active` on every
      // click so a "false" will follow for teardown.
    } else {
      scanGen++;
      clearHighlights();
      clearToast();
      state = "idle";
    }
  });

  // ---------- top-level scan flow ----------

  async function runViewportScan() {
    state = "scanning";
    const myGen = ++scanGen;
    clearHighlights();
    showToast("Scanning page\u2026", "info");

    const rect = {
      x: 0,
      y: 0,
      w: Math.max(1, window.innerWidth),
      h: Math.max(1, window.innerHeight),
    };
    const dpr = window.devicePixelRatio || 1;
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;

    let reply;
    try {
      reply = await chrome.runtime.sendMessage({
        type: "pce-scan",
        rect,
        dpr,
        fullViewport: true,
      });
    } catch (e) {
      if (myGen !== scanGen) return;
      clearToast();
      showToast("Scan failed", "error");
      setTimeout(() => { if (myGen === scanGen) clearToast(); }, 2000);
      state = "idle";
      return;
    }

    if (myGen !== scanGen) return; // cancelled by a second click
    if (!reply || !reply.ok) {
      clearToast();
      showToast("Scan failed", "error");
      setTimeout(() => { if (myGen === scanGen) clearToast(); }, 2000);
      state = "idle";
      return;
    }

    const rawWords = reply.words || [];
    if (rawWords.length === 0) {
      clearToast();
      showToast("No text found", "info");
      setTimeout(() => { if (myGen === scanGen) clearToast(); }, 2000);
      state = "idle";
      return;
    }

    const fused = fuseDollarCents(rawWords);
    const words = tagWords(fused);
    const clusters = clusterWords(words);

    if (myGen !== scanGen) return;
    clearToast();
    if (!clusters.length) {
      showToast("No prices found", "info");
      setTimeout(() => { if (myGen === scanGen) clearToast(); }, 2000);
      state = "idle";
      return;
    }

    renderHighlights(clusters, dpr, scrollX, scrollY);
    state = "showing";
  }

  // ---------- spatial parser (unchanged from Rev 5) ----------
  //
  // Operates over a spatial word graph of the OCR output. Each word is tagged
  // with a semantic role (price-prefix / price-suppress / save-marker / noise /
  // numeric / word) and then scored geometrically.

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
    "*", "\u2020", "/", "up", "to", "off", "you", "-", "\u2014",
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

  function classify(text) {
    const raw = cleanText(text);
    const low = raw.toLowerCase();
    if (ANY_NUM_RE.test(raw)) return "numeric";
    if (/^save$/i.test(low) || (/save/i.test(low) && /\d/.test(raw))) return "save-marker";
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
  function fuseDollarCents(words) {
    const consumed = new Set();
    const extras = [];

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
        if (ch <= 0 || ch > dh * 0.85) continue;
        const gap = c.bbox.x0 - d.bbox.x1;
        if (gap < -dw * 0.2 || gap > dw * 1.5) continue;
        if (c.bbox.y0 > d.bbox.y0 + dh * 0.35) continue;
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

  function lineNeighborsLeftOf(target, words) {
    const out = [];
    for (const w of words) {
      if (w === target) continue;
      if (w.role === "noise") continue;
      if (!sameLine(w.bbox, target.bbox)) continue;
      if (w.bbox.x1 > target.bbox.x0) continue;
      out.push(w);
    }
    out.sort((a, b) => b.bbox.x1 - a.bbox.x1);
    return out;
  }

  // Rev-5 findPrice, refactored to accept an optional filter so clustering
  // can restrict candidates to a spatial neighborhood.
  function findPriceCandidates(words, filter) {
    const candidates = [];
    for (const w of words) {
      if (w.role !== "numeric") continue;
      if (filter && !filter(w)) continue;
      const v = parseAmount(w.text);
      if (v == null) continue;

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
      candidates.push({ word: w, value: v, score });
    }
    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const dh = bboxH(b.word.bbox) - bboxH(a.word.bbox);
      if (dh !== 0) return dh;
      return a.word.bbox.x0 - b.word.bbox.x0;
    });
    return candidates;
  }

  // ---------- per-sticker clustering ----------
  //
  // Seeds a cluster from each SAVE marker, finds the best nearby price, then
  // sweeps orphan prices into price-only clusters.

  function clusterWords(words) {
    const clusters = [];
    const claimedPrices = new Set();
    const claimedSaveNumerics = new Set();

    const markers = words.filter((w) => w.role === "save-marker");

    for (const sw of markers) {
      // SAVE amount: either glued to the marker ("SAVE$3.96"), or the nearest
      // numeric in a local neighborhood.
      let saveValue = null;
      let saveBox = sw.bbox;
      let saveNumeric = null;

      const rawNoDollar = cleanText(sw.text).replace(/^\$/, "");
      if (/\d/.test(rawNoDollar)) {
        const v = parseAmount(sw.text);
        if (v != null) {
          saveValue = v;
          saveBox = sw.bbox;
        }
      }

      if (saveValue == null) {
        const sh = bboxH(sw.bbox);
        const scx = bboxCenterX(sw.bbox);
        const best = findNearestNumeric(words, sw, {
          yMin: sw.bbox.y0 - sh * 1.5,
          yMax: sw.bbox.y1 + sh * 2.5,
          xCenter: scx,
          xHalfWidth: Math.max(bboxW(sw.bbox) * 2, sh * 6),
          excludeRoles: new Set(["save-marker"]),
          excludeSet: claimedSaveNumerics,
        });
        if (best) {
          const v = parseAmount(best.text);
          if (v != null) {
            saveValue = v;
            saveBox = best.bbox;
            saveNumeric = best;
          }
        }
      }

      // Local price neighborhood: vertically above (mostly) and horizontally
      // near the SAVE marker's column.
      const sh = bboxH(sw.bbox);
      const scx = bboxCenterX(sw.bbox);
      const xHalf = Math.max(bboxW(sw.bbox), sh * 4);
      const yMin = sw.bbox.y0 - sh * 5;
      const yMax = sw.bbox.y1 + sh * 2;

      const neighborhoodFilter = (w) => {
        if (claimedPrices.has(w)) return false;
        if (claimedSaveNumerics.has(w)) return false;
        if (saveNumeric && w === saveNumeric) return false;
        const cy = bboxCenterY(w.bbox);
        if (cy < yMin || cy > yMax) return false;
        const cx = bboxCenterX(w.bbox);
        if (Math.abs(cx - scx) > xHalf) return false;
        return true;
      };

      const priceCands = findPriceCandidates(words, neighborhoodFilter);
      let priceWord = null;
      let priceValue = null;
      if (priceCands.length) {
        priceWord = priceCands[0].word;
        priceValue = priceCands[0].value;
        claimedPrices.add(priceWord);
      }

      if (saveNumeric) claimedSaveNumerics.add(saveNumeric);

      // A cluster needs at least a SAVE value or a price to be worth drawing.
      if (saveValue == null && priceValue == null) continue;

      const pct =
        priceValue != null && saveValue != null && priceValue + saveValue > 0
          ? (saveValue / (priceValue + saveValue)) * 100
          : null;

      clusters.push({
        price: priceValue,
        save: saveValue,
        pct,
        priceBox: priceWord ? priceWord.bbox : null,
        saveBox,
        saveMarker: sw,
      });
    }

    // Orphan prices: any price candidate not already claimed by a SAVE cluster.
    const orphanCands = findPriceCandidates(words, (w) => !claimedPrices.has(w));
    for (const c of orphanCands) {
      // Dedupe: skip if we already emitted this exact word.
      if (claimedPrices.has(c.word)) continue;
      claimedPrices.add(c.word);
      clusters.push({
        price: c.value,
        save: null,
        pct: null,
        priceBox: c.word.bbox,
        saveBox: null,
        saveMarker: null,
      });
    }

    // Dedupe SAVE clusters that ended up pointing at the same price: keep the
    // one whose save marker is geometrically closest to the price.
    const byPriceKey = new Map();
    for (const cl of clusters) {
      if (!cl.priceBox || !cl.saveMarker) continue;
      const key = cl.priceBox.x0 + "|" + cl.priceBox.y0 + "|" + cl.priceBox.x1 + "|" + cl.priceBox.y1;
      const prev = byPriceKey.get(key);
      if (!prev) { byPriceKey.set(key, cl); continue; }
      const distPrev = bboxDist(prev.saveMarker.bbox, prev.priceBox);
      const distCurr = bboxDist(cl.saveMarker.bbox, cl.priceBox);
      if (distCurr < distPrev) byPriceKey.set(key, cl);
    }
    const deduped = [];
    const seenSaveClusters = new Set();
    for (const cl of clusters) {
      if (cl.priceBox && cl.saveMarker) {
        const key = cl.priceBox.x0 + "|" + cl.priceBox.y0 + "|" + cl.priceBox.x1 + "|" + cl.priceBox.y1;
        const winner = byPriceKey.get(key);
        if (winner !== cl) continue;
        if (seenSaveClusters.has(key)) continue;
        seenSaveClusters.add(key);
      }
      deduped.push(cl);
    }
    return deduped;
  }

  function bboxDist(a, b) {
    const dx = bboxCenterX(a) - bboxCenterX(b);
    const dy = bboxCenterY(a) - bboxCenterY(b);
    return Math.sqrt(dx * dx + dy * dy);
  }

  function findNearestNumeric(words, anchor, opts) {
    let best = null;
    let bestDist = Infinity;
    const acx = bboxCenterX(anchor.bbox);
    const acy = bboxCenterY(anchor.bbox);
    for (const w of words) {
      if (w === anchor) continue;
      if (w.role !== "numeric") continue;
      if (opts.excludeRoles && opts.excludeRoles.has(w.role)) continue;
      if (opts.excludeSet && opts.excludeSet.has(w)) continue;
      const cy = bboxCenterY(w.bbox);
      if (cy < opts.yMin || cy > opts.yMax) continue;
      const cx = bboxCenterX(w.bbox);
      if (Math.abs(cx - opts.xCenter) > opts.xHalfWidth) continue;
      const dx = cx - acx;
      const dy = cy - acy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < bestDist) {
        bestDist = d;
        best = w;
      }
    }
    return best;
  }

  // ---------- overlay rendering ----------

  function formatMoney(n) { return "$" + n.toFixed(2); }

  function renderHighlights(clusters, dpr, scrollX, scrollY) {
    clearHighlights();
    layerEl = document.createElement("div");
    layerEl.className = "pce-layer";
    document.body.appendChild(layerEl);

    for (const cl of clusters) {
      if (cl.priceBox) {
        const el = document.createElement("div");
        el.className = "pce-hl pce-hl-price";
        setBoxStyle(el, cl.priceBox, dpr, scrollX, scrollY);
        layerEl.appendChild(el);
      }
      if (cl.saveBox && cl.save != null) {
        const el = document.createElement("div");
        el.className = "pce-hl pce-hl-save";
        setBoxStyle(el, cl.saveBox, dpr, scrollX, scrollY);
        layerEl.appendChild(el);
      }

      // Label anchored above the price (or above the save box if no price).
      const anchorBox = cl.priceBox || cl.saveBox;
      if (!anchorBox) continue;
      const label = document.createElement("div");
      label.className = "pce-hl-label";
      let text;
      if (cl.price != null && cl.save != null && cl.pct != null) {
        text = formatMoney(cl.price) + " \u00b7 save " + formatMoney(cl.save) + " \u00b7 " + cl.pct.toFixed(2) + "% off";
      } else if (cl.price != null) {
        text = formatMoney(cl.price);
      } else {
        text = "save " + formatMoney(cl.save);
      }
      label.textContent = text;
      const cssX = bboxCenterX(anchorBox) / dpr + scrollX;
      const cssY = anchorBox.y0 / dpr + scrollY;
      label.style.left = cssX + "px";
      label.style.top = (cssY - 4) + "px";
      layerEl.appendChild(label);
    }
  }

  function setBoxStyle(el, bbox, dpr, scrollX, scrollY) {
    const cssX = bbox.x0 / dpr + scrollX;
    const cssY = bbox.y0 / dpr + scrollY;
    const cssW = (bbox.x1 - bbox.x0) / dpr;
    const cssH = (bbox.y1 - bbox.y0) / dpr;
    el.style.left = cssX + "px";
    el.style.top = cssY + "px";
    el.style.width = cssW + "px";
    el.style.height = cssH + "px";
  }

  function clearHighlights() {
    if (layerEl && layerEl.parentNode) layerEl.parentNode.removeChild(layerEl);
    layerEl = null;
  }

  function showToast(text, kind) {
    clearToast();
    toastEl = document.createElement("div");
    toastEl.className = "pce-toast pce-toast-" + (kind || "info");
    toastEl.textContent = text;
    document.body.appendChild(toastEl);
  }

  function clearToast() {
    if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
    toastEl = null;
  }
})();
