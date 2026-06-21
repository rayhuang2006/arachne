const STORAGE_KEY = "tabLastSeen";

async function getLastSeen() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] ?? {};
}

async function setLastSeen(map) {
  await chrome.storage.local.set({ [STORAGE_KEY]: map });
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms} 毫秒`;
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds} 秒`;
  return `${minutes} 分 ${seconds} 秒`;
}

async function handleTabActivated(tabId) {
  const now = Date.now();
  const map = await getLastSeen();
  const lastSeen = map[tabId];

  if (lastSeen != null) {
    const idleMs = now - lastSeen;
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: "ARACHNE_IDLE_DURATION",
        idleMs,
        label: formatDuration(idleMs),
      });
    } catch {
      // Content script not ready (e.g. chrome:// pages, just-opened tabs)
    }
  }

  map[tabId] = now;
  await setLastSeen(map);
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
  handleTabActivated(tabId);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const map = await getLastSeen();
  delete map[tabId];
  await setLastSeen(map);
});

// When a window gains focus, record the currently active tab in that window.
// This handles the case where the user switches back to Chrome from another app.
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (tab) handleTabActivated(tab.id);
});

// ── Debug helper (call from service worker DevTools console) ─────────────
// 1. Open chrome://extensions → Arachne → "Service Worker" link
// 2. In that console:
//      const [tab] = await chrome.tabs.query({active:true, currentWindow:true})
//      debugWeb(tab.id, 3600)   // simulate 1-hour idle on active tab
self.debugWeb = async (tabId, seconds) => {
  const idleMs = seconds * 1000;
  await chrome.tabs.sendMessage(tabId, {
    type: "ARACHNE_IDLE_DURATION",
    idleMs,
    label: `${seconds}s (debug)`,
  });
};
