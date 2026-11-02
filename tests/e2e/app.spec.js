// @ts-check
const { test, expect } = require('@playwright/test');

const SCREENS = 'test-results/screens';

async function noHorizontalOverflow(page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('__init')) {
      localStorage.clear();
      sessionStorage.setItem('__init', '1');
    }
  });
});

test('page loads and both lane blocks show numbers', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/雪隧王道/);
  for (const id of ['#lane-left', '#lane-right']) {
    const block = page.locator(id);
    await expect(block.locator('[data-field="speed"]')).toHaveText(/^\d{1,3}$/);
    await expect(block.locator('[data-field="vehiclesAhead"]')).toHaveText(/^\d+$/);
    await expect(block.locator('[data-field="slowSuspect"]')).toHaveText(/^\d+$/);
    await expect(block).toContainText('推估');
  }
  await expect(page.locator('#lane-left h2')).toContainText('左線');
  await expect(page.locator('#lane-right h2')).toContainText('右線');
  await expect(page.locator('#source')).toHaveText(/模擬資料/);
  await expect(page.locator('#data-time')).toHaveText(/\d{2}:\d{2}:\d{2}/);
  await expect(page.locator('#stale')).toBeHidden();
  await noHorizontalOverflow(page);
  await page.screenshot({ path: `${SCREENS}/home.png`, fullPage: true });
});

test('recommendation banner present with valid state', async ({ page }) => {
  await page.goto('/');
  const banner = page.locator('#banner');
  await expect(banner).toHaveAttribute('data-rec', /^(left|right|similar)$/);
  await expect(page.locator('#banner-text')).toHaveText(/建議走左線|建議走右線|兩線差不多/);
});

test('banner shows green left recommendation and gray similar (mocked API)', async ({ page }) => {
  let rec = 'left';
  await page.route('**/api/lanes*', (route) =>
    route.fulfill({
      json: {
        dir: 'S', source: 'tdx', sourceLabel: '交通部 TDX 即時 VD 資料',
        dataTime: new Date().toISOString(),
        lanes: { left: { speed: 86, vehiclesAhead: 150, slowSuspect: 0 }, right: { speed: rec === 'left' ? 70 : 84, vehiclesAhead: 160, slowSuspect: 40 } },
        recommendation: { rec, diff: rec === 'left' ? 16 : 2, held: false },
      },
    }),
  );
  await page.goto('/');
  await expect(page.locator('#banner-text')).toHaveText('建議走左線');
  await expect(page.locator('#banner')).toHaveClass(/banner-go/);
  await expect(page.locator('#lane-left')).toHaveClass(/is-rec/);
  const bg = await page.locator('#banner').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).toBe('rgb(22, 163, 74)');
  await page.screenshot({ path: `${SCREENS}/rec-left.png`, fullPage: true });

  rec = 'similar';
  await page.locator('.dir-btn[data-dir="N"]').click();
  await expect(page.locator('#banner-text')).toHaveText('兩線差不多');
  await expect(page.locator('#banner')).toHaveClass(/banner-similar/);
  await page.screenshot({ path: `${SCREENS}/similar.png`, fullPage: true });
});

test('direction toggle works and persists across reload', async ({ page }) => {
  const requested = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/lanes')) requested.push(new URL(r.url()).searchParams.get('dir'));
  });
  await page.goto('/');
  const north = page.locator('.dir-btn[data-dir="N"]');
  const south = page.locator('.dir-btn[data-dir="S"]');
  await expect(south).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#hint')).toContainText('坪林');

  await north.click();
  await expect(north).toHaveAttribute('aria-pressed', 'true');
  await expect(south).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#hint')).toContainText('頭城');
  await expect(page.locator('#hint')).toContainText('隧道內禁止變換車道');
  await expect(page.locator('#lane-left [data-field="speed"]')).toHaveText(/^\d+$/);
  expect(requested).toContain('N');
  expect(await page.evaluate(() => localStorage.getItem('xueshan-lane:dir'))).toBe('N');

  await page.reload();
  await expect(north).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#hint')).toContainText('頭城');
  await noHorizontalOverflow(page);
  await page.screenshot({ path: `${SCREENS}/northbound.png`, fullPage: true });
});

test('stale warning when data is older than 3 minutes', async ({ page }) => {
  const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  await page.route('**/api/lanes*', (route) =>
    route.fulfill({
      json: {
        dir: 'S', source: 'mock', sourceLabel: '模擬資料', dataTime: old,
        lanes: { left: { speed: 80, vehiclesAhead: 120, slowSuspect: 3 }, right: { speed: 77, vehiclesAhead: 118, slowSuspect: 10 } },
        recommendation: { rec: 'similar', diff: 3, held: false },
      },
    }),
  );
  await page.goto('/');
  await expect(page.locator('#stale')).toBeVisible();
  await expect(page.locator('#stale')).toContainText('3 分鐘');
  await noHorizontalOverflow(page);
  await page.screenshot({ path: `${SCREENS}/stale.png`, fullPage: true });
});

test('explain page reachable with key content', async ({ page }) => {
  await page.goto('/');
  await page.locator('#explain-link').click();
  await expect(page).toHaveURL(/explain\.html$/);
  await expect(page.locator('h1')).toHaveText('推估邏輯說明');
  await expect(page.locator('body')).toContainText('TDX');
  await expect(page.locator('body')).toContainText('請勿開車時操作');
  await expect(page.locator('body')).toContainText('12.9');
  await noHorizontalOverflow(page);
  await page.screenshot({ path: `${SCREENS}/explain.png`, fullPage: true });
});

test('manifest and icons are served', async ({ request }) => {
  const m = await request.get('/manifest.webmanifest');
  expect(m.ok()).toBeTruthy();
  const manifest = await m.json();
  expect(manifest.short_name).toBe('雪隧王道');
  expect(manifest.name).toContain('雪隧王道');
  expect(manifest.start_url).toBe('.');
  expect(manifest.scope).toBe('.');
  for (const icon of manifest.icons) {
    expect(icon.src.startsWith('/')).toBe(false);
    expect((await request.get(new URL(icon.src, m.url()).href)).ok()).toBeTruthy();
  }
});

const EMOJI = /\p{Extended_Pictographic}/u;

for (const path of ['/', '/explain.html']) {
  test(`no emoji in rendered text: ${path}`, async ({ page }) => {
    await page.goto(path);
    if (path === '/') await expect(page.locator('#lane-left [data-field="speed"]')).toHaveText(/^\d+$/);
    await expect(page.locator('body')).toContainText('雪隧王道');
    const text = await page.locator('body').innerText();
    const title = await page.title();
    expect(text.match(new RegExp(EMOJI.source, 'gu')) || []).toEqual([]);
    expect(title).not.toMatch(EMOJI);
  });

  test(`all asset paths are relative: ${path}`, async ({ page }) => {
    await page.goto(path);
    const abs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[src],[href]'))
        .map((el) => el.getAttribute('src') ?? el.getAttribute('href'))
        .filter((v) => v.startsWith('/')),
    );
    expect(abs).toEqual([]);
  });
}

test('app works under a sub-path base', async ({ page }) => {
  const apiPaths = [];
  // 模擬反向代理掛在 /sub/ 底下：把 /sub/* 轉送到根目錄
  await page.route('**/sub/**', async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname.startsWith('/sub/api/')) apiPaths.push(u.pathname);
    const res = await route.fetch({ url: u.origin + u.pathname.replace(/^\/sub/, '') + u.search });
    await route.fulfill({ response: res });
  });
  await page.goto('/sub/');
  await expect(page.locator('#lane-left [data-field="speed"]')).toHaveText(/^\d+$/);
  expect(apiPaths).toContain('/sub/api/lanes');
  const cssOk = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(cssOk).toBe('rgb(10, 14, 20)');
  await page.locator('#explain-link').click();
  await expect(page).toHaveURL(/\/sub\/explain\.html$/);
  await page.locator('a', { hasText: '回到雪隧王道' }).first().click();
  await expect(page).toHaveURL(/\/sub\/$/);
});
