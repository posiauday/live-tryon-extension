const video = document.getElementById('userVideo');
const canvas = document.getElementById('overlayCanvas');
const garmentButtons = document.querySelectorAll('.chip');
const motionRange = document.getElementById('motionRange');
const brightnessRange = document.getElementById('brightnessRange');
const statusBadge = document.getElementById('statusBadge');
const toggleCameraBtn = document.getElementById('toggleCameraBtn');
const captureBtn = document.getElementById('captureBtn');
const recordBtn = document.getElementById('recordBtn');

let stream = null;
let isCameraOn = false;
let currentGarment = 'hoodie';
let overlay = null;

function initOverlay() {
  overlay = new GarmentOverlay(canvas, { garmentType: currentGarment });
  overlay.syncCanvasSize();
}

function updateGarment(type) {
  currentGarment = type;
  if (overlay) overlay.setType(type);
}

async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });

    video.srcObject = stream;
    isCameraOn = true;
    statusBadge.textContent = 'Camera Live';
    toggleCameraBtn.textContent = 'Stop Camera';
    video.onloadedmetadata = () => {
      overlay.syncCanvasSize();
    };
  } catch (error) {
    console.error(error);
    statusBadge.textContent = 'Camera blocked';
    alert('Camera permission is required for the live garment preview.');
  }
}

function stopCamera() {
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
  }
  video.srcObject = null;
  isCameraOn = false;
  statusBadge.textContent = 'Camera Idle';
  toggleCameraBtn.textContent = 'Start Camera';
}

toggleCameraBtn.addEventListener('click', () => {
  if (isCameraOn) stopCamera();
  else startCamera();
});

garmentButtons.forEach((button) => {
  button.addEventListener('click', () => {
    garmentButtons.forEach((btn) => btn.classList.remove('active'));
    button.classList.add('active');
    updateGarment(button.dataset.garment);
  });
});

motionRange.addEventListener('input', (event) => {
  if (overlay) overlay.setMotion(event.target.value);
});

brightnessRange.addEventListener('input', (event) => {
  if (overlay) overlay.setBrightness(event.target.value);
});

captureBtn.addEventListener('click', () => {
  if (!isCameraOn) {
    alert('Start the camera before capturing.');
    return;
  }

  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = canvas.width;
  tempCanvas.height = canvas.height;
  const ctx = tempCanvas.getContext('2d');
  ctx.drawImage(video, 0, 0, tempCanvas.width, tempCanvas.height);
  ctx.drawImage(canvas, 0, 0, tempCanvas.width, tempCanvas.height);

  const link = document.createElement('a');
  link.href = tempCanvas.toDataURL('image/png');
  link.download = `tryon-${Date.now()}.png`;
  link.click();

  statusBadge.textContent = 'Captured';
  setTimeout(() => {
    if (isCameraOn) statusBadge.textContent = 'Camera Live';
  }, 1000);
});

recordBtn.addEventListener('click', () => {
  alert('Prototype recording hook enabled. Real capture would require MediaRecorder on a combined video+canvas stream.');
});

function renderFrame(timestamp) {
  if (overlay) overlay.render(timestamp);
  requestAnimationFrame(renderFrame);
}

window.addEventListener('resize', () => {
  if (overlay) overlay.syncCanvasSize();
});

initOverlay();
requestAnimationFrame(renderFrame);
