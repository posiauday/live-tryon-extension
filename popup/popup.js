const openTryOnBtn = document.getElementById('openTryOnBtn');
const statusEl = document.getElementById('popupStatus');
const rememberChoice = document.getElementById('rememberChoice');

openTryOnBtn.addEventListener('click', async () => {
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL('camera/camera.html') });
    statusEl.textContent = 'Try-On opened in a new tab.';
  } catch (error) {
    statusEl.textContent = `${error.name || 'Error'}: ${error.message || 'Unable to open Try-On.'}`;
  }
});

rememberChoice.addEventListener('change', () => {
  chrome.storage?.local?.set({ rememberChoice: rememberChoice.checked });
});
