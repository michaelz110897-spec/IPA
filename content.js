// Price Comparison Scanner — cursor-box edition.
//
// User flow:
//   1. Click toolbar icon to enable. A 130x130 dashed box follows the cursor.
//   2. Move the cursor over a price. After ~500 ms of stillness the scanner
//      reads what's inside the box and shows the price, save amount and
//      computed %off in a label next to the box.
//   3. Detection has two phases:
//        DOM phase  — walks text nodes inside the box (works for HTML + any
//                     JS-rendered text). Fast, free, exact.
//        OCR phase  — if the DOM phase finds no current price, captures the
//                     130x130 region as PNG and runs Tesseract on the crop.
//                     Handles prices baked into <img>, <canvas>, SVG and
//                     PDF viewers.
//   4. Click toolbar icon again to disable.

(() => {
  if (window.__pceInjected) return;
  window.__pceInjected = true;

  // ---------- frame role ----------
  //
  // The extension runs inside every frame (manifest all_frames=true) so it
  // can detect mousemove on cross-origin iframes such as Adobe Acrobat's PDF
  // viewer. Only the TOP frame draws the cursor box and runs scans; sub-
  // frames merely forward mousemove coordinates to the top frame via
  // postMessage so the top frame can position its single cursor box and
  // OCR-capture the right pixels.

  const isTopFrame = (window === window.top);

  if (!isTopFrame) {
    // ---- sub-frame: forward mousemove to top ----
    document.addEventListener("mousemove", (ev) => {
      try {
        window.parent.postMessage({
          __pce: true,
          type: "subframe-mousemove",
          cx: ev.clientX,
          cy: ev.clientY,
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
  const CACHE_TTL_MS = 3000;
  const BOX_SIZE = 130;
  const HALF = BOX_SIZE / 2;

  // Cache: rounded-cursor-pos -> { result, ts }. Keeps the last few
  // results so re-hovering the same spot doesn't re-scan.
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

  // Receives mousemove forwarded from a sub-frame, translates the coordinates
  // into the top frame's viewport using the iframe's bounding rect, and runs
  // the same scan path as a native mousemove.
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
    const x = r.left + (data.cx || 0);
    const y = r.top + (data.cy || 0);
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
    document.documentElement.appendChild(cursorBox);
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
    // Position to the bottom-right of the box, clamped to viewport.
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
    // Cached results are tied to viewport coordinates of the scan moment;
    // invalidate them on scroll/resize so the next still-cursor reading
    // re-runs.
    resultCache.clear();
    if (enabled) scheduleScan();
  }

  function scheduleScan() {
    if (scheduleTimer) clearTimeout(scheduleTimer);

    // Movement-threshold cache hit: re-use the last result if cursor is close.
    const dx = lastMouseX - lastScanX;
    const dy = lastMouseY - lastScanY;
    if (Math.sqrt(dx * dx + dy * dy) < MOVE_THRESHOLD_PX) {
      const cached = lookupCache(lastScanX, lastScanY);
      if (cached) {
        renderLabel(cached);
        // Still schedule a re-scan in case the cursor settles on a new spot
        // within the threshold.
      }
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
    // Bucket to a 25 px grid so nearby identical scans collapse.
    return Math.round(x / 25) + "," + Math.round(y / 25);
  }

  // ---------- main scan pipeline ----------

  async function runScan() {
    if (!enabled) return;
    const myGen = ++scanGen;
    const cx = lastMouseX;
    const cy = lastMouseY;
    const rect = { x: cx - HALF, y: cy - HALF, w: BOX_SIZE, h: BOX_SIZE };

    // Phase 1 — DOM
    let result = scanDom(rect);

    // Phase 2 — OCR fallback when DOM didn't yield a current price.
    if (!result || result.price == null) {
      try {
        const ocrFragments = await scanOcr(rect);
        if (myGen !== scanGen) return;
        if (ocrFragments && ocrFragments.length) {
          const ocrResult = parsePrices(ocrFragments, "ocr");
          result = mergeResults(result, ocrResult);
        }
      } catch (err) {
        // OCR failure is non-fatal — just keep whatever DOM found (which
        // may be nothing). Log once for debugging.
        if (window.__pceLoggedOcrErr !== true) {
          window.__pceLoggedOcrErr = true;
          console.warn("[pce] OCR fallback failed:", err);
        }
      }
    }

    if (myGen !== scanGen) return;

    lastScanX = cx;
    lastScanY = cy;
    if (result) {
      resultCache.set(cacheKey(cx, cy), { result, ts: Date.now() });
    }
    renderLabel(result);
  }

  // ---------- DOM scanner ----------

  function scanDom(rect) {
    // Use elementsFromPoint at the cursor center, plus a few peripheral
    // points across the box, to ensure we catch elements that aren't
    // exactly at the centre.
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    const probes = [
      [cx, cy],
      [rect.x + 8, rect.y + 8],
      [rect.x + rect.w - 8, rect.y + 8],
      [rect.x + 8, rect.y + rect.h - 8],
      [rect.x + rect.w - 8, rect.y + rect.h - 8],
    ];

    const candidateElements = new Set();
    for (const [px, py] of probes) {
      if (px < 0 || py < 0 || px >= window.innerWidth || py >= window.innerHeight) continue;
      const els = document.elementsFromPoint(px, py);
      for (const el of els) {
        if (!el || el === cursorBox || el === labelEl) continue;
        if (el.classList && el.classList.contains("pce-cursor-box")) continue;
        if (el.classList && el.classList.contains("pce-result-label")) continue;
        candidateElements.add(el);
        // Also walk up a couple of ancestors to catch parent containers
        // whose own text nodes (e.g. price labels with sibling text) live
        // alongside the targeted element.
        let p = el.parentElement;
        for (let i = 0; i < 3 && p; i++) {
          candidateElements.add(p);
          p = p.parentElement;
        }
      }
    }

    if (!candidateElements.size) return null;

    // Walk text nodes inside each candidate element. We collect every text
    // node whose bounding rect intersects the cursor box, deduplicating
    // by node identity.
    const seenNodes = new Set();
    const fragments = [];
    for (const el of candidateElements) {
      collectTextFragments(el, rect, seenNodes, fragments);
    }

    if (!fragments.length) return null;
    const fused = fuseDomDollarCents(fragments);
    return parsePrices(fused, "dom");
  }

  // Detect split big-dollar / small-cents typography in DOM fragments, e.g.
  // <span>$11</span><sup>99</sup>. Replace the two adjacent fragments with a
  // single synthetic "$11.99" fragment so the parser sees the full price.
  function fuseDomDollarCents(fragments) {
    const DOLLAR = /^\$?(\d{1,4})$/;
    const CENTS = /^(\d{2})$/;
    const consumed = new Set();
    const extras = [];
    for (let i = 0; i < fragments.length; i++) {
      if (consumed.has(i)) continue;
      const a = fragments[i];
      const at = (a.text || "").trim();
      const am = at.match(DOLLAR);
      if (!am) continue;
      if (!a.rect) continue;
      const ah = a.rect.bottom - a.rect.top;
      const aw = a.rect.right - a.rect.left;
      if (ah <= 0) continue;
      let bestJ = -1;
      let bestScore = Infinity;
      for (let j = 0; j < fragments.length; j++) {
        if (i === j || consumed.has(j)) continue;
        const b = fragments[j];
        if (!b.rect) continue;
        const bt = (b.text || "").trim();
        const bm = bt.match(CENTS);
        if (!bm) continue;
        const bh = b.rect.bottom - b.rect.top;
        // Cents must be visibly smaller than dollars (superscript / subscript).
        if (bh <= 0 || bh > ah * 0.85) continue;
        // Cents must sit roughly to the right of (and overlapping vertically
        // with) the dollar fragment.
        const gap = b.rect.left - a.rect.right;
        if (gap < -aw * 0.2 || gap > aw * 1.5) continue;
        if (b.rect.top > a.rect.bottom) continue;
        if (b.rect.bottom < a.rect.top) continue;
        const score = Math.abs(gap) + Math.abs(b.rect.top - a.rect.top);
        if (score < bestScore) { bestScore = score; bestJ = j; }
      }
      if (bestJ < 0) continue;
      const dStr = am[1];
      const cStr = (fragments[bestJ].text || "").trim().match(CENTS)[1];
      extras.push({
        text: "$" + dStr + "." + cStr,
        rect: a.rect,
        strikethrough: a.strikethrough,
        fontSize: a.fontSize,
        color: a.color,
      });
      consumed.add(i);
      consumed.add(bestJ);
    }
    if (!extras.length) return fragments;
    const out = [];
    for (let i = 0; i < fragments.length; i++) if (!consumed.has(i)) out.push(fragments[i]);
    for (const e of extras) out.push(e);
    return out;
  }

  function collectTextFragments(root, rect, seenNodes, out) {
    // Skip the extension's own UI.
    if (root.classList && (root.classList.contains("pce-cursor-box") ||
                           root.classList.contains("pce-result-label"))) return;
    // Skip script/style/etc.
    const tag = root.tagName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let node;
    while ((node = walker.nextNode())) {
      if (seenNodes.has(node)) continue;
      seenNodes.add(node);
      const range = document.createRange();
      try {
        range.selectNodeContents(node);
      } catch (_) { continue; }
      const rects = range.getClientRects();
      let intersects = false;
      let nearestRect = null;
      for (const r of rects) {
        if (rectsIntersect(r, rect)) {
          intersects = true;
          nearestRect = r;
          break;
        }
      }
      if (!intersects) continue;
      const parentEl = node.parentElement;
      if (!parentEl) continue;
      const styles = window.getComputedStyle(parentEl);
      out.push({
        text: node.nodeValue.replace(/\s+/g, " ").trim(),
        rect: nearestRect,
        strikethrough: isStrikethrough(styles),
        fontSize: parseFloat(styles.fontSize) || 0,
        color: styles.color || "",
      });
    }
  }

  function rectsIntersect(a, b) {
    return !(a.right < b.x || a.left > b.x + b.w ||
             a.bottom < b.y || a.top > b.y + b.h);
  }

  function isStrikethrough(styles) {
    const dec = (styles.textDecorationLine || styles.textDecoration || "").toLowerCase();
    return dec.indexOf("line-through") !== -1;
  }

  // ---------- price parser ----------
  //
  // Operates on a flat list of fragments. Each fragment is either a DOM text
  // run or an OCR word. We tokenise the text, classify each token, and pick
  // the best (current price, was price, save amount, percent off).

  // Numeric / amount regex. Matches: "$49.99", "49.99", "$1,299", "1299"
  const PRICE_TOKEN_RE = /^\$?\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$|^\$?\d+\.\d{1,2}$|^\$?\d+$/;
  const PERCENT_TOKEN_RE = /^(\d{1,3})%$/;
  // Used to extract a numeric value from anywhere in a token (handles things
  // like "save$5" or "$10.00*").
  const NUM_EXTRACT_RE = /\$?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+\.\d{1,2}|\d+)/;
  const PERCENT_EXTRACT_RE = /(\d{1,3})\s*%/;

  // Words that hint the *next* number is the current price.
  const PRICE_PREFIX_WORDS = new Set([
    "now", "only", "just", "from", "starting", "sale", "today", "price",
  ]);
  // Words that hint the *next* number is an old / reference price.
  const WAS_PREFIX_WORDS = new Set([
    "was", "reg", "reg.", "regular", "regularly", "orig", "orig.", "original",
    "originally", "retail", "msrp", "list", "compare", "value", "before",
  ]);
  // Words that hint the *next* number is a save amount.
  const SAVE_PREFIX_WORDS = new Set([
    "save", "saves", "savings", "discount",
  ]);
  // Tokens to ignore entirely.
  const NOISE_TOKENS = new Set([
    "ea", "ea.", "each", "lb", "lb.", "kg", "pk", "ct", "oz", "*",
    "/", "up", "to", "you", "-", "—", "–", "|",
  ]);

  function parseAmount(token) {
    const m = token.match(NUM_EXTRACT_RE);
    if (!m) return null;
    const v = parseFloat(m[1].replace(/,/g, ""));
    if (!isFinite(v) || v < 0.01 || v > 99999) return null;
    return v;
  }

  function parsePercent(token) {
    const m = token.match(PERCENT_EXTRACT_RE);
    if (!m) return null;
    const v = parseInt(m[1], 10);
    if (!isFinite(v) || v <= 0 || v > 99) return null;
    return v;
  }

  // Convert a fragment list into a flat token list, preserving the
  // strikethrough flag and a "weight" derived from font size.
  function tokenize(fragments) {
    const tokens = [];
    for (const f of fragments) {
      // Pre-split common glued forms like "SAVE$5.00" and strip wrapping
      // brackets so "(was $34.99)" becomes ["was", "$34.99"].
      const cleaned = f.text
        .replace(/[(){}\[\]<>]/g, " ")
        .replace(/([A-Za-z])(\$?\d)/g, "$1 $2")
        .replace(/(\d)([A-Za-z])/g, "$1 $2")
        .replace(/([%])([A-Za-z])/g, "$1 $2");
      const parts = cleaned.split(/\s+/).filter(Boolean);
      for (const p of parts) {
        const stripped = p.replace(/[,;:.\u00a0*\u2020\u2021]+$/g, "");
        if (!stripped) continue;
        tokens.push({
          text: stripped,
          low: stripped.toLowerCase(),
          strikethrough: !!f.strikethrough,
          fontSize: f.fontSize || 0,
        });
      }
    }
    return tokens;
  }

  function classifyToken(tok) {
    const t = tok.text;
    const low = tok.low;
    if (NOISE_TOKENS.has(low)) return "noise";
    if (PERCENT_TOKEN_RE.test(t)) return "percent";
    if (PRICE_TOKEN_RE.test(t)) return "numeric";
    if (PRICE_PREFIX_WORDS.has(low)) return "price-prefix";
    if (WAS_PREFIX_WORDS.has(low)) return "was-prefix";
    if (SAVE_PREFIX_WORDS.has(low)) return "save-prefix";
    // Glued forms like "save$5" or "was$10".
    if (/^save/i.test(low) && /\d/.test(t)) return "save-glued";
    if (/^was/i.test(low) && /\d/.test(t)) return "was-glued";
    // Anything containing letters is just a generic word (context only).
    if (/[A-Za-z]/.test(t)) return "word";
    return "noise";
  }

  // Main parser. Returns { price, was, save, pct, source } or null.
  function parsePrices(fragments, source) {
    const tokens = tokenize(fragments);
    if (!tokens.length) return null;
    for (const tk of tokens) tk.role = classifyToken(tk);

    let price = null;
    let priceWeight = -1;
    let was = null;
    let save = null;
    let pct = null;

    for (let i = 0; i < tokens.length; i++) {
      const tk = tokens[i];

      // Direct percent-off detection (e.g. "25%").
      if (tk.role === "percent") {
        // Only treat as a discount percent if a nearby word says so, or if
        // it's the only signal we have. Avoids picking up things like "5% APR".
        const nearby = (tokens[i - 1] && /off|discount|save/i.test(tokens[i - 1].low)) ||
                       (tokens[i + 1] && /off|discount/i.test(tokens[i + 1].low));
        const v = parsePercent(tk.text);
        if (v != null && (nearby || pct == null)) {
          if (pct == null || nearby) pct = v;
        }
        continue;
      }

      // Glued forms.
      if (tk.role === "save-glued") {
        const v = parseAmount(tk.text);
        if (v != null && save == null) save = v;
        continue;
      }
      if (tk.role === "was-glued") {
        const v = parseAmount(tk.text);
        if (v != null && was == null) was = v;
        continue;
      }

      if (tk.role !== "numeric") continue;

      const v = parseAmount(tk.text);
      if (v == null) continue;

      // Look at the immediate left neighbour for prefix context.
      const prev = tokens[i - 1] || null;
      const prevRole = prev ? prev.role : null;

      // Strikethrough numbers are always reference (was) prices.
      if (tk.strikethrough) {
        if (was == null || v > was) was = v;
        continue;
      }

      if (prevRole === "save-prefix") {
        if (save == null) save = v;
        continue;
      }
      if (prevRole === "was-prefix") {
        if (was == null) was = v;
        continue;
      }

      // Otherwise this is a candidate for the current price.
      let weight = 0;
      if (prevRole === "price-prefix") weight += 3;
      if (tk.text.indexOf("$") === 0) weight += 2;
      weight += tk.fontSize / 10;
      if (weight > priceWeight) {
        priceWeight = weight;
        price = v;
      }
    }

    // If we have was + price but no save, derive save.
    if (was != null && price != null && save == null && was > price) {
      save = +(was - price).toFixed(2);
    }

    // Compute pct if not directly detected.
    if (pct == null) {
      if (price != null && save != null && price + save > 0) {
        pct = (save / (price + save)) * 100;
      } else if (price != null && was != null && was > 0) {
        pct = ((was - price) / was) * 100;
      }
    }

    if (price == null && save == null && was == null && pct == null) return null;
    return { price, was, save, pct, source };
  }

  // Combine a DOM result with an OCR result, preferring DOM where present.
  function mergeResults(dom, ocr) {
    if (!dom) return ocr;
    if (!ocr) return dom;
    return {
      price: dom.price != null ? dom.price : ocr.price,
      was: dom.was != null ? dom.was : ocr.was,
      save: dom.save != null ? dom.save : ocr.save,
      pct: dom.pct != null ? dom.pct : ocr.pct,
      source: dom.price != null ? dom.source : ocr.source,
    };
  }

  // ---------- OCR fallback ----------

  async function scanOcr(rect) {
    // Clamp to viewport — captureVisibleTab can't see beyond it.
    const clamped = {
      x: Math.max(0, Math.floor(rect.x)),
      y: Math.max(0, Math.floor(rect.y)),
      w: Math.min(BOX_SIZE, Math.floor(window.innerWidth - Math.max(0, rect.x))),
      h: Math.min(BOX_SIZE, Math.floor(window.innerHeight - Math.max(0, rect.y))),
    };
    if (clamped.w < 10 || clamped.h < 10) return null;
    const dpr = window.devicePixelRatio || 1;
    const reply = await chrome.runtime.sendMessage({
      type: "pce-scan-crop",
      rect: clamped,
      dpr,
    });
    if (!reply || !reply.ok || !reply.words) return null;
    // Convert OCR words to fragments. OCR doesn't tell us strikethrough or
    // font size, so we infer font size from word height.
    const out = [];
    for (const w of reply.words) {
      if (!w || !w.text) continue;
      const h = (w.bbox && (w.bbox.y1 - w.bbox.y0)) || 0;
      out.push({
        text: w.text,
        rect: null,
        strikethrough: false,
        fontSize: h / dpr,
        color: "",
      });
    }
    // Fuse split big-dollar / small-cents typography common on price stickers
    // (e.g. "$11" then "99" rendered as superscript). We only do this in the
    // OCR path; DOM text is already concatenated.
    return fuseDollarCents(out, reply.words);
  }

  function fuseDollarCents(fragments, rawWords) {
    if (!rawWords || rawWords.length < 2) return fragments;
    const DOLLAR = /^\$?\d{1,4}$/;
    const CENTS = /^\d{2}$/;
    const FULL = /^\$?\d{1,3}(?:,\d{3})*\.\d{2}$/;
    const consumed = new Set();
    const extras = [];
    for (let i = 0; i < rawWords.length; i++) {
      const d = rawWords[i];
      const dt = (d.text || "").replace(/[,;:.\u00a0]+$/g, "");
      if (!DOLLAR.test(dt) || FULL.test(dt)) continue;
      const dh = d.bbox.y1 - d.bbox.y0;
      const dw = d.bbox.x1 - d.bbox.x0;
      if (dh <= 0) continue;
      let best = null;
      let bestScore = Infinity;
      for (let j = 0; j < rawWords.length; j++) {
        if (i === j) continue;
        const c = rawWords[j];
        if (consumed.has(j)) continue;
        const ct = (c.text || "").replace(/[,;:.\u00a0]+$/g, "");
        if (!CENTS.test(ct)) continue;
        const ch = c.bbox.y1 - c.bbox.y0;
        if (ch > dh * 0.85) continue;
        const gap = c.bbox.x0 - d.bbox.x1;
        if (gap < -dw * 0.2 || gap > dw * 1.5) continue;
        if (c.bbox.y0 > d.bbox.y0 + dh * 0.35) continue;
        const score = Math.abs(gap) + Math.abs(c.bbox.y0 - d.bbox.y0);
        if (score < bestScore) { bestScore = score; best = j; }
      }
      if (best == null) continue;
      const dStr = dt.replace(/^\$/, "");
      const cStr = (rawWords[best].text || "").replace(/[,;:.\u00a0]+$/g, "");
      extras.push({
        text: "$" + dStr + "." + cStr,
        rect: null,
        strikethrough: false,
        fontSize: fragments[i] ? fragments[i].fontSize : 0,
        color: "",
      });
      consumed.add(i);
      consumed.add(best);
    }
    if (!extras.length) return fragments;
    const out = [];
    for (let i = 0; i < fragments.length; i++) if (!consumed.has(i)) out.push(fragments[i]);
    for (const e of extras) out.push(e);
    return out;
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

    if (!result || (result.price == null && result.save == null && result.was == null && result.pct == null)) {
      labelEl.textContent = "—";
      labelEl.classList.add("pce-result-empty");
      return;
    }
    labelEl.classList.remove("pce-result-empty");

    const parts = [];
    if (result.price != null) parts.push(formatMoney(result.price));
    if (result.was != null && result.was !== result.price) parts.push("was " + formatMoney(result.was));
    if (result.save != null) parts.push("save " + formatMoney(result.save));
    if (result.pct != null) parts.push(result.pct.toFixed(2) + "% off");
    labelEl.textContent = parts.join(" · ");
  }

  function formatMoney(n) {
    return "$" + n.toFixed(2);
  }
})();
