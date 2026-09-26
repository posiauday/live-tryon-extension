// Clicking the toolbar icon (or Alt+Shift+T) shows the try-on as a floating panel on the current page, so
// garments can be dragged straight from the shop page into it. On pages where extensions cannot inject
// (chrome://, the Web Store, ...) it falls back to a standalone popup window.
const TRYON_URL = chrome.runtime.getURL('camera/camera.html');

async function openTryOnWindow() {
  const existing = await chrome.tabs.query({ url: `${TRYON_URL}*` });
  if (existing.length) {
    await chrome.windows.update(existing[0].windowId, { focused: true });
    await chrome.tabs.update(existing[0].id, { active: true });
    return;
  }
  await chrome.windows.create({ url: TRYON_URL, type: 'popup', width: 1200, height: 900 });
}

async function togglePanel(tab) {
  try {
    if (!tab || !tab.id || !/^(https?|file):/.test(tab.url || '')) throw new Error('This page cannot host the panel');
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/panel.js'] });
  } catch (error) {
    await openTryOnWindow();
  }
}

chrome.action.onClicked.addListener(togglePanel);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'open-tryon') { openTryOnWindow().then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: e.message })); return true; }
});
