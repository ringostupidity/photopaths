import { test, expect } from '@playwright/test';
import sharp from 'sharp';
test('home navigation and mobile layout', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const path of ['/', '/map', '/report', '/measure', '/settings']) {
      await page.goto(path);
      await expect(page.locator('nav')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
  }
  expect(errors).toEqual([]);
});
test('search, walking route selection, preference, favorites and streetlights', async ({
  page,
}) => {
  await page.goto('/map');
  await page.getByRole('button', { name: 'Use my current location' }).click();
  await expect(page.locator('#start')).toHaveValue('My current location');
  await page.locator('#destination').fill('Park');
  await page.locator('#search-end').click();
  await page.getByRole('button', { name: 'Test park', exact: true }).click();
  await page.getByRole('button', { name: 'Compare walking routes' }).click();
  await expect(page.locator('.route')).toHaveCount(2);
  await expect(page.locator('.route').first()).toContainText('/100 est.');
  await expect(page.locator('.route').first()).toContainText('0% camera');
  await expect(page.locator('.route').first()).toContainText('OSM estimate');
  await page.locator('.route').nth(1).click();
  await expect(page.locator('.route').nth(1)).toHaveAttribute('aria-pressed', 'true');
  await page.getByText('Walking directions', { exact: true }).click();
  await expect(page.locator('#steps')).toContainText('Walk toward Test park');
  await page.getByRole('button', { name: 'Save destination' }).click();
  await page.getByRole('button', { name: 'Load OSM lighting', exact: true }).click();
  await expect(page.locator('#notice')).toContainText('1 mapped streetlights');
  await expect(page.locator('#osm-status')).toContainText('1 roads/paths with lighting tags');
  await page.goto('/settings');
  await expect(page.locator('#favorites')).toContainText('Test park');
});

test('map picker can replace the start after setting a destination, and pins can be dragged', async ({
  page,
}) => {
  await page.goto('/map');
  await page.getByRole('button', { name: 'Use my current location' }).click();
  await expect(page.locator('#start')).toHaveValue('My current location');
  await page.getByRole('button', { name: 'Choose destination on map', exact: true }).click();
  await page.locator('#map').click({ position: { x: 250, y: 230 } });
  const destination = await page.locator('#destination').inputValue();
  expect(destination).not.toBe('');
  await page.getByRole('button', { name: 'Choose start on map', exact: true }).click();
  await page.locator('#map').click({ position: { x: 180, y: 300 } });
  await expect(page.locator('#start')).not.toHaveValue('My current location');
  await expect(page.locator('#destination')).toHaveValue(destination);
  const oldStart = await page.locator('#start').inputValue();
  const marker = page.getByTitle('Starting point (drag to move)', { exact: true });
  const box = await marker.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 35, box.y + box.height / 2 + 20, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('#start')).not.toHaveValue(oldStart);
  await expect(page.locator('#destination')).toHaveValue(destination);
  const movedStart = await page.locator('#start').inputValue();
  await page.getByRole('button', { name: 'Choose start on map', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.locator('#map').click({ position: { x: 350, y: 300 } });
  await expect(page.locator('#start')).toHaveValue(movedStart);
  await expect(page.locator('#destination')).toHaveValue(destination);
  await page.getByRole('button', { name: 'Compare walking routes' }).click();
  await expect(page.locator('.route')).toHaveCount(2);
  await page.locator('.leaflet-overlay-pane path').first().dispatchEvent('click');
  await expect(page.locator('.route')).toHaveCount(2);
  await expect(page.locator('#destination')).toHaveValue(destination);
});
test('report upload, persistence, safe text rendering and deletion', async ({ page }) => {
  await page.goto('/report');
  await page.locator('#problem').selectOption('broken');
  await page.locator('#latitude').fill('33.91');
  await page.locator('#longitude').fill('-117.89');
  await page.locator('#description').fill('<script>alert(1)</script> Broken light beside the park');
  const photo = await sharp({ create: { width: 80, height: 60, channels: 3, background: '#555' } })
    .png()
    .toBuffer();
  await page
    .locator('#photo')
    .setInputFiles({ name: 'light.png', mimeType: 'image/png', buffer: photo });
  await expect(page.locator('#photo-preview')).toBeVisible();
  await page.locator('#consent').check();
  await page.locator('#submit-report').click();
  await expect(page.locator('#notice')).toContainText('Report saved');
  await page.goto('/settings');
  await expect(page.locator('#contributions')).toContainText('<script>alert(1)</script>');
  page.on('dialog', (d) => d.accept());
  await page.locator('#contributions').getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('#contributions')).toContainText('Nothing shared yet');
});
test('camera capture shares only metrics and supports deletion', async ({ page }) => {
  await page.goto('/measure');
  await page.getByRole('button', { name: 'Open camera' }).click();
  await expect(page.locator('#camera')).toBeVisible();
  await page.getByRole('button', { name: 'Capture reading' }).click();
  await expect(page.locator('#reading')).toBeVisible();
  await expect(page.locator('#camera')).toBeHidden();
  await page.locator('#share-consent').check();
  const outgoing = page.waitForRequest(
    (r) => r.url().endsWith('/api/measurements') && r.method() === 'POST',
  );
  await page.getByRole('button', { name: 'Share measurement' }).click();
  expect((await outgoing).postDataJSON()).not.toHaveProperty('photo');
  await expect(page.locator('#notice')).toContainText(/saved|shared/i);
  await page.goto('/settings');
  await expect(page.locator('#contributions')).toContainText('Visibility');
  page.on('dialog', (d) => d.accept());
  await page.locator('#contributions').getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('#contributions')).toContainText('Nothing shared yet');
});
test('server errors produce a usable retry message', async ({ page }) => {
  await page.route('**/api/nearby?**', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'The lighting database is unavailable. Please try again.' }),
    }),
  );
  await page.goto('/map');
  await expect(page.locator('#notice')).toContainText('database is unavailable');
  await expect(page.getByRole('button', { name: 'Refresh area' })).toBeEnabled();
});
