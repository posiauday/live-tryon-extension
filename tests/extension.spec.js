// Loads the REAL extension in Chromium, so extension-only rules (CSP, chrome-extension:// origin) are exercised.
const { test, expect, chromium } = require('@playwright/test');
const path = require('path');

const root = path.join(__dirname, '..');

test('installed extension: CSP allows WebAssembly and the models load', async () => {
  test.setTimeout(150000);
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
    await expect(page.locator('#poseStatus')).toHaveText(/Searching|Detected/, { timeout: 120000 });
    await expect.poll(() => page.evaluate(() => !!(window.__tryOn.segmenter && window.__tryOn.segmenter.ready)), { timeout: 120000 }).toBe(true);
    expect(await page.locator('#poseStatus').textContent()).not.toMatch(/Unavailable|WebAssembly|CompileError/);
    expect(errors).toEqual([]);
    // the bundled Decart SDK loads under the extension CSP
    expect(await page.evaluate(() => typeof window.DecartSDK.createDecartClient + '/' + typeof window.DecartSDK.models.realtime)).toBe('function/function');

  } finally {
    await context.close();
  }
});
