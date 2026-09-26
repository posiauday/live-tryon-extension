# Live Virtual Try-On Extension

A prototype Chrome extension that shows a live webcam feed with a draggable virtual garment overlay. This is a strong foundation for a more advanced AI-powered wardrobe try-on product, but it is not a full production-grade garment fitting engine.

## What this prototype includes
- Live webcam access through the extension popup
- Garment style switching (hoodie, shirt, dress, jacket)
- Motion and brightness controls
- Screenshot capture
- Lightweight overlay system for real-time preview

## What this prototype does not include yet
- Real 3D garment cloth simulation
- Bone/pose-based garment fitting
- Accurate body segmentation and garment wrapping
- Product catalog and shopping flows
- Real AI garment generation or model inference
- Full Chrome Web Store compliance and final deployment review

## Architecture overview
- `manifest.json` – extension metadata and permissions
- `popup/popup.html` – extension UI
- `popup/popup.css` – styling
- `popup/popup.js` – camera and overlay behavior
- `content/content.js` – content-script hook for injection pages
- `background/background.js` – service worker lifecycle

## Local setup
1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this repository folder
5. Open the extension popup and allow camera access

## Notes
This project is intentionally scoped as a prototype and a demonstration platform. A production-ready live try-on app needs additional work around:
- 3D garment meshes
- pose estimation and body tracking
- cloth physics
- segmentation / alpha masking
- backend GPU infrastructure
- product and commerce workflows

## License
MIT
