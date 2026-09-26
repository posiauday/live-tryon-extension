const openTryOnBtn = document.getElementById('openTryOnBtn');
const statusEl = document.getElementById('popupStatus');
const rememberChoice = document.getElementById('rememberChoice');

openTryOnBtn.addEventListener('click', async () => {
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'open-tryon' });
    if (!reply || !reply.ok) throw new Error((reply && reply.error) || 'Unable to open Try-On.');
    statusEl.textContent = 'Try-On opened in its own window.';
    window.close();
  } catch (error) {
    statusEl.textContent = `${error.name || 'Error'}: ${error.message || 'Unable to open Try-On.'}`;
  }
});

rememberChoice.addEventListener('change', () => {
  chrome.storage?.local?.set({ rememberChoice: rememberChoice.checked });
});
