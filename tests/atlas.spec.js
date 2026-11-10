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

test('a viewpoint highlights topics and can be added to my focus', async ({ page }) => {
  await page.goto(URL + '#lens-lawyer');
  await expect(page.locator('#panel h2')).toHaveText('Lawyer or compliance lead');
  await expect(page.locator('#banner')).toBeVisible();
  expect(await page.locator('#world path.prov.lit').count()).toBeGreaterThan(5);
  await page.locator('button[data-act="pin-all"]').click();
  const n = Number(await page.locator('#focus-n').textContent());
  expect(n).toBeGreaterThan(5);

  // the stars survive a reload and My focus explains how they fit
  await page.goto(URL + '#focus');
  await page.reload();
  await expect(page.locator('#panel h2')).toHaveText('My focus');
  await expect(page.locator('#panel .lede')).toContainText(`You follow ${n} topics`);
  expect(await page.locator('#world path.prov.pinned').count()).toBe(n);
  await page.locator('#banner-clear').click();
  await expect(page.locator('#banner')).toBeHidden();
});

test('a topic offers deep-dive links and a star toggle', async ({ page }) => {
  await page.goto(URL + '#legal-contracts');
  expect(await page.locator('#panel .dd a[href^="http"]').count()).toBeGreaterThan(0);
  await page.locator('#panel .picks button[data-pin="legal.contracts"]').click();
  await expect(page.locator('#focus-n')).toHaveText('1');
  await page.locator('#panel .picks button[data-pin="legal.contracts"]').click();
  await expect(page.locator('#focus-n')).toHaveText('0');
});

test('every landmark source and deep dive is an http(s) link', () => {
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'atlas', 'atlas-data.js'), 'utf8');
  const data = JSON.parse(src.slice(src.indexOf('{'), src.lastIndexOf('}') + 1));
  for (const f of data.fields) for (const r of f.regions) {
    expect(r.landmarks.length, r.id).toBeGreaterThan(0);
    for (const l of r.landmarks) if (l.source) expect(l.source, l.name).toMatch(/^https?:\/\//);
    for (const d of r.deepDives || []) expect(d.url, r.id).toMatch(/^https?:\/\//);
  }
});
