const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');

test('manifest exists and is valid MV3 JSON', () => {
  const manifestPath = path.join(repoRoot, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  expect(manifest).toBeTruthy();
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.name).toBeTruthy();
  expect(manifest.action.default_popup).toContain('popup.html');
});

test('popup loads and contains expected controls', async ({ page }) => {
  const popupHtmlPath = path.join(repoRoot, 'popup', 'popup.html');
  const fileUrl = 'file://' + popupHtmlPath;

  await page.goto(fileUrl);

  await expect(page.locator('h1')).toContainText('Live Try-On Pro');
  await expect(page.locator('#toggleCameraBtn')).toBeVisible();
  await expect(page.locator('#captureBtn')).toBeVisible();
  await expect(page.locator('#recordBtn')).toBeVisible();
  await expect(page.locator('[data-garment="hoodie"]')).toBeVisible();
  await expect(page.locator('[data-garment="shirt"]')).toBeVisible();
});

test('controls can be interacted with without crashing', async ({ page }) => {
  const popupHtmlPath = path.join(repoRoot, 'popup', 'popup.html');
  await page.goto('file://' + popupHtmlPath);

  await page.locator('[data-garment="shirt"]').click();
  await page.locator('#motionRange').fill('82');
  await page.locator('#windRange').fill('55');
  await page.locator('#brightnessRange').fill('40');

  const status = await page.locator('#statusBadge').textContent();
  expect(status).toBeTruthy();
});
