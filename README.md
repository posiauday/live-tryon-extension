# Live Virtual Try-On (Chrome extension)

Drag a garment from any shop page onto your live camera and see it on you, moving with you. It uses Decart's
**Lucy V-TON** real-time video model, the same model behind the Anywear extension: your camera streams to Decart over
WebRTC and the edited video comes back with the garment worn and the fabric moving. No standing back, no fitting maths.

## Two modes (a switch at the top of the panel)
* **Live AI (Decart, paid)**: the realistic live video described below. Unchanged.
* **Free (on your PC)**: no billing, no upload. Your own GPU makes **one AI photo of you in the garment** (a "keyframe"),
  then the extension tracks your pose in the browser and bends the garment onto you live (about 20-30 FPS). When you move to a
  pose it has not seen (arms up, turned), it makes another keyframe in the background and blends between them. It is a good
  "sticker on a photo" effect, not Decart-level realism. It needs the small local server in `server/`: see
  [server/README.md](server/README.md), and the design in [docs/ROADMAP-free-tryon.md](docs/ROADMAP-free-tryon.md).

## Using it
1. Get a Decart API key at https://platform.decart.ai (new accounts get a little free credit).
2. Load the extension: `chrome://extensions` -> Developer mode -> **Load unpacked** -> select this folder.
3. On any shop page click the toolbar icon (or press **Alt+Shift+T**). A floating try-on panel appears **on the page**:
   drag it by the title bar, minimize it (the title bar keeps showing status and cost), make it bigger, or close it.
4. Paste your key once (**AI session** card -> Save; it is stored only in this browser) and allow the camera.
5. Drag a product image from the page onto the panel (or paste one with Ctrl+V). While you drag, a "Drop here to wear it" area covers the panel. The AI session starts when you drop, you get one minute, and the try-on replaces the camera in the same screen. Drop another image to switch garments. There is no upload form or type picker: what it is (top, pants, dress) is guessed from the image's alt text and file name.

Chrome does not let extensions run on `chrome://` pages or the Web Store. There the icon shows a red **!**; its tooltip
explains why. The extension never opens a window on its own.

Most shop images are read directly from the page. If a shop's image server blocks that, the AI session card shows an
**Allow dragging from all sites** button (one click, one Chrome prompt); then drop again.

Why the drop is caught on the page: Chrome does not deliver drag events from a page into an extension's iframe, so
`content/panel.js` catches the drop on the page and forwards it to the panel with authenticated extension messaging.

## Cost and safety
**One minute per garment.** Decart bills about **$0.02 per second** while connected, so each garment costs at most
about **$1.20**. Nothing is billed until you drop a garment. The session starts at the drop and a countdown shows the
time left. When the minute is up the session ends, the garment is **deleted** and everything resets to the plain camera;
drop another image to start a new minute. Dropping a different garment mid-way ends the current one and starts a fresh
minute. The minute is enforced twice: by a short-lived, model-limited client token (Decart ends the session) and by a
client-side timer. **Remove garment**, **Stop** and closing the panel disconnect immediately. Your permanent key is only
used to mint that token.

Check a key without billing (creating a token does not start a session):
```
DECART_API_KEY=dct_... npm run check:decart
```
PowerShell: `$env:DECART_API_KEY="dct_..."; npm run check:decart`

## Development
- `npm install`, then `npx playwright install chromium`
- `npm run build:decart` re-bundles `@decartai/sdk` into `vendor/decart/decart-sdk.js` (Manifest V3 forbids remote code)
- `node validate-project.js` and `npx playwright test` (AI flow is tested against a mock SDK, so tests cost nothing)
- Layout: `background/` (toolbar click -> inject panel), `content/panel.js` (floating panel), `camera/` (the try-on UI, shown
  inside the panel iframe), `src/decart-live.js` (session, token, garment prompt), `vendor/decart/` (bundled SDK)

## Limits
- Needs a Decart account and internet; quality and latency depend on Decart's service and queue.
- Best results with a clear front-facing product photo of a top, jacket or dress.
- Some sites with very strict security settings may block the embedded panel.

## License
MIT
