// The on-page floating panel: injected into a "shop" page, draggable, minimizable, closable, and it accepts
// a garment dragged straight out of the page.
const { test, expect, chromium } = require('@playwright/test');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { installFakeSdk } = require('./helpers/fake-decart.js');

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
  await injectPanel(page, `${base}/camera/camera.html`);
  await expect(page.locator('#__tryon-panel-host')).toHaveCount(1);
  await expect.poll(() => cameraFrame(page) && cameraFrame(page).url(), { timeout: 10000 }).toContain('embed=1');
  const frame = cameraFrame(page);
  await expect(frame.locator('#userVideo')).toBeVisible();
  await expect(frame.locator('html')).toHaveClass(/embed/);
  await expect(frame.locator('#statusBadge')).toContainText('Live', { timeout: 15000 });

  const start = await panelBox(page);
  expect(start.w).toBe(620); expect(start.x + start.w).toBeLessThanOrEqual(1280);

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
  expect((await panelBox(page)).w).toBe(960);

  // status from the iframe shows in the title bar (visible while minimized)
  await frame.evaluate(() => postStatus('AI · Live · 12s · $0.24'));
  await expect(page.locator('#__tryon-panel-host #status')).toHaveText('AI · Live · 12s · $0.24');

  // close removes it
  await page.locator('#__tryon-panel-host button[data-act="close"]').click();
  await expect(page.locator('#__tryon-panel-host')).toHaveCount(0);
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
    await injectPanel(page, `chrome-extension://${id}/camera/camera.html`);
    await expect.poll(() => cameraFrame(page) && cameraFrame(page).url(), { timeout: 15000 }).toContain(`chrome-extension://${id}/camera/camera.html`);
    const frame = cameraFrame(page);
    await expect(frame.locator('#statusBadge')).toContainText('Live', { timeout: 30000 }); // camera + all scripts run inside the page
    await expect(frame.locator('#dropHint')).toBeVisible();
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
  manifest.host_permissions = manifest.host_permissions.filter((h) => h !== '<all_urls>'); // start from no page access; a real click grants activeTab
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
    await expect(cameraFrame(page).locator('#dropHint')).toBeVisible({ timeout: 20000 });
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

// The case that matters: in real Chrome the panel iframe is an out-of-process extension frame and receives NO drag events
// from the page, so the drop is caught by a drop zone on the page and forwarded with chrome.runtime messaging.
test('a real mouse drag of a product image from the shop page into the installed extension\'s panel starts the AI session', async () => {
  test.setTimeout(90000);
  const dir = extensionCopyWithHost('http://127.0.0.1/*');
  const { context, worker, id } = await launchWithExtension(dir);
  try {
    await worker.evaluate(() => chrome.storage.local.set({ decartKey: 'dct_test_key' }));
    const page = await context.newPage();
    await page.addInitScript(installFakeSdk); // also runs inside the extension iframe
    await page.goto(`${base}/tests/fixtures/shop.html`);
    await clickToolbar(worker, 'http://127.0.0.1/*');
    await expect.poll(() => cameraFrame(page) && cameraFrame(page).url(), { timeout: 15000 }).toContain(`chrome-extension://${id}/camera/camera.html?embed=1&pid=`);
    const frame = cameraFrame(page);
    await expect(frame.locator('#statusBadge')).toContainText('Live', { timeout: 20000 });
    await expect(frame.locator('#aiState')).toHaveText('Ready');
    await expect(frame.locator('#dropHint')).toBeVisible(); // the cue is visible on the video
    expect(await frame.evaluate(() => window.__calls.length)).toBe(0); // nothing billed yet

    // real mouse drag: the <img> on the page -> onto the panel
    const from = await page.locator('#product').boundingBox(); const to = await frame.locator('.video-wrap').boundingBox();
    await page.mouse.move(from.x + 60, from.y + 60); await page.mouse.down(); await page.mouse.move(from.x + 80, from.y + 80, { steps: 4 });
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
    await expect(page.locator('#__tryon-panel-host .dz')).toBeVisible(); // the drop zone appears over the panel while dragging
    await page.mouse.up();

    await expect.poll(() => frame.evaluate(() => window.__calls.map((c) => c[0]).join(',')), { timeout: 20000 }).toBe('token,connect,setImage');
    expect(await frame.evaluate(() => window.__calls[2].slice(1, 4))).toEqual([true, true, 'Substitute the current top with the garment shown in the reference image']);
    await expect(frame.locator('#aiVideo')).toBeVisible(); // try-on shown in the same screen
    await expect(page.locator('#__tryon-panel-host .dz')).toBeHidden(); // drop zone is gone again
  } finally { await context.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// Product images on big shops (image.hm.com, static.zara.net...) are served without CORS headers. The page cannot read them,
// so the drop is handed to the extension, which can (host permission). "Other site" here is a second local server with no CORS headers.
test('an image from another site that sends no CORS headers (like image.hm.com) can still be dropped', async () => {
  test.setTimeout(90000);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const other = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(png); }); // note: no Access-Control-Allow-Origin
  await new Promise((r) => other.listen(0, '127.0.0.1', r));
  const otherUrl = `http://127.0.0.1:${other.address().port}/assets/hm/3d/68/tee.png?imwidth=1536`;
  const dir = extensionCopyWithHost('http://127.0.0.1/*');
  const { context, worker, id } = await launchWithExtension(dir);
  try {
    await worker.evaluate(() => chrome.storage.local.set({ decartKey: 'dct_test_key' }));
    const page = await context.newPage();
    await page.addInitScript(installFakeSdk);
    await page.goto(`${base}/tests/fixtures/shop.html`);
    await page.evaluate((src) => { const img = new Image(); img.id = 'hm'; img.src = src; img.draggable = true; img.style.cssText = 'position:fixed;left:30px;top:420px;width:200px;height:240px;background:#ddd'; document.body.appendChild(img); }, otherUrl);
    expect(await page.evaluate((u) => fetch(u).then(() => 'readable').catch(() => 'blocked'), otherUrl)).toBe('blocked'); // the page itself cannot read it
    await clickToolbar(worker, 'http://127.0.0.1/*');
    await expect.poll(() => cameraFrame(page) && cameraFrame(page).url(), { timeout: 15000 }).toContain(`chrome-extension://${id}/camera/camera.html?embed=1`);
    const frame = cameraFrame(page);
    await expect(frame.locator('#statusBadge')).toContainText('Live', { timeout: 20000 });
    const from = await page.locator('#hm').boundingBox(); const to = await frame.locator('.video-wrap').boundingBox();
    await page.mouse.move(from.x + 60, from.y + 60); await page.mouse.down(); await page.mouse.move(from.x + 80, from.y + 80, { steps: 4 });
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 }); await page.mouse.up();
    await expect.poll(() => frame.evaluate(() => window.__calls.map((c) => c[0]).join(',')), { timeout: 20000 }).toBe('token,connect,setImage');
    expect(await frame.evaluate(() => window.__calls[2].slice(1, 3))).toEqual([true, true]); // a real image Blob reached the AI session
  } finally { await context.close(); await new Promise((r) => other.close(r)); fs.rmSync(dir, { recursive: true, force: true }); }
});
