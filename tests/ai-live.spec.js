// Exercises the AI Live flow against a mock of the Decart SDK (no key, no network, no cost).
const { test, expect, chromium } = require('@playwright/test');
const path = require('path');
const { garmentPrompt } = require('../src/decart-live.js');

const root = path.join(__dirname, '..');

test('garment prompts follow Decart\'s "Substitute the current ..." pattern', () => {
  expect(garmentPrompt('shirt')).toBe('Substitute the current top with the garment shown in the reference image');
  expect(garmentPrompt('hoodie', ' black leather ')).toBe('Substitute the current top with the garment shown in the reference image: black leather');
  expect(garmentPrompt('dress')).toContain('Substitute the current outfit with the dress');
});

test('AI mode: drop a garment -> token with limits, connect, setImage, disconnect on Stop', async () => {
  test.setTimeout(60000);
  const context = await chromium.launchPersistentContext('', { headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const page = await context.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('decartKey', 'dct_test_key'); localStorage.setItem('mode', 'ai');
    window.__calls = [];
    const fake = {
      createDecartClient: ({ apiKey }) => ({
        tokens: { create: async (o) => { window.__calls.push(['token', apiKey, JSON.stringify(o)]); return { apiKey: 'ek_short_lived' }; } },
        realtime: {
          connect: async (stream, opts) => {
            window.__calls.push(['connect', apiKey, opts.model.name, opts.mirror, stream.getVideoTracks().length]);
            opts.onConnectionChange('connected');
            const c = document.createElement('canvas'); c.width = 640; c.height = 360; const x = c.getContext('2d'); x.fillStyle = '#0a0'; x.fillRect(0, 0, 640, 360);
            opts.onRemoteStream(c.captureStream(15));
            return {
              on() {}, off() {}, isConnected: () => true,
              setImage: async (img, o) => { window.__calls.push(['setImage', img instanceof Blob, img.size > 0, o.prompt, o.enhance]); },
              disconnect: () => window.__calls.push(['disconnect'])
            };
          }
        }
      }),
      models: { realtime: (name) => ({ name, fps: { ideal: 30, max: 30 }, width: 1280, height: 720 }) }
    };
    Object.defineProperty(window, 'DecartSDK', { get: () => fake, set: () => {} });
  });
  await page.goto(`file://${path.join(root, 'camera/camera.html')}`);
  await expect(page.locator('body')).toHaveAttribute('data-mode', 'ai');
  await expect(page.locator('#aiCard')).toBeVisible();
  await expect(page.locator('#sessionControls')).toBeVisible();
  await expect(page.locator('.local-only').first()).toBeHidden();
  await page.waitForFunction(() => window.__tryOn && window.__tryOn.running);

  await page.evaluate(async () => { // drop a garment image file onto the page
    const c = document.createElement('canvas'); c.width = 200; c.height = 240; const x = c.getContext('2d'); x.fillStyle = '#c00'; x.fillRect(20, 20, 160, 200);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'tee.png', { type: 'image/png' }));
    document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await expect.poll(() => page.evaluate(() => window.__calls.map((c) => c[0]).join(',')), { timeout: 15000 }).toBe('token,connect,setImage');

  const calls = await page.evaluate(() => window.__calls);
  const token = JSON.parse(calls[0][2]);
  expect(calls[0][1]).toBe('dct_test_key');                       // permanent key only used to mint the token
  expect(token.allowedModels).toEqual(['lucy-vton-latest']);
  expect(token.constraints.realtime.maxSessionDuration).toBe(120); // default 2 min cost cap
  expect(calls[1].slice(1)).toEqual(['ek_short_lived', 'lucy-vton-latest', true, 1]); // short-lived key, mirrored input
  expect(calls[2].slice(1)).toEqual([true, true, 'Substitute the current top with the garment shown in the reference image', false]);
  await expect(page.locator('#aiVideo')).toBeVisible();          // edited stream is shown
  await expect(page.locator('#aiStartBtn')).toHaveText('Stop AI try-on');

  await page.locator('#closeCameraBtn').click();                  // Stop ends the billed session
  await expect.poll(() => page.evaluate(() => window.__calls.some((c) => c[0] === 'disconnect'))).toBe(true);
  await expect(page.locator('#aiVideo')).toBeHidden();
  await context.close();
});

test('switching back to Local preview ends the AI session and shows the local controls', async () => {
  const context = await chromium.launchPersistentContext('', { headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const page = await context.newPage();
  await page.addInitScript(() => { localStorage.setItem('mode', 'ai'); });
  await page.goto(`file://${path.join(root, 'camera/camera.html')}`);
  await expect(page.locator('#keyForm')).toBeVisible();           // no key yet -> asks for one
  await page.locator('#apiKeyInput').fill('dct_abc');
  await page.locator('#saveKeyBtn').click();
  await expect(page.locator('#sessionControls')).toBeVisible();
  await expect(page.locator('#keyForm')).toBeHidden();
  await page.locator('#modeSwitch [data-mode="local"]').click();
  await expect(page.locator('body')).toHaveAttribute('data-mode', 'local');
  await expect(page.locator('#sizeRange')).toBeVisible();
  await expect(page.locator('#aiCard')).toBeHidden();
  await context.close();
});
