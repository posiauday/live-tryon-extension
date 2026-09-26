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
const video = document.getElementById('userVideo');
const canvas = document.getElementById('overlayCanvas');
const statusBadge = document.getElementById('statusBadge');
const errorMessage = document.getElementById('errorMessage');
const fpsEl = document.getElementById('fpsCounter');
const poseStatus = document.getElementById('poseStatus');
const dropHint = document.getElementById('dropHint');
const toast = document.getElementById('toast');
const fitType = document.getElementById('fitType');
const recordBtn = document.getElementById('recordBtn');

function cameraError(error) {
  const messages = { NotAllowedError: 'Camera permission was denied. Allow camera access for this extension page and try again.', NotFoundError: 'No camera was found. Connect a camera and try again.', NotReadableError: 'The camera is busy or unavailable. Close other camera apps and try again.', SecurityError: 'Camera access is blocked by the browser security policy.' };
  return `${error.name || 'CameraError'}: ${messages[error.name] || error.message || 'Unable to start the camera.'}`;
}

function showToast(text, ms = 3500) {
  toast.textContent = text; toast.hidden = false;
  clearTimeout(showToast.timer); showToast.timer = setTimeout(() => { toast.hidden = true; }, ms);
}

async function loadModels() {
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
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }, audio: false });
    video.srcObject = stream;
    await video.play();
    running = true;
    statusBadge.textContent = '🔴 Live';
    errorMessage.hidden = true;
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    overlay = new GarmentOverlay(canvas, { garmentType: 'hoodie' });
    overlay.setMotion(document.getElementById('motionRange').value);
    overlay.setWind(document.getElementById('windRange').value);
    overlay.setBrightness(document.getElementById('brightnessRange').value);
    requestVideoFrameLoop();
    loadModels();
  } catch (error) {
    statusBadge.textContent = 'Camera error';
    errorMessage.textContent = cameraError(error);
    errorMessage.hidden = false;
    console.error(error);
  }
}

function stopCamera() {
  running = false;
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  if (stream) stream.getTracks().forEach((track) => track.stop());
  stream = null; video.srcObject = null; statusBadge.textContent = 'Camera stopped';
}

function updateFps() {
  processingFrames += 1; const now = performance.now();
  if (now - fpsWindowStart >= 1000) { fpsEl.textContent = String(processingFrames); processingFrames = 0; fpsWindowStart = now; }
}

function drawComposite() {
  if (!composite) { composite = document.createElement('canvas'); }
  if (composite.width !== canvas.width || composite.height !== canvas.height) { composite.width = canvas.width; composite.height = canvas.height; }
  const ctx = composite.getContext('2d');
  ctx.setTransform(-1, 0, 0, 1, composite.width, 0); // match the mirrored on-screen view
  ctx.drawImage(video, 0, 0, composite.width, composite.height);
  ctx.drawImage(canvas, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return composite;
}

async function processFrame() {
  if (!running) return;
  frameCount += 1;
  if (detector && detector.ready) {
    const result = await detector.detect(video);
    if (result.landmarks) { poseStatus.textContent = 'Detected'; overlay.setPose(result.landmarks); }
    else { poseStatus.textContent = 'Searching (show shoulders and hips)'; overlay.setPose(null); }
  }
  if (segmenter && segmenter.ready && frameCount % 3 === 0) segmenter.segment(video);
  overlay.render(performance.now(), { video, skinMask: segmenter && segmenter.hasMask ? segmenter.maskCanvas : null });
  if (recorder && recorder.state === 'recording') drawComposite();
  updateFps();
  requestVideoFrameLoop();
}

function requestVideoFrameLoop() {
  if (!running) return;
  if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) video.requestVideoFrameCallback(() => processFrame());
  else requestAnimationFrame(processFrame);
}

// ---------- garment image input: drag & drop, upload, paste ----------
async function loadGarmentSource(blobOrFile) {
  if (!overlay) { showToast('Start the camera first.'); return; }
  const bitmap = await createImageBitmap(blobOrFile);
  overlay.setGarmentImage(bitmap);
  document.querySelectorAll('.chip').forEach((b) => b.classList.remove('active'));
  showToast('Garment loaded. Stand back so your shoulders and hips are in view.');
}

async function handleDrop(dataTransfer) {
  try {
    const file = Array.from(dataTransfer.files || []).find((f) => f.type.startsWith('image/'));
    if (file) { await loadGarmentSource(file); return; }
    const url = (dataTransfer.getData('text/uri-list') || dataTransfer.getData('text/plain') || '').split('\n')[0].trim();
    if (/^https?:\/\//.test(url) || url.startsWith('data:image/')) {
      const response = await fetch(url); const blob = await response.blob();
      if (!blob.type.startsWith('image/')) throw new Error('not an image');
      await loadGarmentSource(blob); return;
    }
    showToast('Drop an image file (PNG or JPG).');
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
const fileInput = document.getElementById('garmentFile');
document.getElementById('uploadBtn').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { if (fileInput.files[0]) loadGarmentSource(fileInput.files[0]); fileInput.value = ''; });

document.querySelectorAll('.chip').forEach((button) => button.addEventListener('click', () => {
  document.querySelectorAll('.chip').forEach((b) => b.classList.remove('active')); button.classList.add('active');
  fitType.value = button.dataset.garment; overlay?.useSample(button.dataset.garment);
}));
fitType.addEventListener('change', () => overlay?.setType(fitType.value));
document.getElementById('motionRange').addEventListener('input', (e) => overlay?.setMotion(e.target.value));
document.getElementById('windRange').addEventListener('input', (e) => overlay?.setWind(e.target.value));
document.getElementById('brightnessRange').addEventListener('input', (e) => overlay?.setBrightness(e.target.value));
document.getElementById('sizeRange').addEventListener('input', (e) => overlay?.setSize(e.target.value));
document.getElementById('resetFitBtn').addEventListener('click', () => { overlay?.resetAdjust(); document.getElementById('sizeRange').value = 100; });
document.getElementById('closeCameraBtn').addEventListener('click', stopCamera);

function download(url, name) { const link = document.createElement('a'); link.download = name; link.href = url; link.click(); }
document.getElementById('captureBtn').addEventListener('click', () => {
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
window.addEventListener('beforeunload', stopCamera);
window.__tryOn = { get overlay() { return overlay; }, get detector() { return detector; }, get segmenter() { return segmenter; }, get running() { return running; } };
startCamera();
