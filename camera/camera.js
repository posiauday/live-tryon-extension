let stream = null;
let overlay;
let detector;
let segmenter;
let running = false;
let processingFrames = 0;
let frameCount = 0;
let fpsWindowStart = performance.now();
let recorder = null;
let recordedChunks = [];
let composite = null;
let mode = 'local';
let apiKey = '';
let live = null;
let currentGarment = null; // { blob } last garment chosen, so it can be (re)applied to the AI session
let modelsRequested = false;
const $ = (id) => document.getElementById(id);
const video = $('userVideo');
const aiVideo = $('aiVideo');
const canvas = $('overlayCanvas');
const statusBadge = $('statusBadge');
const errorMessage = $('errorMessage');
const fpsEl = $('fpsCounter');
const poseStatus = $('poseStatus');
const toast = $('toast');
const fitType = $('fitType');
const recordBtn = $('recordBtn');
const aiBadge = $('aiBadge');
const aiState = $('aiState');
const aiMeter = $('aiMeter');
const aiStartBtn = $('aiStartBtn');

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

// ---------- local (MediaPipe) mode ----------
async function loadModels() {
  if (modelsRequested) return; modelsRequested = true;
  if (new URLSearchParams(location.search).has('nomodels')) { poseStatus.textContent = 'Models off (debug)'; return; }
  if (!window.MediaPipeLoader || !MediaPipeLoader.available()) { poseStatus.textContent = 'Unavailable (open from the extension)'; return; }
  poseStatus.textContent = 'Loading model...';
  detector = new PoseDetector();
  try { await detector.initialize(); poseStatus.textContent = 'Searching'; }
  catch (error) { console.warn('Pose model failed', error); detector = null; poseStatus.textContent = `Unavailable (${error.message || 'model failed'})`; return; }
  segmenter = new BodySegmentation();
  segmenter.initialize().catch((error) => { console.warn('Segmentation model failed', error); segmenter = null; });
}

async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, facingMode: 'user' }, audio: false });
    video.srcObject = stream;
    await video.play();
    running = true;
    statusBadge.textContent = '🔴 Live';
    errorMessage.hidden = true;
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    overlay = new GarmentOverlay(canvas, { garmentType: 'hoodie' });
    overlay.setMotion($('motionRange').value);
    overlay.setWind($('windRange').value);
    overlay.setBrightness($('brightnessRange').value);
    requestVideoFrameLoop();
    if (mode === 'local') loadModels();
  } catch (error) {
    statusBadge.textContent = 'Camera error';
    errorMessage.textContent = cameraError(error);
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

function updateFps() {
  processingFrames += 1; const now = performance.now();
  if (now - fpsWindowStart >= 1000) { fpsEl.textContent = String(processingFrames); processingFrames = 0; fpsWindowStart = now; }
}

function aiOnScreen() { return !aiVideo.hidden && aiVideo.videoWidth > 0; }

function drawComposite() {
  const ai = aiOnScreen();
  const w = ai ? aiVideo.videoWidth : canvas.width, h = ai ? aiVideo.videoHeight : canvas.height;
  if (!composite) composite = document.createElement('canvas');
  if (composite.width !== w || composite.height !== h) { composite.width = w; composite.height = h; }
  const ctx = composite.getContext('2d');
  if (ai) { ctx.drawImage(aiVideo, 0, 0, w, h); return composite; } // the AI stream is already mirrored
  ctx.setTransform(-1, 0, 0, 1, w, 0); // match the mirrored on-screen view
  ctx.drawImage(video, 0, 0, w, h);
  ctx.drawImage(canvas, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return composite;
}

async function processFrame() {
  if (!running) return;
  frameCount += 1;
  if (mode === 'local') {
    if (detector && detector.ready) {
      const result = await detector.detect(video);
      if (result.landmarks) { poseStatus.textContent = 'Detected'; overlay.setPose(result.landmarks); }
      else { poseStatus.textContent = 'Searching (show shoulders and hips)'; overlay.setPose(null); }
    }
    if (segmenter && segmenter.ready && frameCount % 3 === 0) segmenter.segment(video);
    overlay.render(performance.now(), { video, skinMask: segmenter && segmenter.hasMask ? segmenter.maskCanvas : null });
  }
  if (recorder && recorder.state === 'recording') drawComposite();
  updateFps();
  requestVideoFrameLoop();
}

function requestVideoFrameLoop() {
  if (!running) return;
  if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) video.requestVideoFrameCallback(() => processFrame());
  else requestAnimationFrame(processFrame);
}

// ---------- AI Live mode (Decart Lucy V-TON) ----------
const STATE_LABELS = { connecting: 'Connecting...', connected: 'Connected', generating: 'Live', reconnecting: 'Reconnecting...', disconnected: 'Not connected' };

function setAiState(text, tone) {
  aiState.textContent = text; aiState.dataset.tone = tone || '';
  aiBadge.hidden = !text || text === STATE_LABELS.disconnected;
  aiBadge.textContent = `AI · ${text}`;
}

function formatMeter(seconds, cost) { return `${Math.round(seconds)}s · $${cost.toFixed(2)}`; }

function ensureLive() {
  if (live) return live;
  live = new DecartLive({
    onRemoteStream: (remote) => { aiVideo.srcObject = remote; aiVideo.hidden = false; aiVideo.play().catch(() => {}); },
    onState: (state) => {
      setAiState(STATE_LABELS[state] || state, state === 'generating' ? 'ok' : state === 'reconnecting' ? 'warn' : '');
      aiStartBtn.textContent = state === 'disconnected' ? 'Start AI try-on' : 'Stop AI try-on';
      if (state === 'disconnected') { aiVideo.hidden = true; aiVideo.srcObject = null; }
    },
    onQueue: (q) => setAiState(`In queue · #${q.position} of ${q.queueSize}`, 'warn'),
    onTick: (seconds, cost) => { aiMeter.textContent = formatMeter(seconds, cost); },
    onEnded: (reason) => showToast(`AI session ended: ${reason}`),
    onError: (error) => { console.warn('Decart error', error); showToast(`AI error: ${error.message || error}`); }
  });
  return live;
}

async function startAi() {
  if (!apiKey) { showToast('Add your Decart API key first.'); return false; }
  if (!stream) { showToast('Start the camera first.'); return false; }
  const session = ensureLive();
  if (session.active) return true;
  setAiState('Connecting...');
  try {
    await session.connect({ apiKey, stream, limitSeconds: Number($('limitSelect').value) });
    aiStartBtn.textContent = 'Stop AI try-on';
    if (currentGarment) await applyGarmentToAi();
    return true;
  } catch (error) {
    console.error(error);
    setAiState('Error', 'bad'); aiStartBtn.textContent = 'Start AI try-on';
    showToast(`Could not start AI: ${error.message || error}`);
    return false;
  }
}

function stopAi() {
  if (live && (live.active || live.connected)) live.disconnect();
  aiVideo.hidden = true; aiVideo.srcObject = null; aiStartBtn.textContent = 'Start AI try-on';
}

async function applyGarmentToAi() {
  if (!live || !live.connected || !currentGarment) return;
  try { await live.setGarment(currentGarment.blob, fitType.value, $('garmentDesc').value); showToast('Garment sent. It appears on you within a couple of seconds.'); }
  catch (error) { showToast(`Could not set garment: ${error.message || error}`); }
}

aiStartBtn.addEventListener('click', () => { const session = ensureLive(); if (session.active || session.connected) stopAi(); else startAi(); });
[fitType, $('garmentDesc')].forEach((el) => el.addEventListener('change', () => { if (mode === 'ai') applyGarmentToAi(); }));

function refreshKeyUI() {
  $('keyForm').hidden = !!apiKey; $('sessionControls').hidden = !apiKey;
}
$('saveKeyBtn').addEventListener('click', async () => {
  const value = $('apiKeyInput').value.trim();
  if (!value) { showToast('Paste your Decart API key.'); return; }
  apiKey = value; await store.set('decartKey', value); $('apiKeyInput').value = ''; refreshKeyUI(); showToast('Key saved in this browser.');
});
$('changeKeyBtn').addEventListener('click', async () => { stopAi(); apiKey = ''; await store.set('decartKey', ''); refreshKeyUI(); });

function setMode(next) {
  mode = next; document.body.dataset.mode = next;
  document.querySelectorAll('#modeSwitch button').forEach((b) => b.classList.toggle('active', b.dataset.mode === next));
  $('tipText').textContent = next === 'ai'
    ? 'Drag a garment from any shop page (or a file) onto the camera. AI Live needs no standing back and follows you as you move. It is billed per second while connected.'
    : 'Stand 1.5–2 m from the camera so your shoulders and hips are in view. Best input: a front-facing photo of a top on a plain background.';
  if (next === 'local') { stopAi(); if (running) loadModels(); }
  store.set('mode', next);
}
document.querySelectorAll('#modeSwitch button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

// ---------- garment image input: drag & drop, upload, paste ----------
async function bitmapToBlob(bitmap, maxSide = 1024) {
  const s = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const c = document.createElement('canvas'); c.width = Math.round(bitmap.width * s); c.height = Math.round(bitmap.height * s);
  c.getContext('2d').drawImage(bitmap, 0, 0, c.width, c.height);
  return new Promise((resolve) => c.toBlob(resolve, 'image/png'));
}

async function loadGarmentSource(blobOrFile) {
  if (mode === 'ai') {
    const bitmap = await createImageBitmap(blobOrFile);
    currentGarment = { blob: await bitmapToBlob(bitmap) };
    if (!live || !(live.active || live.connected)) { const ok = await startAi(); if (!ok) return; }
    else await applyGarmentToAi();
    return;
  }
  if (!overlay) { showToast('Start the camera first.'); return; }
  const bitmap = await createImageBitmap(blobOrFile);
  overlay.setGarmentImage(bitmap);
  document.querySelectorAll('.chip').forEach((b) => b.classList.remove('active'));
  showToast('Garment loaded. Stand back so your shoulders and hips are in view.');
}

// The image URL of something dragged out of a web page (prefers the <img> over a surrounding link).
function droppedImageUrl(dataTransfer) {
  const html = dataTransfer.getData('text/html');
  const match = html && html.match(/<img[^>]+src=["']([^"']+)["']/i);
  let url = match ? match[1] : (dataTransfer.getData('text/uri-list') || dataTransfer.getData('text/plain') || '').split('\n')[0].trim();
  if (url.startsWith('//')) url = `https:${url}`;
  return /^(https?:\/\/|data:image\/)/.test(url) ? url : '';
}

async function fetchImageBlob(url) {
  const attempt = async () => { const response = await fetch(url); if (!response.ok) throw new Error(`HTTP ${response.status}`); const blob = await response.blob(); if (!blob.type.startsWith('image/')) throw new Error('not an image'); return blob; };
  try { return await attempt(); } catch (error) {
    // Cross-origin: ask once for access to that site (optional host permission), then retry.
    if (url.startsWith('http') && typeof chrome !== 'undefined' && chrome.permissions) {
      const granted = await chrome.permissions.request({ origins: [`${new URL(url).origin}/*`] });
      if (granted) return attempt();
    }
    throw error;
  }
}

async function handleDrop(dataTransfer) {
  try {
    const file = Array.from(dataTransfer.files || []).find((f) => f.type.startsWith('image/'));
    if (file) { await loadGarmentSource(file); return; }
    const url = droppedImageUrl(dataTransfer);
    if (!url) { showToast('Drop an image (PNG or JPG).'); return; }
    await loadGarmentSource(await fetchImageBlob(url));
  } catch (error) {
    showToast('Could not read that image. Save it to your computer and drop the file, or use Upload.');
    console.warn(error);
  }
}

const videoWrap = document.querySelector('.video-wrap');
['dragenter', 'dragover'].forEach((type) => document.addEventListener(type, (e) => { e.preventDefault(); videoWrap.classList.add('dragging'); }));
['dragleave', 'drop'].forEach((type) => document.addEventListener(type, (e) => { e.preventDefault(); if (type === 'drop' || e.target === document.documentElement || !e.relatedTarget) videoWrap.classList.remove('dragging'); }));
document.addEventListener('drop', (e) => handleDrop(e.dataTransfer));
document.addEventListener('paste', (e) => { const item = Array.from(e.clipboardData?.items || []).find((i) => i.type.startsWith('image/')); if (item) loadGarmentSource(item.getAsFile()); });
const fileInput = $('garmentFile');
$('uploadBtn').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { if (fileInput.files[0]) loadGarmentSource(fileInput.files[0]); fileInput.value = ''; });

document.querySelectorAll('.chip').forEach((button) => button.addEventListener('click', () => {
  document.querySelectorAll('.chip').forEach((b) => b.classList.remove('active')); button.classList.add('active');
  fitType.value = button.dataset.garment; overlay?.useSample(button.dataset.garment);
}));
fitType.addEventListener('change', () => overlay?.setType(fitType.value));
$('motionRange').addEventListener('input', (e) => overlay?.setMotion(e.target.value));
$('windRange').addEventListener('input', (e) => overlay?.setWind(e.target.value));
$('brightnessRange').addEventListener('input', (e) => overlay?.setBrightness(e.target.value));
$('sizeRange').addEventListener('input', (e) => overlay?.setSize(e.target.value));
$('resetFitBtn').addEventListener('click', () => { overlay?.resetAdjust(); $('sizeRange').value = 100; });
$('closeCameraBtn').addEventListener('click', stopCamera);

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
  recorder.onstop = () => { download(URL.createObjectURL(new Blob(recordedChunks, { type: 'video/webm' })), `tryon-${Date.now()}.webm`); recordBtn.textContent = '🎬 Record'; showToast('Recording saved.'); };
  recorder.start(); recordBtn.textContent = '⏹ Stop recording';
});

// sample thumbnails on the garment chips
document.querySelectorAll('.chip[data-garment]').forEach((chip) => {
  try { const img = new Image(); img.alt = ''; img.src = makeSampleGarment(chip.dataset.garment).toDataURL(); chip.prepend(img); } catch (error) { /* thumbnails are optional */ }
});
poseStatus.addEventListener('mouseover', () => { poseStatus.title = poseStatus.textContent; });
window.addEventListener('beforeunload', stopCamera); // also ends any billed AI session
window.__tryOn = { get overlay() { return overlay; }, get detector() { return detector; }, get segmenter() { return segmenter; }, get running() { return running; }, get mode() { return mode; }, get live() { return live; }, setMode };

(async function init() {
  apiKey = (await store.get('decartKey')) || '';
  const saved = await store.get('mode');
  refreshKeyUI();
  setMode(saved === 'ai' || saved === 'local' ? saved : (apiKey ? 'ai' : 'local'));
  startCamera();
})();
