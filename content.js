(() => {
  if (window.__pceInjected) return;
  window.__pceInjected = true;

  const RECT_W = 100;
  const RECT_H = 262;

  // Price: a dollar amount NOT preceded by a letter (word char). Optional $.
  // Group 1 = the numeric value.
  const PRICE_RE = /(^|[^A-Za-z0-9])\$?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)(?!\d)/g;
  // Save: preceded by "SAVE" (case-insensitive).
  const SAVE_RE = /SAVE\s*\$?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/i;

  let active = false;
  let rectEl = null;
  let labelEl = null;
  let mouseX = 0;
  let mouseY = 0;
  let rafPending = false;

  function parseAmount(s) {
    return parseFloat(s.replace(/,/g, ""));
  }

  function formatMoney(n) {
    return "$" + n.toFixed(2);
  }

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
      requestAnimationFrame(update);
    }
  }

  function update() {
    rafPending = false;
    if (!active || !rectEl) return;

    const left = mouseX - RECT_W / 2;
    const top = mouseY - RECT_H / 2;
    rectEl.style.left = left + "px";
    rectEl.style.top = top + "px";

    const rect = { left, top, right: left + RECT_W, bottom: top + RECT_H };
    scanAndRender(rect);
  }

  function intersects(a, b) {
    return !(
      a.right < b.left ||
      a.left > b.right ||
      a.bottom < b.top ||
      a.top > b.bottom
    );
  }

  // Collect text nodes whose rect intersects the scan rectangle.
  function collectTextNodes(scanRect) {
    const results = [];
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          // Skip our own overlay.
          if (parent.closest && parent.closest(".pce-rect")) return NodeFilter.FILTER_REJECT;
          const tag = parent.tagName;
          if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );

    let n;
    while ((n = walker.nextNode())) {
      const range = document.createRange();
      range.selectNodeContents(n);
      const rects = range.getClientRects();
      for (let i = 0; i < rects.length; i++) {
        const r = rects[i];
        if (intersects(r, scanRect)) {
          results.push(n);
          break;
        }
      }
    }
    return results;
  }

  function findPriceAndSave(scanRect) {
    const nodes = collectTextNodes(scanRect);
    // Join text in DOM order — preserves "SAVE" on one node and number on another.
    let combined = "";
    for (const n of nodes) {
      combined += " " + n.nodeValue;
    }
    combined = combined.replace(/\s+/g, " ").trim();
    if (!combined) return { price: null, save: null };

    // Find save first.
    let save = null;
    const saveMatch = combined.match(SAVE_RE);
    if (saveMatch) save = parseAmount(saveMatch[1]);

    // Find first price not preceded by a letter and not the SAVE number itself.
    let price = null;
    let m;
    PRICE_RE.lastIndex = 0;
    while ((m = PRICE_RE.exec(combined)) !== null) {
      const valStr = m[2];
      const val = parseAmount(valStr);
      // Skip if this match is the SAVE amount (same index region).
      if (saveMatch) {
        const saveIdx = combined.toUpperCase().indexOf("SAVE");
        if (saveIdx !== -1 && m.index >= saveIdx && m.index <= saveIdx + saveMatch[0].length) {
          continue;
        }
      }
      price = val;
      break;
    }

    return { price, save };
  }

  function scanAndRender(scanRect) {
    const { price, save } = findPriceAndSave(scanRect);
    if (price != null && save != null && price + save > 0) {
      const pct = (save / (price + save)) * 100;
      labelEl.textContent =
        "Price: " + formatMoney(price) +
        "  |  Save: " + formatMoney(save) +
        "  |  " + pct.toFixed(2) + "% off";
      labelEl.style.display = "";
    } else {
      labelEl.style.display = "none";
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
    destroyOverlay();
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "pce-toggle") return;
    if (msg.active) activate();
    else deactivate();
  });
})();
