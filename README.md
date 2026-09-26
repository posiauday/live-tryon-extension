# Live Virtual Try-On Extension

A prototype Chrome extension focused on a live webcam virtual try-on experience, with interactive garment overlay, motion physics, and camera-based experimentation.

## Project status
This project is a functional prototype and demo foundation for a future AI-powered virtual try-on product. It is not a final production-grade solution.

## Using it
Click the toolbar icon (or press Alt+Shift+T) on any shop page. A floating try-on panel appears **on the page**: drag it by its title bar, minimize it (the title bar keeps showing AI status and cost), make it bigger, or close it. Drag a product image from the page straight into the panel to wear it. On pages where extensions cannot inject (chrome://, the Web Store) it opens as a standalone window instead.

Dragging from a shop needs no extra permission when Chrome hands over the image file; otherwise the panel asks once for access to that image's site.

## Two modes
**AI Live (realistic)** uses Decart's Lucy V-TON realtime video model, the same model behind the Anywear extension. Your camera streams to Decart over WebRTC and the edited video comes back with the garment worn and moving with you. No standing back, no fitting maths, real drape and shading.
1. Create a key at https://platform.decart.ai
2. In the extension window choose **AI Live**, paste the key (stored only in this browser) and press **Save**.
3. Drop a garment image (file, or drag straight from a shop page) onto the camera. It connects and dresses you.

To check a key before using it: `DECART_API_KEY=dct_... npm run check:decart` (PowerShell: `$env:DECART_API_KEY="dct_..."; npm run check:decart`). It only creates a token, which does not bill.

Cost: Decart bills about $0.02 per second while connected. Each session is capped (default 2 min) through a short-lived client token and a client-side timer, and Stop or closing the window disconnects immediately.

**Local preview (free)** is the on-device MediaPipe mesh warp described below. It is approximate, but free and offline.

## What it does (local preview)
- Full-tab camera page (fixes the extension-popup camera permission problem)
- **Drag & drop / upload / paste a clothing image** and wear it live
- Real pose tracking (MediaPipe Pose Landmarker, bundled locally) with One Euro smoothing
- Garment is warped onto your torso with a textured triangle mesh anchored to shoulders and hips
- Simple cloth motion (spring/verlet) with Motion and Wind sliders
- Occlusion: your head, hair and arms/hands (MediaPipe multiclass segmenter) are drawn over the garment
- Automatic plain-background removal for product photos, brightness matching, capture (PNG) and recording (WebM)

## Tips
- Stand 1.5-2 m back so shoulders and hips are visible.
- Best input: a front-facing photo of a top/dress on a plain or transparent background. Use "Fit as" to pick the garment shape.
- Debug: open camera/camera.html?nomodels to skip loading the ML models.

## Limitations
- It is a 2D garment warp, not a 3D or AI-generated try-on; side views and heavy arm movement look approximate
- Your own sleeves stay visible if they are wider than the garment
- Background removal only handles plain backgrounds (flood fill); use PNGs with transparency otherwise

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
