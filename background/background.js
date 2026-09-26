// Clicking the toolbar icon (or Alt+Shift+T) shows the try-on as a floating panel ON the current page, so
// garments can be dragged straight from the shop page into it. It never opens a window by itself: if the
// panel cannot be shown, the icon gets a red "!" and its tooltip says why.
const TRYON_URL = chrome.runtime.getURL('camera/camera.html');

// Only used when the user asks for it (the camera-permission helper in the panel).
async function openTryOnWindow() {
  const existing = await chrome.tabs.query({ url: `${TRYON_URL}*` });
  if (existing.length) {
    await chrome.windows.update(existing[0].windowId, { focused: true });
    await chrome.tabs.update(existing[0].id, { active: true });
    return;
  }
  await chrome.windows.create({ url: TRYON_URL, type: 'popup', width: 1200, height: 900 });
}

async function flag(tabId, text, title) {
  await chrome.action.setBadgeText({ tabId, text });
  if (text) await chrome.action.setBadgeBackgroundColor({ tabId, color: '#ef5b5b' });
  await chrome.action.setTitle({ tabId, title });
}

const injectPanel = (tabId) => chrome.scripting.executeScript({ target: { tabId }, files: ['content/panel.js'] });

async function togglePanel(tab) {
  if (!tab || !tab.id) return;
  const url = tab.url || '';
  if (!/^(https?|file):/.test(url) || /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/.test(url)) {
    await flag(tab.id, '!', 'Chrome does not let extensions run on this kind of page. Open a normal website and click again.');
    return;
  }
  try {
    await injectPanel(tab.id);
    await flag(tab.id, '', 'Live Try-On (click to show / hide the panel)');
  } catch (error) {
    // Usually a missing host permission. Ask once for this site (a toolbar click counts as a user gesture), then retry.
    try {
      const granted = url.startsWith('http') && await chrome.permissions.request({ origins: [`${new URL(url).origin}/*`] });
      if (granted) { await injectPanel(tab.id); await flag(tab.id, '', 'Live Try-On (click to show / hide the panel)'); return; }
    } catch (permissionError) { /* fall through to the visible error */ }
    console.error('Could not open the try-on panel', error);
    await flag(tab.id, '!', `Could not open the panel on this page: ${error.message || error}`);
  }
}

chrome.action.onClicked.addListener(togglePanel);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'open-tryon') { openTryOnWindow().then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: e.message })); return true; }
});
