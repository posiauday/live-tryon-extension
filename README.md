# Live Virtual Try-On (Chrome extension)

Drag a garment from any shop page onto your live camera and see it on you, moving with you. It uses Decart's
**Lucy V-TON** real-time video model, the same model behind the Anywear extension: your camera streams to Decart over
WebRTC and the edited video comes back with the garment worn and the fabric moving. No standing back, no fitting maths.

## Using it
1. Get a Decart API key at https://platform.decart.ai (new accounts get a little free credit).
2. Load the extension: `chrome://extensions` -> Developer mode -> **Load unpacked** -> select this folder.
3. On any shop page click the toolbar icon (or press **Alt+Shift+T**). A floating try-on panel appears **on the page**:
   drag it by the title bar, minimize it (the title bar keeps showing status and cost), make it bigger, or close it.
4. Paste your key once (**AI session** card -> Save; it is stored only in this browser) and allow the camera.
5. Drag a product image from the page onto the panel (or paste one with Ctrl+V). While you drag, a "Drop here to wear it" area covers the panel. The AI session starts when you drop, and the try-on replaces the camera in the same screen. Drop another image to switch garments. There is no upload form or type picker: what it is (top, pants, dress) is guessed from the image's alt text and file name.

Chrome does not let extensions run on `chrome://` pages or the Web Store. There the icon shows a red **!**; its tooltip
explains why. The extension never opens a window on its own.

Dragging from a shop needs no extra permission when Chrome hands over the image file; otherwise the panel asks once for
access to that image's site.

## Cost and safety
Decart bills about **$0.02 per second** while connected (about $1.20 a minute). Nothing is billed until you drop a
garment. Each session is capped (default 2 minutes) by a short-lived, model-limited client token *and* a client-side
timer; **End session**, **Stop** and closing the panel disconnect immediately. Your permanent key is only used to mint
that token.

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
