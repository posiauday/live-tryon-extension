// Free mode end to end: real browser, real page code, mock AI server, injected pose landmarks.
const { test, expect, chromium } = require('@playwright/test');
const path = require('path');
const { startHarness, installFakes, makePose, GARMENT_BOX } = require('./helpers/free-harness.js');
const { portraitCrop } = require('../src/free/free-pipeline.js');

const root = path.join(__dirname, '..');
const args = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];

async function setup({ options = {}, delayMs = 0 } = {}) {
  const context = await chromium.launchPersistentContext('', { headless: true, viewport: { width: 1300, height: 900 }, args });
  const helper = await context.newPage();
  const harness = await startHarness(helper); harness.state.delayMs = delayMs;
  const page = await context.newPage();
  await page.addInitScript(installFakes);
  if (Object.keys(options).length) await page.addInitScript((o) => { window.__freeOptions = Object.assign({ countdown: 0.4 }, o); }, options);
  await page.goto(`${harness.base}/camera/camera.html?backend=${encodeURIComponent(harness.base)}`);
  await expect(page.locator('body')).toHaveAttribute('data-mode', 'free');
  await expect(page.locator('#statusBadge')).toContainText('Live', { timeout: 20000 });
  await page.waitForFunction(() => window.freeMode && window.freeMode.pipeline, null, { timeout: 15000 });
  const size = await page.evaluate(() => ({ W: document.getElementById('userVideo').videoWidth, H: document.getElementById('userVideo').videoHeight }));
  const done = async () => { await harness.close(); await context.close(); };
  return { context, page, harness, size, done };
}

const setPose = (page, pose) => page.evaluate((p) => { window.__testPose = p; }, pose);
const dropGarment = (page, name = 'tee.png') => page.evaluate(async (name) => {
  const c = document.createElement('canvas'); c.width = 200; c.height = 240; const x = c.getContext('2d'); x.fillStyle = '#c00'; x.fillRect(20, 20, 160, 200);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const dt = new DataTransfer(); dt.items.add(new File([blob], name, { type: 'image/png' }));
  document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
}, name);
// bounding box of everything drawn on the overlay canvas (it only contains the garment layer here)
const drawnBox = (page) => page.evaluate(() => {
  const c = document.getElementById('overlayCanvas'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1, n = 0;
  for (let y = 0; y < c.height; y += 2) for (let x = 0; x < c.width; x += 2) if (d[(y * c.width + x) * 4 + 3] > 128) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return { x0, y0, x1, y1, n, w: c.width, h: c.height };
});
const expectedBox = (pose, W, H) => { const c = portraitCrop(pose, W, H); return { x0: c.x + GARMENT_BOX.x0 * c.w, y0: c.y + GARMENT_BOX.y0 * c.h, x1: c.x + GARMENT_BOX.x1 * c.w, y1: c.y + GARMENT_BOX.y1 * c.h }; };
const goLive = async (page, pose) => {
  await setPose(page, pose); await dropGarment(page);
  await expect.poll(() => page.evaluate(() => window.freeMode.pipeline.phase), { timeout: 30000 }).toBe('live');
};

test.describe('mode switch', () => {
  test('the Free card and the Decart card swap, and the switch is remembered', async () => {
    const { page, done } = await setup();
    await expect(page.locator('#freeCard')).toBeVisible(); await expect(page.locator('#aiCard')).toBeHidden();
    await page.locator('#modeSwitch [data-mode="ai"]').click();
    await expect(page.locator('body')).toHaveAttribute('data-mode', 'ai');
    await expect(page.locator('#aiCard')).toBeVisible(); await expect(page.locator('#freeCard')).toBeHidden(); await expect(page.locator('#overlayCanvas')).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem('mode'))).toBe('ai');
    await page.locator('#modeSwitch [data-mode="free"]').click();
    await expect(page.locator('#freeCard')).toBeVisible();
    await done();
  });
});

test.describe('free pipeline', () => {
  test('drop -> 3-2-1 -> AI keyframe -> the garment is cut out and drawn on the torso', async () => {
    test.setTimeout(60000);
    const { page, harness, size, done } = await setup({ options: { tracking: false }, delayMs: 900 });
    const pose = makePose(); await setPose(page, pose);
    await expect(page.locator('#freeBackendState')).toContainText('Online');
    await dropGarment(page, 'tee.png');
    await expect(page.locator('#freeOverlay')).toBeVisible();                                   // countdown / progress overlay
    await expect(page.locator('#freeOverlayText')).toContainText('Making your look', { timeout: 10000 });
    expect(await page.evaluate(() => window.freeMode.pipeline.phase)).toBe('generating');
    await expect.poll(() => page.evaluate(() => window.freeMode.pipeline.phase), { timeout: 20000 }).toBe('live');
    await expect(page.locator('#freeOverlay')).toBeHidden();
    await expect(page.locator('#freeBank')).toHaveText('1 / 6');
    expect(harness.state.requests.length).toBe(1); expect(harness.state.requests[0].category).toBe('upper');

    await page.waitForTimeout(600);                                                              // fade-in
    const box = await drawnBox(page), exp = expectedBox(pose, size.W, size.H);
    expect(box.n).toBeGreaterThan(500);
    const tol = size.W * 0.04;
    expect(Math.abs(box.x0 - exp.x0)).toBeLessThan(tol); expect(Math.abs(box.x1 - exp.x1)).toBeLessThan(tol);
    expect(Math.abs(box.y0 - exp.y0)).toBeLessThan(tol); expect(Math.abs(box.y1 - Math.min(exp.y1, size.H))).toBeLessThan(tol);
    expect(await page.evaluate(() => window.freeMode.pipeline.renderer.kind)).toMatch(/webgl|2d/);
    await done();
  });

  test('the garment follows you: it moves and scales with your shoulders', async () => {
    test.setTimeout(60000);
    const { page, size, done } = await setup({ options: { tracking: false } });
    await goLive(page, makePose()); await page.waitForTimeout(700);
    const base = await drawnBox(page), bw = base.x1 - base.x0, bcx = (base.x0 + base.x1) / 2;

    await setPose(page, makePose({ cx: 0.5 + 0.12 })); await page.waitForTimeout(600);
    const moved = await drawnBox(page);
    expect(((moved.x0 + moved.x1) / 2) - bcx).toBeGreaterThan(size.W * 0.12 * 0.85); expect(((moved.x0 + moved.x1) / 2) - bcx).toBeLessThan(size.W * 0.12 * 1.15);
    expect(Math.abs((moved.x1 - moved.x0) - bw)).toBeLessThan(size.W * 0.03);                    // pure translation keeps the size

    await setPose(page, makePose({ scale: 1.35 })); await page.waitForTimeout(600);
    const bigger = await drawnBox(page);
    const ratio = (bigger.x1 - bigger.x0) / bw; expect(ratio).toBeGreaterThan(1.2); expect(ratio).toBeLessThan(1.5);   // you stepped closer

    await setPose(page, null); await page.waitForTimeout(900);                                    // nobody in view: garment fades out
    expect((await drawnBox(page)).n).toBe(0);
    await done();
  });

  test('a new pose starts another keyframe in the background and the bank grows', async () => {
    test.setTimeout(90000);
    const { page, harness, done } = await setup({ options: { tracking: false }, delayMs: 400 });
    await goLive(page, makePose());
    expect(harness.state.requests.length).toBe(1);
    await setPose(page, makePose({ armsUp: true }));                                              // far from the stored pose, then hold still
    await expect.poll(() => harness.state.requests.length, { timeout: 15000 }).toBe(2);
    await expect(page.locator('#freeBank')).toHaveText('2 / 6', { timeout: 15000 });
    expect(await page.evaluate(() => window.freeMode.pipeline.bank.size)).toBe(2);
    // and it does not keep asking while the pose is covered
    await page.waitForTimeout(2500); expect(harness.state.requests.length).toBe(2);
    await done();
  });

  test('"Add new angles automatically" can be switched off', async () => {
    test.setTimeout(60000);
    const { page, harness, done } = await setup({ options: { tracking: false } });
    await page.locator('#optAngles').uncheck();
    await goLive(page, makePose());
    await setPose(page, makePose({ armsUp: true })); await page.waitForTimeout(3000);
    expect(harness.state.requests.length).toBe(1); expect(await page.evaluate(() => window.freeMode.pipeline.bank.size)).toBe(1);
    await done();
  });

  test('Remove garment cancels everything and clears the overlay', async () => {
    test.setTimeout(60000);
    const { page, done } = await setup({ options: { tracking: false } });
    await goLive(page, makePose()); await page.waitForTimeout(600);
    expect((await drawnBox(page)).n).toBeGreaterThan(500);
    await page.locator('#freeResetBtn').click();
    await expect(page.locator('#freeBank')).toHaveText('0 / 6');
    expect(await page.evaluate(() => window.freeMode.pipeline.phase)).toBe('idle');
    await page.waitForTimeout(300); expect((await drawnBox(page)).n).toBe(0);
    await done();
  });

  test('countdown waits until your shoulders are visible', async () => {
    test.setTimeout(60000);
    const { page, harness, done } = await setup({ options: { tracking: false, countdown: 1 } });
    await setPose(page, null); await dropGarment(page);
    await expect(page.locator('#freeOverlayText')).toContainText('see your shoulders', { timeout: 10000 });
    await page.waitForTimeout(1500); expect(harness.state.requests.length).toBe(0);              // still waiting, nothing sent
    await setPose(page, makePose());
    await expect(page.locator('#freeOverlayBig')).toHaveText(/[123]/, { timeout: 5000 });
    await expect.poll(() => page.evaluate(() => window.freeMode.pipeline.phase), { timeout: 20000 }).toBe('live');
    await done();
  });

  test('server not running: nothing is captured or sent, and you are told what to do', async () => {
    test.setTimeout(60000);
    const { page, harness, done } = await setup();
    harness.state.online = false;
    await setPose(page, makePose()); await dropGarment(page);
    await expect(page.locator('#toast')).toContainText('not running', { timeout: 10000 });
    await expect(page.locator('#freeBackendState')).toHaveText('Offline');
    expect(harness.state.requests.length).toBe(0); expect(await page.evaluate(() => window.freeMode.pipeline.phase)).toBe('idle');
    await done();
  });

  test('a server error (e.g. GPU out of memory) is shown once and never retried automatically', async () => {
    test.setTimeout(60000);
    const { page, harness, done } = await setup({ options: { tracking: false } });
    harness.state.failNext = { status: 500, error: 'The GPU ran out of memory. Close other GPU apps and try again.' };
    await setPose(page, makePose()); await dropGarment(page);
    await expect(page.locator('#toast')).toContainText('ran out of memory', { timeout: 15000 });
    expect(await page.evaluate(() => window.freeMode.pipeline.phase)).toBe('idle');
    await page.waitForTimeout(2500); expect(harness.state.requests.length).toBe(1);
    // dropping again works
    await dropGarment(page); await expect.poll(() => page.evaluate(() => window.freeMode.pipeline.phase), { timeout: 20000 }).toBe('live');
    await done();
  });

  test('the Canvas 2D fallback renderer draws the same garment', async () => {
    test.setTimeout(60000);
    const { page, size, done } = await setup({ options: { tracking: false, forceFallbackRenderer: true } });
    const pose = makePose(); await goLive(page, pose); await page.waitForTimeout(800);
    expect(await page.evaluate(() => window.freeMode.pipeline.renderer.kind)).toBe('2d');
    const box = await drawnBox(page), exp = expectedBox(pose, size.W, size.H);
    expect(box.n).toBeGreaterThan(300); expect(Math.abs(box.x0 - exp.x0)).toBeLessThan(size.W * 0.05);
    await done();
  });

  test('fabric tracking runs on the live frames without breaking the picture', async () => {
    test.setTimeout(60000);
    const { page, size, done } = await setup({ options: { tracking: true } });
    const pose = makePose(); await goLive(page, pose); await page.waitForTimeout(900);
    const box = await drawnBox(page), exp = expectedBox(pose, size.W, size.H);
    expect(box.n).toBeGreaterThan(500); expect(Math.abs(box.x0 - exp.x0)).toBeLessThan(size.W * 0.06);
    const ms = await page.evaluate(() => window.freeMode.pipeline.stats.renderMs); expect(ms).toBeLessThan(60);   // per-frame cost stays small
    await done();
  });
});

test('installed extension, Free mode: the real pose and segmentation models load and the server check works', async () => {
  test.setTimeout(150000);
  const context = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, ...args] });
  try {
    let [worker] = context.serviceWorkers(); if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 30000 });
    const id = new URL(worker.url()).host;
    await worker.evaluate(() => chrome.storage.local.set({ mode: 'free' }));
    const page = await context.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`chrome-extension://${id}/camera/camera.html`);
    await expect(page.locator('body')).toHaveAttribute('data-mode', 'free');
    await expect(page.locator('#freeModels')).toHaveText('Ready', { timeout: 120000 });
    await expect(page.locator('#freeBackendState')).toHaveText('Offline');                       // no server in this test
    await page.locator('#freeCheckBtn').click();
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});
