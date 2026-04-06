// Tracks which tabs currently have the scanner active.
const activeTabs = new Set();

const NATIVE_PDF_VIEWER_PREFIX = "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/";
const ADOBE_PDF_VIEWER_PREFIX = "chrome-extension://efaidnbmnnnibpcajpcglclefindmkaj/";
const ADOBE_URL_PARAM_NAMES = ["pdfurl", "originalurl", "original-url", "url", "file", "src"];

function isPdfUrl(url) {
  if (!url) return false;
  if (url.startsWith(NATIVE_PDF_VIEWER_PREFIX)) return true;
  if (url.startsWith(ADOBE_PDF_VIEWER_PREFIX)) return true;
  try {
    const u = new URL(url);
    return /\.pdf$/i.test(u.pathname);
  } catch {
    return false;
  }
}

// Best-effort extraction of the original PDF URL from an Adobe Acrobat
// browser-extension viewer URL. Adobe's viewer format is undocumented and
// varies between versions — try several common query parameter names.
function extractAdobeOriginalUrl(adobeUrl) {
  try {
    const u = new URL(adobeUrl);
    for (const name of ADOBE_URL_PARAM_NAMES) {
      const v = u.searchParams.get(name);
      if (v && /^https?:\/\//i.test(v)) return v;
    }
    // Some versions store the URL in the hash fragment.
    if (u.hash) {
      const hashParams = new URLSearchParams(u.hash.replace(/^#/, ""));
      for (const name of ADOBE_URL_PARAM_NAMES) {
        const v = hashParams.get(name);
        if (v && /^https?:\/\//i.test(v)) return v;
      }
    }
  } catch {}
  return null;
}

function notifyAdobeUnsupported() {
  try {
    chrome.notifications.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: "Price Scanner",
      message:
        "This PDF is being displayed by the Adobe Acrobat browser extension, which blocks scanning. " +
        "Disable the Adobe extension (or its 'Open in Acrobat' setting) on this page and reload.",
    });
  } catch {}
}

function viewerUrlFor(originalUrl) {
  return chrome.runtime.getURL("pdf-viewer.html") + "?file=" + encodeURIComponent(originalUrl);
}

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || tab.id == null) return;

  // If the tab points at a PDF (native viewer, Adobe viewer, or raw .pdf URL)
  // and we're not already on our own viewer, redirect first.
  const onOwnViewer = tab.url && tab.url.startsWith(chrome.runtime.getURL("pdf-viewer.html"));
  if (!onOwnViewer && isPdfUrl(tab.url)) {
    let sourceUrl = tab.url;
    if (tab.url.startsWith(ADOBE_PDF_VIEWER_PREFIX)) {
      const recovered = extractAdobeOriginalUrl(tab.url);
      if (!recovered) {
        // Adobe hid the original URL — we can't render it ourselves.
        notifyAdobeUnsupported();
        return;
      }
      sourceUrl = recovered;
    }
    const target = viewerUrlFor(sourceUrl);
    const done = waitForTabComplete(tab.id);
    await chrome.tabs.update(tab.id, { url: target });
    await done;
    activeTabs.add(tab.id);
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "pce-toggle", active: true });
    } catch {
      activeTabs.delete(tab.id);
    }
    return;
  }

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
