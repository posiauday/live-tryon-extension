const { test, expect, chromium } = require('@playwright/test');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { computeMeshTargets, solveAffine } = require('../src/garment-overlay.js');

const root = path.join(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.task': 'application/octet-stream', '.tflite': 'application/octet-stream' };

// A plausible front-facing pose in normalised image coordinates (640x360 frame).
const lm = (o = {}) => {
  const a = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }));
  Object.assign(a[11], { x: 0.58, y: 0.40 }); Object.assign(a[12], { x: 0.42, y: 0.40 });
  Object.assign(a[23], { x: 0.55, y: 0.80 }); Object.assign(a[24], { x: 0.45, y: 0.80 });
  return Object.assign(a, o);
};

test.describe('geometry', () => {
  test('solveAffine maps the source triangle exactly onto the destination', () => {
    const m = solveAffine(0, 0, 10, 0, 0, 10, 100, 50, 120, 50, 100, 90);
    const map = (x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
    expect(map(0, 0)).toEqual([100, 50]);
    expect(map(10, 0)).toEqual([120, 50]);
    expect(map(0, 10)).toEqual([100, 90]);
    expect(solveAffine(0, 0, 1, 1, 2, 2, 0, 0, 1, 1, 2, 2)).toBeNull();
  });

  test('mesh follows the shoulders: wider than shoulders, centred, and pinned at the top', () => {
    const w = 640, h = 360; const mesh = computeMeshTargets(lm(), w, h, 'shirt');
    expect(mesh).not.toBeNull();
    const { targets, weights, rows, cols } = mesh;
    const sw = 0.16 * w;
    const rowSpan = (i) => targets[(i * cols + cols - 1) * 2] - targets[(i * cols) * 2];
    let shoulderRow = 0, best = 1e9; // row whose y is closest to the shoulder line (y = 0.40*h)
    for (let i = 0; i < rows; i++) { const d = Math.abs(targets[(i * cols) * 2 + 1] - 0.40 * h); if (d < best) { best = d; shoulderRow = i; } }
    expect(rowSpan(shoulderRow)).toBeGreaterThan(sw * 1.3);
    expect(rowSpan(shoulderRow)).toBeLessThan(sw * 1.8);
    const centre = (targets[(shoulderRow * cols) * 2] + targets[(shoulderRow * cols + cols - 1) * 2]) / 2;
    expect(Math.abs(centre - 0.5 * w)).toBeLessThan(2);
    expect(weights[0]).toBe(0); expect(weights[(rows - 1) * cols]).toBeGreaterThan(0.9);
    // hem sits at the hips for a shirt, well below for a dress
    const hemY = (m) => m.targets[((m.rows - 1) * m.cols) * 2 + 1];
    expect(hemY(mesh)).toBeGreaterThan(0.78 * h);
    expect(hemY(computeMeshTargets(lm(), w, h, 'dress'))).toBeGreaterThan(hemY(mesh) + 0.2 * h);
  });

  test('mesh rotates with tilted shoulders and hides when shoulders are not visible', () => {
    const tilted = lm(); tilted[11].y = 0.46; tilted[12].y = 0.34;
    const m = computeMeshTargets(tilted, 640, 360, 'shirt');
    expect(m.targets[1]).toBeGreaterThan(0); // finite
    let shoulderRow = 3; const left = m.targets[(shoulderRow * m.cols) * 2 + 1], right = m.targets[(shoulderRow * m.cols + m.cols - 1) * 2 + 1];
    expect(Math.abs(left - right)).toBeGreaterThan(10);
    const hidden = lm(); hidden[11].visibility = 0.1;
    expect(computeMeshTargets(hidden, 640, 360, 'shirt')).toBeNull();
    expect(computeMeshTargets(null, 640, 360, 'shirt')).toBeNull();
  });

  test('falls back to an upright torso when the hips are out of frame', () => {
    const noHips = lm(); noHips[23].visibility = 0.05; noHips[24].visibility = 0.05;
    const m = computeMeshTargets(noHips, 640, 360, 'shirt');
    expect(m).not.toBeNull();
    expect(m.hipMid.y).toBeGreaterThan(0.40 * 360);
  });
});

test.describe('in the browser (served over http so MediaPipe can load)', () => {
  let server, base;
  test.beforeAll(async () => {
    server = http.createServer((req, res) => {
      const file = path.join(root, decodeURIComponent(req.url.split('?')[0]));
      if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }); fs.createReadStream(file).pipe(res);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`;
  });
  test.afterAll(() => server.close());

  const launch = () => chromium.launchPersistentContext('', { headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });

  test('pose and segmentation models load locally and run on the camera feed', async () => {
    test.setTimeout(90000);
    const context = await launch(); const page = await context.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/camera/camera.html`);
    await expect(page.locator('#poseStatus')).toHaveText(/Searching|Detected/, { timeout: 60000 });
    await expect.poll(() => page.evaluate(() => !!(window.__tryOn.segmenter && window.__tryOn.segmenter.ready)), { timeout: 60000 }).toBe(true);
    await page.waitForTimeout(1500);
    expect(parseInt(await page.locator('#fpsCounter').textContent())).toBeGreaterThan(0);
    expect(errors).toEqual([]);
    await context.close();
  });

  test('garment is drawn on the torso and follows pose changes', async () => {
    test.setTimeout(120000);
    const context = await launch(); const page = await context.newPage();
    await page.goto(`${base}/camera/camera.html?nomodels`);
    await page.waitForFunction(() => window.__tryOn && window.__tryOn.overlay && window.__tryOn.running);
    const measure = (pose) => page.evaluate(async (pose) => {
      const o = window.__tryOn.overlay; o.setPose(pose);
      for (let i = 0; i < 12; i++) o.render(performance.now() + i * 33, {});
      const c = document.getElementById('overlayCanvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let minX = c.width, maxX = 0, minY = c.height, maxY = 0, n = 0;
      for (let y = 0; y < c.height; y += 2) for (let x = 0; x < c.width; x += 2) if (d[(y * c.width + x) * 4 + 3] > 40) { n++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
      return { n, minX, maxX, minY, maxY, w: c.width, h: c.height };
    }, pose);
    // isolate the overlay from the running loop, which would otherwise overwrite our pose every frame
    await page.evaluate(() => { window.__tryOn.overlay.setPose = window.__tryOn.overlay.setPose.bind(window.__tryOn.overlay); });
    const centred = await measure(lm());
    expect(centred.n).toBeGreaterThan(2000);
    const cx = (centred.minX + centred.maxX) / 2; expect(Math.abs(cx - centred.w * 0.5)).toBeLessThan(centred.w * 0.05);
    expect(centred.maxY).toBeGreaterThan(centred.h * 0.6);
    const moved = lm(); for (const i of [11, 12, 23, 24]) moved[i].x -= 0.2;
    const shifted = await measure(moved);
    expect((shifted.minX + shifted.maxX) / 2).toBeLessThan(cx - centred.w * 0.1);
    await context.close();
  });

  test('a dropped product photo gets its plain background removed and is worn', async () => {
    test.setTimeout(120000);
    const context = await launch(); const page = await context.newPage();
    await page.goto(`${base}/camera/camera.html?nomodels`);
    await page.waitForFunction(() => window.__tryOn && window.__tryOn.overlay);
    const result = await page.evaluate(async () => {
      const c = document.createElement('canvas'); c.width = 300; c.height = 360; const x = c.getContext('2d');
      x.fillStyle = '#ffffff'; x.fillRect(0, 0, 300, 360); x.fillStyle = '#1d4ed8'; x.fillRect(60, 40, 180, 280); // blue "garment" on white
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      const file = new File([blob], 'shirt.png', { type: 'image/png' });
      const dt = new DataTransfer(); dt.items.add(file);
      document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 800));
      const tex = window.__tryOn.overlay.customTexture; if (!tex) return null;
      const d = tex.getContext('2d').getImageData(0, 0, tex.width, tex.height).data;
      return { w: tex.width, h: tex.height, cornerAlpha: d[3], centerAlpha: d[((tex.height >> 1) * tex.width + (tex.width >> 1)) * 4 + 3] };
    });
    expect(result).not.toBeNull();
    expect(result.cornerAlpha).toBeLessThan(200); // background gone (edge px are softened, not opaque)
    expect(result.centerAlpha).toBe(255);
    expect(result.w).toBeLessThan(200); expect(result.h).toBeLessThan(300); // cropped to the garment
    await context.close();
  });
});
