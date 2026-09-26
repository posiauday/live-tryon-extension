// Exercises the AI Live flow against a mock of the Decart SDK (no key, no network, no cost).
const { test, expect, chromium } = require('@playwright/test');
const path = require('path');
const { garmentPrompt, kindFromHint } = require('../src/decart-live.js');
const { installFakeSdk } = require('./helpers/fake-decart.js');

const root = path.join(__dirname, '..');
const args = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];

test('garment prompts follow Decart\'s "Substitute the current ..." pattern', () => {
  expect(garmentPrompt('shirt')).toBe('Substitute the current top with the garment shown in the reference image');
  expect(garmentPrompt('hoodie', ' black leather ')).toBe('Substitute the current top with the garment shown in the reference image: black leather');
  expect(garmentPrompt('dress')).toContain('Substitute the current outfit with the dress');
});

test('the garment type is guessed from alt text / file name (there is no type picker)', () => {
  expect(kindFromHint('Black leather jacket')).toBe('shirt');
  expect(kindFromHint('oversized-hoodie-grey.jpg')).toBe('shirt');
  expect(kindFromHint('Slim fit stretch jeans')).toBe('pants');
  expect(kindFromHint('wide-leg-trousers.webp')).toBe('pants');
  expect(kindFromHint('Floral midi dress')).toBe('dress');
  expect(kindFromHint('pleated skirt')).toBe('dress');
  expect(kindFromHint('')).toBe('shirt');
  expect(garmentPrompt('pants')).toBe('Substitute the current pants with the pants shown in the reference image');
});

const dropGarment = (page, name = 'tee.png') => page.evaluate(async (name) => {
  const c = document.createElement('canvas'); c.width = 200; c.height = 240; const x = c.getContext('2d'); x.fillStyle = '#c00'; x.fillRect(20, 20, 160, 200);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const dt = new DataTransfer(); dt.items.add(new File([blob], name, { type: 'image/png' }));
  document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
}, name);
const callNames = (page) => page.evaluate(() => window.__calls.map((c) => c[0]).join(','));

test('one screen: nothing is billed until a garment is dropped; drop -> token with limits, connect, setImage; End session / Stop disconnect', async () => {
  test.setTimeout(60000);
  const context = await chromium.launchPersistentContext('', { headless: true, args });
  const page = await context.newPage();
  await page.addInitScript(() => { localStorage.setItem('decartKey', 'dct_test_key'); });
  await page.addInitScript(installFakeSdk);
  await page.goto(`file://${path.join(root, 'camera/camera.html')}`);
  await expect(page.locator('#sessionControls')).toBeVisible();
  await expect(page.locator('#keyForm')).toBeHidden();
  await page.waitForFunction(() => window.__tryOn && window.__tryOn.running);

  // camera is live, the cue is on the video, and no AI session (= no billing) has started yet
  await expect(page.locator('#dropHint')).toBeVisible();
  await expect(page.locator('#dropHintText')).toHaveText('Drag a product image here');
  await expect(page.locator('#aiVideo')).toBeHidden();
  await expect(page.locator('#aiState')).toHaveText('Ready');
  for (const gone of ['#uploadBtn', '#fitType', '#garmentDesc']) await expect(page.locator(gone)).toHaveCount(0); // drag & drop on the video is the only input
  expect(await callNames(page)).toBe('');

  await dropGarment(page);
  await expect.poll(() => callNames(page), { timeout: 15000 }).toBe('token,connect,setImage');
  const calls = await page.evaluate(() => window.__calls);
  const token = JSON.parse(calls[0][2]);
  expect(calls[0][1]).toBe('dct_test_key');                       // permanent key only used to mint the token
  expect(token.allowedModels).toEqual(['lucy-vton-latest']);
  expect(token.constraints.realtime.maxSessionDuration).toBe(120); // default 2 min cost cap
  expect(calls[1].slice(1)).toEqual(['ek_short_lived', 'lucy-vton-latest', true, 1]); // short-lived key, mirrored input
  expect(calls[2].slice(1)).toEqual([true, true, 'Substitute the current top with the garment shown in the reference image', false]);
  await expect(page.locator('#aiVideo')).toBeVisible();          // the try-on replaces the camera in the same screen
  await expect(page.locator('#dropHintText')).toHaveText('Drop another garment to switch');
  await expect(page.locator('#aiStartBtn')).toBeVisible();       // "End session"

  // dropping a different garment switches it without reconnecting; the prompt follows what it is
  await dropGarment(page, 'slim-fit-jeans.png');
  await expect.poll(() => callNames(page)).toBe('token,connect,setImage,setImage');
  expect((await page.evaluate(() => window.__calls[3]))[3]).toBe('Substitute the current pants with the pants shown in the reference image');

  await page.locator('#aiStartBtn').click();                      // End session
  await expect.poll(() => page.evaluate(() => window.__calls.some((c) => c[0] === 'disconnect'))).toBe(true);
  await expect(page.locator('#aiVideo')).toBeHidden();            // back to the plain camera
  await expect(page.locator('#dropHintText')).toHaveText('Drag a product image here');
  await context.close();
});

test('Stop ends a billed session', async () => {
  test.setTimeout(60000);
  const context = await chromium.launchPersistentContext('', { headless: true, args });
  const page = await context.newPage();
  await page.addInitScript(() => { localStorage.setItem('decartKey', 'dct_test_key'); });
  await page.addInitScript(installFakeSdk);
  await page.goto(`file://${path.join(root, 'camera/camera.html')}`);
  await page.waitForFunction(() => window.__tryOn && window.__tryOn.running);
  await dropGarment(page);
  await expect.poll(() => callNames(page), { timeout: 15000 }).toBe('token,connect,setImage');
  await page.locator('#closeCameraBtn').click();
  await expect.poll(() => page.evaluate(() => window.__calls.some((c) => c[0] === 'disconnect'))).toBe(true);
  await context.close();
});

test('a garment dropped before a key is set is kept and starts the session as soon as the key is saved', async () => {
  test.setTimeout(60000);
  const context = await chromium.launchPersistentContext('', { headless: true, args });
  const page = await context.newPage();
  await page.addInitScript(installFakeSdk);
  await page.goto(`file://${path.join(root, 'camera/camera.html')}`);
  await page.waitForFunction(() => window.__tryOn && window.__tryOn.running);
  await expect(page.locator('#keyForm')).toBeVisible();
  await dropGarment(page);
  await expect(page.locator('#toast')).toContainText('API key');
  expect(await callNames(page)).toBe('');                         // nothing sent, nothing billed
  await page.locator('#apiKeyInput').fill('dct_abc');
  await page.locator('#saveKeyBtn').click();
  await expect.poll(() => callNames(page), { timeout: 15000 }).toBe('token,connect,setImage');
  await expect(page.locator('#sessionControls')).toBeVisible();
  await context.close();
});
