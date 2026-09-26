// The on-page floating panel: injected into a "shop" page, draggable, minimizable, closable, and it accepts
// a garment dragged straight out of the page.
const { test, expect, chromium } = require('@playwright/test');
const http = require('http');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm' };
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

const launch = () => chromium.launchPersistentContext('', { headless: true, viewport: { width: 1280, height: 900 }, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });

// content scripts get chrome.runtime.getURL; stub it so panel.js can run on a plain page in tests
async function injectPanel(page, cameraUrl) {
  await page.evaluate((url) => { window.chrome = { runtime: { getURL: () => url, sendMessage: () => {} } }; }, cameraUrl);
  await page.addScriptTag({ path: path.join(root, 'content/panel.js') });
}
const panelBox = (page) => page.evaluate(() => { const r = document.getElementById('__tryon-panel-host').shadowRoot.querySelector('.panel').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
const cameraFrame = (page) => page.frames().find((f) => f.url().includes('camera/camera.html'));

test('panel shows on the page, drags, minimizes, resizes and closes', async () => {
  const context = await launch(); const page = await context.newPage();
  await page.goto(`${base}/tests/fixtures/shop.html`);
  await injectPanel(page, `${base}/camera/camera.html?nomodels=1`);
  await expect(page.locator('#__tryon-panel-host')).toHaveCount(1);
  await expect.poll(() => cameraFrame(page) && cameraFrame(page).url(), { timeout: 10000 }).toContain('embed=1');
  const frame = cameraFrame(page);
  await expect(frame.locator('#userVideo')).toBeVisible();
  await expect(frame.locator('html')).toHaveClass(/embed/);
  await expect(frame.locator('#statusBadge')).toContainText('Live', { timeout: 15000 });

  const start = await panelBox(page);
  expect(start.w).toBe(440); expect(start.x + start.w).toBeLessThanOrEqual(1280);

  // drag by the title bar
  await page.mouse.move(start.x + 120, start.y + 20); await page.mouse.down(); await page.mouse.move(start.x - 200, start.y + 120, { steps: 6 }); await page.mouse.up();
  const moved = await panelBox(page);
  expect(moved.x).toBeLessThan(start.x - 150); expect(moved.y).toBeGreaterThan(start.y + 80);

  // minimize -> only the title bar remains; restore
  await page.locator('#__tryon-panel-host button[data-act="min"]').click();
  expect((await panelBox(page)).h).toBe(40);
  await page.locator('#__tryon-panel-host button[data-act="min"]').click();
  expect((await panelBox(page)).h).toBeGreaterThan(400);

  // bigger / smaller
  await page.locator('#__tryon-panel-host button[data-act="size"]').click();
  expect((await panelBox(page)).w).toBe(760);

  // status from the iframe shows in the title bar (visible while minimized)
  await frame.evaluate(() => postStatus('AI · Live · 12s · $0.24'));
  await expect(page.locator('#__tryon-panel-host #status')).toHaveText('AI · Live · 12s · $0.24');

  // close removes it
  await page.locator('#__tryon-panel-host button[data-act="close"]').click();
  await expect(page.locator('#__tryon-panel-host')).toHaveCount(0);
  await context.close();
});

test('a garment dragged out of the page and dropped on the panel is worn', async () => {
  const context = await launch(); const page = await context.newPage();
  await page.goto(`${base}/tests/fixtures/shop.html`);
  await injectPanel(page, `${base}/camera/camera.html?nomodels=1`);
  await expect.poll(() => cameraFrame(page) && cameraFrame(page).url(), { timeout: 10000 }).toContain('embed=1');
  const frame = cameraFrame(page);
  await expect(frame.locator('#statusBadge')).toContainText('Live', { timeout: 15000 });
  // a real mouse drag of the <img> from the shop page into the panel's iframe
  const from = await page.locator('#product').boundingBox(); const to = await frame.locator('.video-wrap').boundingBox();
  await page.mouse.move(from.x + 60, from.y + 60); await page.mouse.down(); await page.mouse.move(from.x + 80, from.y + 80, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 }); await page.mouse.up();
  await expect.poll(() => frame.evaluate(() => !!(window.__tryOn.overlay && window.__tryOn.overlay.customTexture)), { timeout: 10000 }).toBe(true);
  const tex = await frame.evaluate(() => { const t = window.__tryOn.overlay.customTexture; const d = t.getContext('2d').getImageData(0, 0, 1, 1).data; return { w: t.width, h: t.height, cornerAlpha: d[3] }; });
  expect(tex.cornerAlpha).toBeLessThan(200); expect(tex.w).toBeLessThan(200); // white product background removed, cropped
  await context.close();
});

test('installed extension: panel can be embedded in a normal web page (web_accessible_resources)', async () => {
  test.setTimeout(90000);
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true, viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  try {
    let [worker] = context.serviceWorkers(); if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 30000 });
    const id = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.goto(`${base}/tests/fixtures/shop.html`);
    await injectPanel(page, `chrome-extension://${id}/camera/camera.html?nomodels=1`);
    await expect.poll(() => cameraFrame(page) && cameraFrame(page).url(), { timeout: 15000 }).toContain(`chrome-extension://${id}/camera/camera.html`);
    const frame = cameraFrame(page);
    await expect(frame.locator('#statusBadge')).toContainText('Live', { timeout: 30000 }); // camera + all scripts run inside the page
    await expect(frame.locator('#uploadBtn')).toBeVisible();
  } finally { await context.close(); }
});
