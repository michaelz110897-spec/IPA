// Tracks which tabs currently have the scanner active.
const activeTabs = new Set();

const NATIVE_PDF_VIEWER_PREFIX = "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/";

function isPdfUrl(url) {
  if (!url) return false;
  if (url.startsWith(NATIVE_PDF_VIEWER_PREFIX)) return true;
  try {
    const u = new URL(url);
    return /\.pdf$/i.test(u.pathname);
  } catch {
    return false;
  }
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

  // If the tab points at a PDF (native viewer or raw .pdf URL) and we're not
  // already on our own viewer, redirect first.
  const onOwnViewer = tab.url && tab.url.startsWith(chrome.runtime.getURL("pdf-viewer.html"));
  if (!onOwnViewer && isPdfUrl(tab.url)) {
    const target = viewerUrlFor(tab.url);
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
