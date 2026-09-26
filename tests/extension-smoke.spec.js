const { test, expect, chromium } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const args = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];

test('manifest is valid MV3', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.name).toBeTruthy();
  expect(manifest.action.default_popup).toBeUndefined(); // icon click shows the on-page panel
  expect(manifest.background.service_worker).toBe('background/background.js');
  expect(manifest.web_accessible_resources[0].resources).toContain('camera/camera.html');
});

test('camera page opens in the Decart mode by default: one video screen, a drop cue, no upload form; Free mode is one click away', async ({ page }) => {
  await page.goto(`file://${path.join(root, 'camera/camera.html')}`);
  await expect(page.locator('h1')).toContainText('Live Try-On Pro');
  await expect(page.locator('body')).toHaveAttribute('data-mode', 'ai');
  await expect(page.locator('#userVideo')).toBeVisible();
  await expect(page.locator('#dropHint')).toBeVisible();
  await expect(page.locator('#dropHintText')).toHaveText('Drag a product image here');
  await expect(page.locator('#keyForm')).toBeVisible(); // no key yet
  await expect(page.locator('#aiCard')).toBeVisible(); await expect(page.locator('#freeCard')).toBeHidden(); await expect(page.locator('#overlayCanvas')).toBeHidden();
  await expect(page.locator('#modeSwitch button')).toHaveCount(2);
  for (const removed of ['.chip', '#motionRange', '#windRange', '#poseStatus', '#fpsCounter', '#uploadBtn', '#fitType', '#garmentDesc']) {
    await expect(page.locator(removed)).toHaveCount(0);
  }
  const errors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  await page.waitForTimeout(500);
  expect(errors.length).toBe(0);
});

test('camera goes live and dropping a garment without a key asks for the key', async () => {
  const context = await chromium.launchPersistentContext('', { headless: true, args });
  const page = await context.newPage();
  await page.goto(`file://${path.join(root, 'camera/camera.html')}`);
  await expect(page.locator('#statusBadge')).toContainText('Live', { timeout: 15000 });
  await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 100; c.height = 100; c.getContext('2d').fillRect(0, 0, 100, 100);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'tee.png', { type: 'image/png' }));
    document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await expect(page.locator('#toast')).toContainText('API key');
  await context.close();
});

test('stop button cleans up streams', async ({ page }) => {
  await page.goto(`file://${path.join(root, 'camera/camera.html')}`);
  await page.evaluate(() => {
    const mockCanvas = document.createElement('canvas');
    mockCanvas.width = 1280;
    mockCanvas.height = 720;
    document.getElementById('userVideo').srcObject = mockCanvas.captureStream(30);
  });
  expect(await page.evaluate(() => document.getElementById('userVideo').srcObject.getTracks().length)).toBeGreaterThan(0);
  await page.locator('#closeCameraBtn').click();
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => { const v = document.getElementById('userVideo'); return v.srcObject ? v.srcObject.getTracks().length : 0; })).toBe(0);
});

test('error message displays for permission denied', async () => {
  const context = await chromium.launchPersistentContext('', { headless: true, args });
  const page = await context.newPage();
  await page.addInitScript(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Permission denied', 'NotAllowedError'); }; });
  await page.goto(`file://${path.join(root, 'camera/camera.html')}`);
  await page.waitForTimeout(1500);
  expect(await page.locator('#errorMessage').textContent()).toContain('NotAllowedError');
  await context.close();
});
