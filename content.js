// Price Comparison Scanner — cursor-box edition (Claude vision).
//
// User flow:
//   1. Click toolbar icon to enable. A 130x130 viewfinder follows the cursor.
//   2. Move the cursor over a price. After ~500 ms of stillness the extension
//      captures the box region as a PNG and asks Claude vision (Sonnet) to
//      extract the price, save amount, and percent off.
//   3. Result is rendered in a small glass HUD next to the cursor.
//   4. Click toolbar icon again to disable.
//
// The Anthropic API key is set on the extension's options page. Without a
// key the HUD shows "API key required" and links the user to settings.

(() => {
  if (window.__pceInjected) return;
  window.__pceInjected = true;

  // ---------- frame role ----------
  //
  // The extension runs inside every frame (manifest all_frames=true) so it
  // can detect mousemove on cross-origin iframes such as Adobe Acrobat's PDF
  // viewer. Only the TOP frame draws the cursor box and runs scans; non-top
  // frames forward their own mousemove events to their parent AND relay
  // forwarded messages from their own child iframes (translating each step
  // by the child iframe's bounding rect). This recursion lets coordinates
  // climb arbitrarily deep iframe trees — Adobe's viewer is at least
  // top → viewer iframe → PDF iframe, and the original single-level bridge
  // never reached the top frame.

  const isTopFrame = (window === window.top);

  if (!isTopFrame) {
    document.addEventListener("mousemove", (ev) => {
      try {
        window.parent.postMessage({
          __pce: true,
          type: "subframe-mousemove",
          cx: ev.clientX,
          cy: ev.clientY,
          fw: window.innerWidth,
          fh: window.innerHeight,
        }, "*");
      } catch (_) { /* nothing useful to do */ }
    }, true);

    // Relay forwarded messages from our own child iframes one level up,
    // translating the coordinate by the child iframe's position within
    // this frame's viewport. The top frame's listener does the final
    // translation into top-frame viewport coordinates.
    window.addEventListener("message", (ev) => {
      const data = ev.data;
      if (!data || !data.__pce || data.type !== "subframe-mousemove") return;
      if (ev.source === window || ev.source === window.parent) return;
      const iframes = document.querySelectorAll("iframe, frame");
      let childEl = null;
      for (const f of iframes) {
        try { if (f.contentWindow === ev.source) { childEl = f; break; } }
        catch (_) { /* cross-origin contentWindow access throws */ }
      }
      if (!childEl) return;
      const r = childEl.getBoundingClientRect();
      const sx = data.fw > 0 ? r.width / data.fw : 1;
      const sy = data.fh > 0 ? r.height / data.fh : 1;
      try {
        window.parent.postMessage({
          __pce: true,
          type: "subframe-mousemove",
          cx: r.left + (data.cx || 0) * sx,
          cy: r.top + (data.cy || 0) * sy,
          fw: window.innerWidth,
          fh: window.innerHeight,
        }, "*");
      } catch (_) { /* nothing useful to do */ }
    }, true);

    return;
  }

  // ---------- state (top frame only) ----------

  let enabled = false;
  let cursorBox = null;
  let labelEl = null;
  let lastMouseX = -9999;
  let lastMouseY = -9999;
  let lastScanX = -99999;
  let lastScanY = -99999;
  let scheduleTimer = null;
  let scanGen = 0;            // bumps on disable / new scan to cancel stale work
  const DEBOUNCE_MS = 500;
  const MOVE_THRESHOLD_PX = 50;
  const CACHE_TTL_MS = 5000;
  const BOX_SIZE = 130;
  const HALF = BOX_SIZE / 2;

  const resultCache = new Map();

  // ---------- toggle wiring ----------

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "pce-toggle") return;
    if (msg.active) enable();
    else disable();
  });

  function enable() {
    if (enabled) return;
    enabled = true;
    createCursorBox();
    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize, true);
    window.addEventListener("message", onSubframeMessage, true);
  }

  function disable() {
    enabled = false;
    scanGen++;
    if (scheduleTimer) { clearTimeout(scheduleTimer); scheduleTimer = null; }
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("scroll", onScrollOrResize, true);
    window.removeEventListener("resize", onScrollOrResize, true);
    window.removeEventListener("message", onSubframeMessage, true);
    removeCursorBox();
    removeLabel();
    resultCache.clear();
    lastScanX = -99999;
    lastScanY = -99999;
  }

  function onSubframeMessage(ev) {
    if (!enabled) return;
    const data = ev.data;
    if (!data || !data.__pce || data.type !== "subframe-mousemove") return;
    const iframes = document.querySelectorAll("iframe, frame");
    let iframeEl = null;
    for (const f of iframes) {
      try { if (f.contentWindow === ev.source) { iframeEl = f; break; } }
      catch (_) { /* cross-origin contentWindow access throws */ }
    }
    if (!iframeEl) return;
    const r = iframeEl.getBoundingClientRect();
    const sx = data.fw > 0 ? r.width / data.fw : 1;
    const sy = data.fh > 0 ? r.height / data.fh : 1;
    const x = r.left + (data.cx || 0) * sx;
    const y = r.top + (data.cy || 0) * sy;
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return;
    lastMouseX = x;
    lastMouseY = y;
    moveCursorBox(x, y);
    moveLabel(x, y);
    scheduleScan();
  }

  // ---------- cursor box overlay ----------

  function createCursorBox() {
    if (cursorBox) return;
    cursorBox = document.createElement("div");
    cursorBox.className = "pce-cursor-box";
    const cornerKeys = ["tl", "tr", "bl", "br"];
    for (const k of cornerKeys) {
      const c = document.createElement("div");
      c.className = "pce-corner pce-corner-" + k;
      cursorBox.appendChild(c);
    }
    const dot = document.createElement("div");
    dot.className = "pce-center-dot";
    cursorBox.appendChild(dot);
    document.documentElement.appendChild(cursorBox);
  }

  function setScanningState(active) {
    if (!cursorBox) return;
    cursorBox.classList.toggle("pce-scanning", !!active);
  }

  function removeCursorBox() {
    if (cursorBox && cursorBox.parentNode) cursorBox.parentNode.removeChild(cursorBox);
    cursorBox = null;
  }

  function moveCursorBox(x, y) {
    if (!cursorBox) return;
    cursorBox.style.left = (x - HALF) + "px";
    cursorBox.style.top = (y - HALF) + "px";
  }

  function moveLabel(x, y) {
    if (!labelEl) return;
    const margin = 6;
    let lx = x + HALF + margin;
    let ly = y + HALF + margin;
    const maxX = window.innerWidth - 240;
    const maxY = window.innerHeight - 32;
    if (lx > maxX) lx = Math.max(4, x - HALF - margin - 240);
    if (ly > maxY) ly = Math.max(4, y - HALF - margin - 32);
    labelEl.style.left = lx + "px";
    labelEl.style.top = ly + "px";
  }

  // ---------- mouse handling ----------

  function onMouseMove(ev) {
    if (!enabled) return;
    lastMouseX = ev.clientX;
    lastMouseY = ev.clientY;
    moveCursorBox(lastMouseX, lastMouseY);
    moveLabel(lastMouseX, lastMouseY);
    scheduleScan();
  }

  function onScrollOrResize() {
    resultCache.clear();
    if (enabled) scheduleScan();
  }

  function scheduleScan() {
    if (scheduleTimer) clearTimeout(scheduleTimer);
    const dx = lastMouseX - lastScanX;
    const dy = lastMouseY - lastScanY;
    if (Math.sqrt(dx * dx + dy * dy) < MOVE_THRESHOLD_PX) {
      const cached = lookupCache(lastScanX, lastScanY);
      if (cached) renderLabel(cached);
    }
    scheduleTimer = setTimeout(runScan, DEBOUNCE_MS);
  }

  function lookupCache(x, y) {
    const key = cacheKey(x, y);
    const hit = resultCache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.ts > CACHE_TTL_MS) { resultCache.delete(key); return null; }
    return hit.result;
  }

  function cacheKey(x, y) {
    return Math.round(x / 25) + "," + Math.round(y / 25);
  }

  // ---------- main scan pipeline ----------

  async function runScan() {
    if (!enabled) return;
    const myGen = ++scanGen;
    const cx = lastMouseX;
    const cy = lastMouseY;
    const rect = { x: cx - HALF, y: cy - HALF, w: BOX_SIZE, h: BOX_SIZE };
    setScanningState(true);

    // Hide the overlay so it doesn't appear in the captured screenshot.
    // Double-rAF ensures the browser paints one clean frame before capture.
    if (cursorBox) cursorBox.style.visibility = "hidden";
    if (labelEl) labelEl.style.visibility = "hidden";
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    let reply;
    try {
      reply = await chrome.runtime.sendMessage({
        type: "pce-scan-claude",
        rect,
        dpr: window.devicePixelRatio || 1,
      });
    } catch (err) {
      if (cursorBox) cursorBox.style.visibility = "";
      if (labelEl) labelEl.style.visibility = "";
      if (myGen !== scanGen) return;
      setScanningState(false);
      renderError("Scan failed: " + (err && err.message || err));
      return;
    }
    if (cursorBox) cursorBox.style.visibility = "";
    if (labelEl) labelEl.style.visibility = "";

    if (myGen !== scanGen) return;

    if (!reply || !reply.ok) {
      setScanningState(false);
      const errCode = reply && reply.error;
      if (errCode === "missing-key") {
        renderError("API key required — open extension options");
      } else {
        renderError(errCode ? String(errCode).slice(0, 120) : "Scan failed");
      }
      return;
    }

    const result = reply.result || null;

    const isNull = !result || (result.price == null && result.was == null && result.save == null && result.pct == null);
    if (isNull) {
      console.warn("[pce] no price detected. raw:", reply.rawText, "crop:", reply.cropDataUrl);
      // Show Claude's raw response in the HUD for debugging.
      setScanningState(false);
      if (reply.rawText) {
        renderError("Claude: " + reply.rawText.slice(0, 100));
      } else {
        renderError("No price detected");
      }
      return;
    }

    lastScanX = cx;
    lastScanY = cy;
    resultCache.set(cacheKey(cx, cy), { result, ts: Date.now() });
    setScanningState(false);
    renderLabel(result);
  }

  // ---------- result label ----------

  function ensureLabel() {
    if (labelEl) return labelEl;
    labelEl = document.createElement("div");
    labelEl.className = "pce-result-label";
    document.documentElement.appendChild(labelEl);
    return labelEl;
  }

  function removeLabel() {
    if (labelEl && labelEl.parentNode) labelEl.parentNode.removeChild(labelEl);
    labelEl = null;
  }

  function renderLabel(result) {
    ensureLabel();
    moveLabel(lastMouseX, lastMouseY);
    labelEl.replaceChildren();

    // Compute pct from save/was if not directly returned.
    if (result) {
      if (result.pct == null && result.price != null && result.save != null && (result.price + result.save) > 0) {
        result.pct = (result.save / (result.price + result.save)) * 100;
      } else if (result.pct == null && result.price != null && result.was != null && result.was > 0 && result.was > result.price) {
        result.pct = ((result.was - result.price) / result.was) * 100;
      }
      if (result.save == null && result.price != null && result.was != null && result.was > result.price) {
        result.save = +(result.was - result.price).toFixed(2);
      }
    }

    if (!result || (result.price == null && result.save == null && result.was == null && result.pct == null)) {
      labelEl.classList.add("pce-result-empty");
      labelEl.appendChild(makeSpan("pce-empty", "No price detected"));
      requestAnimationFrame(() => { if (labelEl) labelEl.classList.add("pce-visible"); });
      return;
    }
    labelEl.classList.remove("pce-result-empty");

    if (result.price != null) {
      labelEl.appendChild(makeSpan("pce-price", formatMoney(result.price)));
    }
    if (result.was != null && result.was !== result.price) {
      const wasSpan = makeSpan("pce-was");
      const s = document.createElement("s");
      s.textContent = formatMoney(result.was);
      wasSpan.appendChild(s);
      labelEl.appendChild(wasSpan);
    }
    if (result.save != null) {
      labelEl.appendChild(makeSpan("pce-save", "save " + formatMoney(result.save)));
    }
    if (result.pct != null) {
      labelEl.appendChild(makeSpan("pce-pct", "\u2212" + Math.round(result.pct) + "%"));
    }
    requestAnimationFrame(() => { if (labelEl) labelEl.classList.add("pce-visible"); });
  }

  function renderError(message) {
    ensureLabel();
    moveLabel(lastMouseX, lastMouseY);
    labelEl.replaceChildren();
    labelEl.classList.add("pce-result-empty");
    labelEl.appendChild(makeSpan("pce-empty", message));
    requestAnimationFrame(() => { if (labelEl) labelEl.classList.add("pce-visible"); });
  }

  function makeSpan(className, text) {
    const el = document.createElement("span");
    el.className = className;
    if (text != null) el.textContent = text;
    return el;
  }

  function formatMoney(n) {
    return "$" + n.toFixed(2);
  }
})();
