const fs = require('fs');
const path = require('path');

const requiredFiles = [
  'manifest.json', 'background/background.js', 'README.md', 'content/panel.js',
  'camera/camera.html', 'camera/camera.css', 'camera/camera.js',
  'src/decart-live.js', 'vendor/decart/decart-sdk.js', 'validation-checklist.js',
  'camera/free-mode.js', 'src/mediapipe-loader.js', 'src/pose-detector.js', 'src/body-segmentation.js',
  'src/free/mls.js', 'src/free/keyframe-bank.js', 'src/free/garment-layer.js', 'src/free/flow-refine.js', 'src/free/mesh-renderer.js', 'src/free/backend.js', 'src/free/free-pipeline.js',
  'vendor/mediapipe/vision_bundle.mjs', 'vendor/mediapipe/wasm/vision_wasm_internal.wasm', 'vendor/models/pose_landmarker_lite.task', 'vendor/models/selfie_multiclass_256x256.tflite',
  'server/tryon_server.py', 'server/README.md',
];
const missing = requiredFiles.filter((file) => !fs.existsSync(path.join(process.cwd(), file)));
if (missing.length) {
  console.error(`Missing required files:\n${missing.map((x) => `- ${x}`).join('\n')}`);
  process.exit(1);
}

// Chrome refuses to load an unpacked extension whose top-level folder contains a file or directory whose name starts
// with "_" (e.g. a leftover _debug.js): 'Filenames starting with "_" are reserved for use by the system'.
// Only _locales and _metadata are allowed.
const reserved = fs.readdirSync(process.cwd())
  .filter((name) => name.startsWith('_') && !['_locales', '_metadata'].includes(name));
if (reserved.length) {
  console.error(`Chrome will refuse to load this folder. Delete or rename:\n${reserved.map((x) => `- ${x}`).join('\n')}`);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
if (manifest.manifest_version !== 3) throw new Error('Manifest must be MV3');
console.log('Project structure validation passed.');
