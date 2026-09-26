// Loads the REAL extension in Chromium, so extension-only rules (CSP, chrome-extension:// origin) are exercised.
const { test, expect, chromium } = require('@playwright/test');
const path = require('path');

const root = path.join(__dirname, '..');

test('installed extension: camera page runs and the bundled Decart SDK loads under the extension CSP', async () => {
  test.setTimeout(60000);
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  try {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 30000 });
    const id = new URL(worker.url()).host;

    const page = await context.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`chrome-extension://${id}/camera/camera.html`);
    await expect(page.locator('#statusBadge')).toContainText('Live', { timeout: 20000 });
    expect(await page.evaluate(() => typeof window.DecartSDK.createDecartClient + '/' + typeof window.DecartSDK.models.realtime)).toBe('function/function');
    await expect(page.locator('.eyebrow')).toContainText(/v\d+\.\d+\.\d+/); // the version is shown
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
