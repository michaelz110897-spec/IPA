// Tracks which tabs currently have the scanner active.
const activeTabs = new Set();

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
    // Content script may not be injected (e.g. on chrome:// pages). Roll back state.
    if (nextActive) activeTabs.delete(tab.id);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  activeTabs.delete(tabId);
});
