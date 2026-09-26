const fs = require('fs');
const path = require('path');

const requiredFiles = [
  'manifest.json',
  'README.md',
  'popup/popup.html',
  'popup/popup.css',
  'popup/popup.js',
  'src/garment-overlay.js',
  'src/pose-detector.js',
  'src/body-segmentation.js',
  'src/cloth-physics.js',
  'validation-checklist.js'
];

function validateProject() {
  const missing = requiredFiles.filter((file) => !fs.existsSync(path.join(process.cwd(), file)));

  if (missing.length > 0) {
    console.error('Missing required files:');
    missing.forEach((file) => console.error(`- ${file}`));
    process.exit(1);
  }

  console.log('Project structure validation passed.');
  console.log('Files found:');
  requiredFiles.forEach((file) => console.log(`- ${file}`));
}

validateProject();
