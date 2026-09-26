let stream = null;
let overlay;
let detector;
let physics;
let running = false;
let processingFrames = 0;
let fpsWindowStart = performance.now();
const video = document.getElementById('userVideo');
const canvas = document.getElementById('overlayCanvas');
const statusBadge = document.getElementById('statusBadge');
const errorMessage = document.getElementById('errorMessage');
const fpsEl = document.getElementById('fpsCounter');
const poseStatus = document.getElementById('poseStatus');

function cameraError(error) {
  const messages = { NotAllowedError: 'Camera permission was denied. Allow camera access for this extension page and try again.', NotFoundError: 'No camera was found. Connect a camera and try again.', NotReadableError: 'The camera is busy or unavailable. Close other camera apps and try again.', SecurityError: 'Camera access is blocked by the browser security policy.' };
  return `${error.name || 'CameraError'}: ${messages[error.name] || error.message || 'Unable to start the camera.'}`;
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
    detector = new PoseDetector();
    await detector.initialize();
    physics = new ClothPhysics(canvas.width, canvas.height);
    requestVideoFrameLoop();
  } catch (error) {
    statusBadge.textContent = 'Camera error';
    errorMessage.textContent = cameraError(error);
    errorMessage.hidden = false;
    console.error(error);
  }
}
function stopCamera() { running = false; if (stream) stream.getTracks().forEach((track) => track.stop()); stream = null; video.srcObject = null; statusBadge.textContent = 'Camera stopped'; }
function updateFps() { processingFrames += 1; const now = performance.now(); if (now - fpsWindowStart >= 1000) { fpsEl.textContent = String(processingFrames); processingFrames = 0; fpsWindowStart = now; } }
async function processFrame() { if (!running) return; const result = detector ? await detector.detect(video) : null; if (result?.landmarks) { poseStatus.textContent = 'Detected'; overlay.setPose(result.landmarks); } else poseStatus.textContent = 'Searching'; physics?.update(); overlay?.render(performance.now()); updateFps(); requestVideoFrameLoop(); }
function requestVideoFrameLoop() { if (!running) return; if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) video.requestVideoFrameCallback(() => processFrame()); else requestAnimationFrame(processFrame); }

document.querySelectorAll('.chip').forEach((button) => button.addEventListener('click', () => { document.querySelectorAll('.chip').forEach((b) => b.classList.remove('active')); button.classList.add('active'); overlay?.setType(button.dataset.garment); }));
document.getElementById('motionRange').addEventListener('input', (e) => { overlay?.setMotion(e.target.value); physics?.setMotion(Number(e.target.value) / 100); });
document.getElementById('windRange').addEventListener('input', (e) => physics?.setWind(Number(e.target.value) / 100));
document.getElementById('brightnessRange').addEventListener('input', (e) => overlay?.setBrightness(e.target.value));
document.getElementById('closeCameraBtn').addEventListener('click', stopCamera);
document.getElementById('captureBtn').addEventListener('click', () => { if (!stream) return; const output = document.createElement('canvas'); output.width = canvas.width; output.height = canvas.height; const ctx = output.getContext('2d'); ctx.drawImage(video, 0, 0, output.width, output.height); ctx.drawImage(canvas, 0, 0); const link = document.createElement('a'); link.download = `tryon-${Date.now()}.png`; link.href = output.toDataURL('image/png'); link.click(); });
document.getElementById('recordBtn').addEventListener('click', () => { statusBadge.textContent = 'Recording not implemented'; });
window.addEventListener('beforeunload', stopCamera);
startCamera();
