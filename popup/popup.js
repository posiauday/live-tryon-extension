const video = document.getElementById('userVideo');
const canvas = document.getElementById('overlayCanvas');
const garmentButtons = document.querySelectorAll('.chip');
const motionRange = document.getElementById('motionRange');
const windRange = document.getElementById('windRange');
const brightnessRange = document.getElementById('brightnessRange');
const statusBadge = document.getElementById('statusBadge');
const toggleCameraBtn = document.getElementById('toggleCameraBtn');
const captureBtn = document.getElementById('captureBtn');
const recordBtn = document.getElementById('recordBtn');
const poseStatusEl = document.getElementById('poseStatus');
const fpsCounterEl = document.getElementById('fpsCounter');

let stream = null;
let isCameraOn = false;
let currentGarment = 'hoodie';
let overlay = null;
let poseDetector = null;
let bodySegmentation = null;
let clothPhysics = null;
let lastFrameTime = Date.now();
let frameCount = 0;
let fps = 0;

async function initializeAdvancedMode() {
  console.log('Initializing advanced pose detection and physics...');
  
  // Initialize pose detector
  poseDetector = new PoseDetector();
  const poseReady = await poseDetector.initialize();
  
  if (poseReady) {
    poseStatusEl.textContent = 'Ready';
    console.log('Pose detection enabled');
  } else {
    poseStatusEl.textContent = 'Disabled';
    console.log('Pose detection unavailable');
  }

  // Initialize body segmentation
  bodySegmentation = new BodySegmentation();
  console.log('Body segmentation enabled');

  // Initialize cloth physics
  clothPhysics = new ClothPhysics(canvas.width, canvas.height);
  console.log('Cloth physics enabled');
}

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
    statusBadge.textContent = '🔴 Live';
    toggleCameraBtn.textContent = 'Stop Camera';
    
    video.onloadedmetadata = () => {
      overlay.syncCanvasSize();
      if (clothPhysics) {
        clothPhysics.width = canvas.width;
        clothPhysics.height = canvas.height;
      }
    };

    await initializeAdvancedMode();
  } catch (error) {
    console.error(error);
    statusBadge.textContent = '❌ Blocked';
    alert('Camera permission is required for the live garment preview.');
  }
}

function stopCamera() {
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
  }
  video.srcObject = null;
  isCameraOn = false;
  statusBadge.textContent = 'Idle';
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

windRange.addEventListener('input', (event) => {
  const windValue = Number(event.target.value) / 100;
  if (clothPhysics) clothPhysics.setWind(windValue * 2 - 1);
  if (overlay) overlay.setMotion(Number(motionRange.value) / 100);
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

  statusBadge.textContent = '✅ Captured';
  setTimeout(() => {
    if (isCameraOn) statusBadge.textContent = '🔴 Live';
  }, 1000);
});

recordBtn.addEventListener('click', () => {
  alert('🎬 Recording prototype enabled.\n\nFull video capture would combine the video stream with the overlay canvas using MediaRecorder.');
});

function updateFPS() {
  frameCount++;
  const now = Date.now();
  if (now - lastFrameTime >= 1000) {
    fps = frameCount;
    fpsCounterEl.textContent = fps;
    frameCount = 0;
    lastFrameTime = now;
  }
}

async function renderFrame(timestamp) {
  if (isCameraOn) {
    // Update cloth physics
    if (clothPhysics) {
      clothPhysics.update();
    }

    // Render garment overlay
    if (overlay) {
      overlay.render(timestamp);
    }
  }

  updateFPS();
  requestAnimationFrame(renderFrame);
}

window.addEventListener('resize', () => {
  if (overlay) overlay.syncCanvasSize();
});

initOverlay();
requestAnimationFrame(renderFrame);
