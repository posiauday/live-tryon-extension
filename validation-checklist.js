/**
 * Validation checklist for the Chrome extension prototype.
 * This file is intentionally plain and simple to reduce runtime risk and make review easier.
 */

const VALIDATION_CHECKLIST = [
  'Open chrome://extensions/',
  'Enable Developer mode',
  'Load unpacked the repository folder',
  'Open the extension popup',
  'Grant camera permission when prompted',
  'Verify the camera stream appears',
  'Verify the garment overlay renders on top of the video stream',
  'Click different garment buttons and confirm overlays change properly',
  'Move the motion slider and confirm garment movement changes',
  'Move the wind slider and confirm the cloth effect reacts',
  'Move the brightness slider and confirm lighting changes',
  'Click capture and confirm the screenshot downloads',
  'Verify no runtime errors appear in the console',
  'Verify the extension stays stable when toggling camera on and off'
];

console.log('Chrome extension validation checklist available.');
console.log(VALIDATION_CHECKLIST);
