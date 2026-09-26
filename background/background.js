// Opens (or focuses) the try-on in a compact popup window. A toolbar popup closes as soon as you
// drag a file in from another window, and it cannot show the camera permission prompt.
const TRYON_URL = chrome.runtime.getURL('camera/camera.html');

async function openTryOn() {
  const existing = await chrome.tabs.query({ url: `${TRYON_URL}*` });
  if (existing.length) {
    await chrome.windows.update(existing[0].windowId, { focused: true });
    await chrome.tabs.update(existing[0].id, { active: true });
    return;
  }
  await chrome.windows.create({ url: TRYON_URL, type: 'popup', width: 1180, height: 820 });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'open-tryon') { openTryOn().then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: e.message })); return true; }
});
