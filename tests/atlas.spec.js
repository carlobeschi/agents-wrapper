// @ts-check
// AI Atlas (atlas/index.html): a static page, opened from disk. Checks that the
// map draws every field, that search and the panel navigate, and that the data
// file is consistent with the layout.
const { test, expect } = require('@playwright/test');
const path = require('path');
const { execFileSync } = require('child_process');

const URL = 'file://' + path.join(__dirname, '..', 'atlas', 'index.html');

test('build reports no problems', () => {
  const out = execFileSync('node', [path.join(__dirname, '..', 'atlas', 'build.js')], { encoding: 'utf8' });
  expect(out).toMatch(/10 fields/);
  expect(out).not.toMatch(/Problems/);
});

test('draws the map and navigates world > field > topic', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(URL);
  await expect(page.locator('#panel h2')).toHaveText('Where AI work is happening');
  expect(await page.locator('#world path.prov').count()).toBeGreaterThan(60);

  await page.locator('#panel button[data-field="legal"]').click();
  await expect(page.locator('#panel h2')).toHaveText('Legal');
  await page.locator('#panel button[data-region="legal.contracts"]').click();
  await expect(page.locator('#panel h2')).toHaveText(/Contract/);
  expect(await page.locator('#panel .lm').count()).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('search finds a topic and the hash opens it', async ({ page }) => {
  await page.goto(URL);
  await page.fill('#q', 'code review');
  await page.keyboard.press('Enter');
  await expect(page.locator('#panel h2')).toHaveText('Code review');
  await page.goto(URL + '#geo-compute');
  await expect(page.locator('#panel h2')).toHaveText(/Compute/);
});
