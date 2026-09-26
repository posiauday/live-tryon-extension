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

// ---- the real toolbar-click path (background.js -> chrome.scripting -> content/panel.js) ----
// Playwright cannot click the toolbar icon, so we call the service worker's handler directly. A click also grants
// "activeTab"; a temporary copy of the extension with host access to the test page stands in for that grant.
const os = require('os');
function extensionCopyWithHost(hostPattern) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tryon-ext-'));
  for (const d of ['background', 'content', 'camera', 'src']) fs.cpSync(path.join(root, d), path.join(tmp, d), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'vendor', 'decart'), { recursive: true });
  fs.cpSync(path.join(root, 'vendor', 'decart'), path.join(tmp, 'vendor', 'decart'), { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  if (hostPattern) manifest.host_permissions.push(hostPattern);
  fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(manifest));
  return tmp;
}
async function launchWithExtension(dir) {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true, viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  let [worker] = context.serviceWorkers(); if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 30000 });
  // AI mode with no key keeps the local ML models from loading during the test
  await worker.evaluate(() => chrome.storage.local.set({ mode: 'ai' }));
  return { context, worker, id: new URL(worker.url()).host };
}
const clickToolbar = (worker, urlPattern) => worker.evaluate(async (pattern) => { const [tab] = await chrome.tabs.query({ url: pattern }); await togglePanel(tab); return tab.id; }, urlPattern);

test('toolbar click puts the panel ON the page and opens no new window', async () => {
  test.setTimeout(90000);
  const dir = extensionCopyWithHost('http://127.0.0.1/*');
  const { context, worker, id } = await launchWithExtension(dir);
  try {
    const page = await context.newPage();
    await page.goto(`${base}/tests/fixtures/shop.html`);
    const pagesBefore = context.pages().length;
    await clickToolbar(worker, 'http://127.0.0.1/*');
    await expect(page.locator('#__tryon-panel-host')).toHaveCount(1, { timeout: 10000 });
    await expect.poll(() => cameraFrame(page) && cameraFrame(page).url(), { timeout: 15000 }).toContain(`chrome-extension://${id}/camera/camera.html?embed=1`);
    await expect(cameraFrame(page).locator('#uploadBtn')).toBeVisible({ timeout: 20000 });
    expect(context.pages().length).toBe(pagesBefore); // no extra window or tab
    // a second click keeps a single panel
    await clickToolbar(worker, 'http://127.0.0.1/*');
    await expect(page.locator('#__tryon-panel-host')).toHaveCount(1);
  } finally { await context.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('when the panel cannot be injected it says so on the icon and does NOT open a window', async () => {
  test.setTimeout(90000);
  const dir = extensionCopyWithHost(null); // no host access -> executeScript is refused, like a page without an activeTab grant
  const { context, worker } = await launchWithExtension(dir);
  try {
    const page = await context.newPage();
    await page.goto(`${base}/tests/fixtures/shop.html`);
    const pagesBefore = context.pages().length;
    const tabId = await clickToolbar(worker, 'http://127.0.0.1/*');
    await page.waitForTimeout(1500);
    expect(context.pages().length).toBe(pagesBefore);
    await expect(page.locator('#__tryon-panel-host')).toHaveCount(0);
    const badge = await worker.evaluate((tabId) => chrome.action.getBadgeText({ tabId }), tabId);
    const title = await worker.evaluate((tabId) => chrome.action.getTitle({ tabId }), tabId);
    expect(badge).toBe('!'); expect(title).toContain('Could not open the panel');
  } finally { await context.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
