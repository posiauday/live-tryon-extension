const { test, expect, chromium } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');

test('manifest is valid MV3', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.name).toBeTruthy();
  expect(manifest.action.default_popup).toBeUndefined(); // icon click shows the on-page panel
  expect(manifest.background.service_worker).toBe('background/background.js');
  expect(manifest.web_accessible_resources[0].resources).toContain('camera/camera.html');
});

test('camera page loads and initializes', async ({ page }) => {
  await page.goto(`file://${path.join(root, 'camera/camera.html')}`);
  await expect(page.locator('h1')).toContainText('Live Try-On Pro');
  await expect(page.locator('#userVideo')).toBeVisible();
  await expect(page.locator('#overlayCanvas')).toBeVisible();
  await expect(page.locator('.chip.active')).toContainText('Hoodie');

  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  await page.waitForTimeout(500);
  expect(errors.length).toBe(0);
});

test('garment controls work without crashing', async ({ page }) => {
  await page.goto(`file://${path.join(root, 'camera/camera.html')}`);
  await page.locator('[data-garment="shirt"]').click();
  await expect(page.locator('[data-garment="shirt"]')).toHaveClass(/active/);
  await page.locator('[data-garment="dress"]').click();
  await expect(page.locator('[data-garment="dress"]')).toHaveClass(/active/);
  await page.locator('#motionRange').fill('80');
  await page.locator('#windRange').fill('50');
  await page.locator('#brightnessRange').fill('40');

  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  await page.waitForTimeout(300);
  expect(errors.length).toBe(0);
});

test('canvas renders and FPS counter updates with fake media stream', async () => {
  const context = await chromium.launchPersistentContext('', {
    headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });

  const page = await context.newPage();
  await page.goto(`file://${path.join(root, 'camera/camera.html')}`);

  // Wait for camera to start and process frames
  await page.waitForTimeout(2000);

  const fps = await page.locator('#fpsCounter').textContent();
  expect(parseInt(fps)).toBeGreaterThan(0);

  const status = await page.locator('#statusBadge').textContent();
  expect(status).toContain('Live');

  await context.close();
});

test('stop button cleans up streams', async ({ page }) => {
  await page.goto(`file://${path.join(root, 'camera/camera.html')}`);
  await page.evaluate(() => {
    const mockCanvas = document.createElement('canvas');
    mockCanvas.width = 1280;
    mockCanvas.height = 720;
    const stream = mockCanvas.captureStream(30);
    const video = document.getElementById('userVideo');
    video.srcObject = stream;
  });

  const streamCount = await page.evaluate(() => {
    const video = document.getElementById('userVideo');
    return video.srcObject ? video.srcObject.getTracks().length : 0;
  });

  expect(streamCount).toBeGreaterThan(0);
  await page.locator('#closeCameraBtn').click();
  await page.waitForTimeout(300);

  const streamAfterStop = await page.evaluate(() => {
    const video = document.getElementById('userVideo');
    return video.srcObject ? video.srcObject.getTracks().length : 0;
  });

  expect(streamAfterStop).toBe(0);
});

test('error message displays for permission denied', async () => {
  const context = await chromium.launchPersistentContext('', {
    headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });

  const page = await context.newPage();

  // Inject mock BEFORE loading page
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const error = new DOMException('Permission denied', 'NotAllowedError');
      throw error;
    };
  });

  await page.goto(`file://${path.join(root, 'camera/camera.html')}`);
  await page.waitForTimeout(1500);

  const errorMsg = await page.locator('#errorMessage').textContent();
  expect(errorMsg).toContain('NotAllowedError');

  await context.close();
});
