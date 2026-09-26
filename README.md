# Live Virtual Try-On Extension

A prototype Chrome extension focused on a live webcam virtual try-on experience, with interactive garment overlay, motion physics, and camera-based experimentation.

## Project status
This project is a functional prototype and demo foundation for a future AI-powered virtual try-on product. It is not a final production-grade solution.

## Features currently included
- Webcam access from a Chrome extension popup
- Selectable garment overlays (hoodie, shirt, dress, jacket)
- Motion and brightness controls
- Wind simulation control
- Drag and reposition interaction on the garment overlay
- Screenshot capture
- Pose detection, segmentation, and cloth simulation hooks

## Important limitations
- This is not a full commercial-grade virtual try-on engine yet
- It does not use a production-trained garment fitting model
- The body segmentation and cloth simulation are simplified prototype logic
- It does not yet include real 3D garment assets or a full AI backend
- It is not yet Chrome Web Store ready without compliance and packaging review

## Tech stack
- Chrome Extension Manifest V3
- JavaScript
- HTML/CSS
- MediaPipe pose detection (prototype integration)
- Custom body segmentation and cloth simulation prototypes

## Local setup
1. Open Chrome and go to `chrome://extensions/`
2. Enable Developer mode
3. Click **Load unpacked**
4. Select this repository folder
5. Open the extension popup and allow camera access

## Future roadmap
1. Replace the simplified cloth logic with a production-level 3D garment simulation
2. Add real body segmentation / mask tracking
3. Integrate a real AI garment fitting backend
4. Add product catalog, shopping flow, and metrics
5. Package and prepare for Chrome Web Store submission

## License
MIT
