// Live try-on page. One screen: your camera until the AI (Decart Lucy V-TON) output arrives, then the try-on in the
// same place. The AI session (and billing) starts when a garment is dropped and ends with "End session" / Stop / close.
let stream = null;
let running = false;
let recorder = null;
let recordedChunks = [];
let recordTimer = null;
let composite = null;
let apiKey = '';
let live = null;
let currentGarment = null; // { blob } last garment chosen, re-applied when the fit type / description changes
let garmentApplied = false;
const TRY_ON_SECONDS = 60; // every garment gets exactly one minute, then it is removed and everything resets
let countdown = null;
const embedded = new URLSearchParams(location.search).has('embed');
if (embedded) document.documentElement.classList.add('embed');
const $ = (id) => document.getElementById(id);
// tell the on-page panel what is going on, so it can show it while minimized
function postStatus(text) { if (embedded && window.parent !== window) window.parent.postMessage({ tryon: 'status', text }, '*'); }
try { const v = chrome.runtime.getManifest().version; const eyebrow = document.querySelector('.eyebrow'); if (eyebrow) eyebrow.textContent = `Virtual fitting room · v${v}`; } catch (error) { /* not running as an extension */ }

const video = $('userVideo');
const aiVideo = $('aiVideo');
const statusBadge = $('statusBadge');
const errorMessage = $('errorMessage');
const toast = $('toast');
const recordBtn = $('recordBtn');
const aiBadge = $('aiBadge');
const aiState = $('aiState');
const aiMeter = $('aiMeter');
const endBtn = $('aiStartBtn'); // "End session"
const dropHintText = $('dropHintText');

// ---------- small helpers ----------
const store = {
  async get(key) {
    try { if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) { const r = await chrome.storage.local.get(key); return r[key]; } } catch (e) { /* fall through */ }
    try { return localStorage.getItem(key) || undefined; } catch (e) { return undefined; }
  },
  async set(key, value) {
    try { if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) { await chrome.storage.local.set({ [key]: value }); return; } } catch (e) { /* fall through */ }
    try { localStorage.setItem(key, value); } catch (e) { /* ignore */ }
  }
};

function cameraError(error) {
  const messages = { NotAllowedError: 'Camera permission was denied. Allow camera access for this extension page and try again.', NotFoundError: 'No camera was found. Connect a camera and try again.', NotReadableError: 'The camera is busy or unavailable. Close other camera apps and try again.', SecurityError: 'Camera access is blocked by the browser security policy.' };
  return `${error.name || 'CameraError'}: ${messages[error.name] || error.message || 'Unable to start the camera.'}`;
}

function showToast(text, ms = 4000) {
  toast.textContent = text; toast.hidden = false;
  clearTimeout(showToast.timer); showToast.timer = setTimeout(() => { toast.hidden = true; }, ms);
}

// ---------- camera ----------
async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, facingMode: 'user' }, audio: false });
    video.srcObject = stream;
    await video.play();
    running = true;
    statusBadge.textContent = '🔴 Live';
    errorMessage.hidden = true;
  } catch (error) {
    statusBadge.textContent = 'Camera error';
    errorMessage.textContent = cameraError(error);
    if (embedded && error.name === 'NotAllowedError' && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      const help = document.createElement('button'); help.className = 'btn btn-glass'; help.textContent = 'Allow the camera in a window';
      help.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'open-tryon' }));
      errorMessage.append(document.createElement('br'), 'Chrome may not prompt inside a page. Allow it once in the window that opens, then reopen this panel. ', help);
    }
    errorMessage.hidden = false;
    console.error(error);
  }
}

function stopCamera() {
  running = false;
  stopAi();
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  if (stream) stream.getTracks().forEach((track) => track.stop());
  stream = null; video.srcObject = null; statusBadge.textContent = 'Camera stopped';
}

function aiOnScreen() { return !aiVideo.hidden && aiVideo.videoWidth > 0; }

// What is on screen right now (AI output, or the mirrored camera), for capture / recording.
function drawComposite() {
  const ai = aiOnScreen(); const src = ai ? aiVideo : video;
  const w = src.videoWidth || 1280, h = src.videoHeight || 720;
  if (!composite) composite = document.createElement('canvas');
  if (composite.width !== w || composite.height !== h) { composite.width = w; composite.height = h; }
  const ctx = composite.getContext('2d');
  if (ai) { ctx.drawImage(aiVideo, 0, 0, w, h); return composite; } // the AI stream is already mirrored
  ctx.setTransform(-1, 0, 0, 1, w, 0); // match the mirrored on-screen view
  ctx.drawImage(video, 0, 0, w, h);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return composite;
}

// ---------- AI session (Decart Lucy V-TON) ----------
const STATE_LABELS = { connecting: 'Connecting...', connected: 'Connected', generating: 'Live', reconnecting: 'Reconnecting...', disconnected: 'Ready' };

function setAiState(text, tone) {
  aiState.textContent = text; aiState.dataset.tone = tone || '';
  aiBadge.hidden = !text || text === STATE_LABELS.disconnected;
  aiBadge.textContent = `AI · ${text}`;
  postStatus(text === STATE_LABELS.disconnected ? '' : `AI · ${text}`);
}

function setGarmentHint() {
  dropHintText.textContent = garmentApplied ? 'Drop another garment to switch' : 'Drag a product image here';
}

const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const meterText = (left, cost) => `${clock(left)} left · $${cost.toFixed(2)}`;
const IDLE_METER = meterText(TRY_ON_SECONDS, 0);

function stopCountdown() { clearInterval(countdown); countdown = null; }
function startCountdown() {
  stopCountdown();
  const t0 = Date.now();
  const tick = () => {
    const used = Math.min(TRY_ON_SECONDS, (Date.now() - t0) / 1000); const left = TRY_ON_SECONDS - used;
    aiMeter.textContent = meterText(left, used * DECART_PRICE_PER_SECOND);
    postStatus(`AI · ${clock(left)} left`);
    if (left <= 0) endTryOn('Time is up');
  };
  tick(); countdown = setInterval(tick, 250);
}

// Time is up (or the user removed the garment): end the session, DELETE the garment, and reset to the plain camera.
function endTryOn(reason) {
  stopAi();
  showToast(`${reason}. The garment was removed. Drop another product image to start a new minute.`, 6000);
}

// everything that must be true again when no garment is being tried on
function resetTryOnUi() {
  stopCountdown(); currentGarment = null; garmentApplied = false;
  aiVideo.hidden = true; aiVideo.srcObject = null; endBtn.hidden = true;
  aiMeter.textContent = IDLE_METER; setGarmentHint();
}

function ensureLive() {
  if (live) return live;
  live = new DecartLive({
    onRemoteStream: (remote) => { aiVideo.srcObject = remote; aiVideo.hidden = false; aiVideo.play().catch(() => {}); },
    onState: (state) => {
      setAiState(STATE_LABELS[state] || state, state === 'generating' ? 'ok' : state === 'reconnecting' ? 'warn' : '');
      endBtn.hidden = state === 'disconnected';
      if (state === 'disconnected') resetTryOnUi();
    },
    onQueue: (q) => setAiState(`In queue · #${q.position} of ${q.queueSize}`, 'warn'),
    onEnded: (reason) => showToast(`AI session ended: ${reason}`),
    onError: (error) => { console.warn('Decart error', error); showToast(`AI error: ${error.message || error}`); }
  });
  return live;
}

async function startAi() {
  if (!apiKey) { showToast('Add your Decart API key first.'); $('apiKeyInput').focus(); return false; }
  if (!stream) { showToast('Start the camera first.'); return false; }
  const session = ensureLive();
  if (session.active) return true;
  setAiState('Connecting...');
  try {
    await session.connect({ apiKey, stream, limitSeconds: TRY_ON_SECONDS });
    endBtn.hidden = false; startCountdown(); // billing runs from here: one minute per garment
    if (currentGarment) await applyGarmentToAi();
    return true;
  } catch (error) {
    console.error(error);
    setAiState('Error', 'bad'); resetTryOnUi();
    showToast(`Could not start AI: ${error.message || error}`);
    return false;
  }
}

function stopAi() {
  if (live && (live.active || live.connected)) live.disconnect();
  resetTryOnUi();
}

async function applyGarmentToAi() {
  if (!live || !live.connected || !currentGarment) return;
  try {
    await live.setGarment(currentGarment.blob, currentGarment.kind);
    garmentApplied = true; setGarmentHint();
    showToast('Garment sent. It appears on you within a couple of seconds.');
  } catch (error) { showToast(`Could not set garment: ${error.message || error}`); }
}

endBtn.addEventListener('click', () => endTryOn('Try-on ended'));

function refreshKeyUI() { $('keyForm').hidden = !!apiKey; $('sessionControls').hidden = !apiKey; }
$('saveKeyBtn').addEventListener('click', async () => {
  const value = $('apiKeyInput').value.trim();
  if (!value) { showToast('Paste your Decart API key.'); return; }
  apiKey = value; await store.set('decartKey', value); $('apiKeyInput').value = ''; refreshKeyUI();
  showToast(currentGarment ? 'Key saved. Starting your try-on...' : 'Key saved. Now drop a garment onto the camera.');
  if (currentGarment) startAi();
});
$('changeKeyBtn').addEventListener('click', async () => { stopAi(); apiKey = ''; await store.set('decartKey', ''); refreshKeyUI(); });

// ---------- garment image input: drag & drop, upload, paste ----------
// createImageBitmap cannot decode SVG (some shops serve it); fall back to an <img> element.
async function decodeImage(blob) {
  try { return await createImageBitmap(blob); } catch (error) {
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image(); img.src = url; await img.decode();
      if (!img.naturalWidth) { img.width = 1024; img.height = 1024; }
      return img;
    } finally { setTimeout(() => URL.revokeObjectURL(url), 10000); }
  }
}
async function bitmapToBlob(bitmap, maxSide = 1024) {
  const bw = bitmap.naturalWidth || bitmap.width, bh = bitmap.naturalHeight || bitmap.height;
  const s = Math.min(1, maxSide / Math.max(bw, bh));
  const c = document.createElement('canvas'); c.width = Math.round(bw * s); c.height = Math.round(bh * s);
  c.getContext('2d').drawImage(bitmap, 0, 0, c.width, c.height);
  return new Promise((resolve) => c.toBlob(resolve, 'image/png'));
}

// A garment arrived (file, drag from a page, paste). Store it, then start the AI session or switch garment.
async function loadGarmentSource(blobOrFile, hint = '') {
  const garment = { blob: await bitmapToBlob(await decodeImage(blobOrFile)), kind: kindFromHint(hint || blobOrFile.name || '') };
  if (live && (live.active || live.connected)) stopAi(); // switching garments: end the old minute, start a fresh one
  currentGarment = garment;
  if (!apiKey) { showToast('Garment ready. Paste your Decart API key in the AI session card and press Save to try it on.', 6000); $('apiKeyInput').focus(); return; }
  await startAi();
}

// The image URL of something dragged out of a web page (prefers the <img> over a surrounding link), plus any text
// that says what it is ("Black leather jacket", "slim-fit-jeans.jpg") so the right kind of garment prompt is used.
function inspectDrop(dataTransfer) {
  const html = dataTransfer.getData('text/html');
  let src = '', alt = '';
  if (html) { try { const img = new DOMParser().parseFromString(html, 'text/html').querySelector('img'); if (img) { src = img.getAttribute('src') || ''; alt = `${img.getAttribute('alt') || ''} ${img.getAttribute('title') || ''}`; } } catch (error) { /* fall back to the URL list */ } }
  let url = src || (dataTransfer.getData('text/uri-list') || dataTransfer.getData('text/plain') || '').split('\n')[0].trim();
  if (url.startsWith('//')) url = `https:${url}`;
  if (!/^(https?:\/\/|data:image\/)/.test(url)) url = '';
  let name = ''; try { name = url.startsWith('http') ? decodeURIComponent(new URL(url).pathname.split('/').pop() || '') : ''; } catch (error) { /* ignore */ }
  return { url, hint: `${alt} ${name}`.trim() };
}

async function fetchImageBlob(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  if (!blob.type.startsWith('image/')) throw new Error('not an image');
  return blob;
}

async function handleDrop(dataTransfer) {
  try {
    const file = Array.from(dataTransfer.files || []).find((f) => f.type.startsWith('image/'));
    if (file) { await loadGarmentSource(file, file.name); return; }
    const { url, hint } = inspectDrop(dataTransfer);
    if (!url) { showToast('Drop an image (PNG or JPG).'); return; }
    await loadGarmentSource(await fetchImageBlob(url), hint || url);
  } catch (error) {
    showSitesHelp(); console.warn(error);
  }
}

// ---------- drops forwarded by the on-page panel ----------
// Chrome does not deliver drag events from the shop page into this iframe, so content/panel.js catches the drop on the
// page and sends it here with chrome.runtime.sendMessage (a web page cannot forge those).
const pid = new URLSearchParams(location.search).get('pid');
let sitesGranted = false;
function showSitesHelp() {
  showToast(sitesGranted ? 'Could not read that image. Try another one, or save it and drop the file.' : 'Chrome cannot read images from that site yet. Click "Allow dragging from all sites" in the AI session card, then drop again.', 7000);
  const b = $('allowSitesBtn'); if (b && !$('sitesRow').hidden) { b.classList.add('attention'); b.scrollIntoView({ block: 'nearest' }); }
}
async function handleForwardedDrop(msg) {
  try {
    if (msg.kind === 'data') await loadGarmentSource(await (await fetch(msg.dataUrl)).blob(), msg.hint);
    else if (msg.kind === 'url') await loadGarmentSource(await fetchImageBlob(msg.url), msg.hint || msg.url);
  } catch (error) { showSitesHelp(); console.warn(error); }
}
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || msg.type !== 'tryon-drop' || !pid || msg.pid !== pid || sender.id !== chrome.runtime.id) return;
    handleForwardedDrop(msg);
  });
}
async function refreshSitesUI() {
  const row = $('sitesRow');
  if (typeof chrome === 'undefined' || !chrome.permissions || !chrome.permissions.contains) { row.hidden = true; return; }
  try { sitesGranted = await chrome.permissions.contains({ origins: ['<all_urls>'] }); row.hidden = sitesGranted; } catch (error) { row.hidden = true; }
}
$('allowSitesBtn').addEventListener('click', async () => { // a click is the user gesture Chrome requires for this prompt
  try { if (await chrome.permissions.request({ origins: ['<all_urls>'] })) showToast('Done. You can drag images from any shop site now.'); } catch (error) { showToast('Could not change the permission.'); }
  $('allowSitesBtn').classList.remove('attention'); refreshSitesUI();
});

const videoWrap = document.querySelector('.video-wrap');
['dragenter', 'dragover'].forEach((type) => document.addEventListener(type, (e) => { e.preventDefault(); videoWrap.classList.add('dragging'); }));
['dragleave', 'drop'].forEach((type) => document.addEventListener(type, (e) => { e.preventDefault(); if (type === 'drop' || e.target === document.documentElement || !e.relatedTarget) videoWrap.classList.remove('dragging'); }));
document.addEventListener('drop', (e) => handleDrop(e.dataTransfer));
document.addEventListener('paste', (e) => { const item = Array.from(e.clipboardData?.items || []).find((i) => i.type.startsWith('image/')); if (item) loadGarmentSource(item.getAsFile()); });
$('closeCameraBtn').addEventListener('click', stopCamera);

// ---------- capture / record ----------
function download(url, name) { const link = document.createElement('a'); link.download = name; link.href = url; link.click(); }
$('captureBtn').addEventListener('click', () => {
  if (!stream) return;
  download(drawComposite().toDataURL('image/png'), `tryon-${Date.now()}.png`);
});
recordBtn.addEventListener('click', () => {
  if (!stream) return;
  if (recorder && recorder.state === 'recording') { recorder.stop(); return; }
  drawComposite(); recordedChunks = [];
  recorder = new MediaRecorder(composite.captureStream(30), { mimeType: 'video/webm' });
  recorder.ondataavailable = (e) => { if (e.data.size) recordedChunks.push(e.data); };
  recorder.onstop = () => { clearInterval(recordTimer); download(URL.createObjectURL(new Blob(recordedChunks, { type: 'video/webm' })), `tryon-${Date.now()}.webm`); recordBtn.textContent = '🎬 Record'; showToast('Recording saved.'); };
  recorder.start(); recordTimer = setInterval(drawComposite, 1000 / 30); recordBtn.textContent = '⏹ Stop recording';
});

window.addEventListener('beforeunload', stopCamera); // also ends any billed AI session
window.addEventListener('pagehide', stopCamera); // panel closed: release the camera and end any billed AI session
window.__tryOn = { get running() { return running; }, get live() { return live; }, get garmentApplied() { return garmentApplied; } };

(async function init() {
  apiKey = (await store.get('decartKey')) || '';
  refreshKeyUI(); setGarmentHint(); refreshSitesUI();
  startCamera();
})();
