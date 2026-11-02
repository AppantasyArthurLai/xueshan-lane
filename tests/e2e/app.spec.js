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
  // 綠色＝建議：底色以綠色為主（深綠，確保白字對比達 WCAG AA）
  const [r, g, b] = await page.locator('#banner').evaluate((el) => getComputedStyle(el).backgroundColor.match(/\d+/g).map(Number));
  expect(g).toBeGreaterThan(r + 15);
  expect(g).toBeGreaterThan(b);
  await page.screenshot({ path: `${SCREENS}/rec-left.png`, fullPage: true });

  rec = 'similar';
  await page.locator('.dir-btn[data-dir="N"]').click();
  await expect(page.locator('#banner-text')).toHaveText('兩線差不多');
  await expect(page.locator('#banner')).toHaveClass(/banner-similar/);
  const [sr, sg, sb] = await page.locator('#banner').evaluate((el) => getComputedStyle(el).backgroundColor.match(/\d+/g).map(Number));
  expect(Math.max(sr, sg, sb) - Math.min(sr, sg, sb)).toBeLessThan(16); // 灰色：不帶綠色
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

// 回歸：iPhone 上資料時間下方曾出現巨大的白色圓環（內嵌 SVG 在樣式未套用時被撐成整頁寬）
async function svgAndFooterBounds(page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const svgs = Array.from(document.querySelectorAll('svg')).map((el) => {
      const r = el.getBoundingClientRect();
      return { cls: el.getAttribute('class') || '', w: r.width, h: r.height };
    });
    const meta = document.querySelector('.meta') || document.querySelector('#data-time');
    const metaBottom = meta.getBoundingClientRect().bottom;
    const below = Array.from(document.querySelectorAll('body *'))
      .filter((el) => el.getBoundingClientRect().top >= metaBottom - 1 && el.getBoundingClientRect().height > 0)
      .map((el) => ({ tag: el.tagName, cls: el.getAttribute('class') || '', h: el.getBoundingClientRect().height }));
    return { vw, svgs, below };
  });
}

for (const blockCss of [false, true]) {
  test(`SVGs are bounded and nothing oversized below data time${blockCss ? ' (stylesheet missing / stale cache)' : ''}`, async ({ page }) => {
    if (blockCss) await page.route('**/style.css*', (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    await page.goto('/');
    await expect(page.locator('#lane-left [data-field="speed"]')).toHaveText(/^\d+$/);
    const { vw, svgs, below } = await svgAndFooterBounds(page);
    expect(svgs.length).toBeGreaterThan(0);
    for (const s of svgs) {
      if (s.cls.includes('ico') || s.cls.includes('brand-mark')) {
        expect(s.w, `icon svg .${s.cls}`).toBeLessThanOrEqual(40);
        expect(s.h, `icon svg .${s.cls}`).toBeLessThanOrEqual(40);
      } else {
        expect(s.w, `svg .${s.cls}`).toBeLessThanOrEqual(Math.min(vw, 440));
        expect(s.h, `svg .${s.cls}`).toBeLessThanOrEqual(280);
      }
    }
    // 資料時間以下只剩錯誤訊息、安全提醒與說明連結：任何元素都不該超過 120px 高
    const big = below.filter((b) => b.h > 120 && b.tag !== 'FOOTER');
    expect(big).toEqual([]);
    const foot = below.find((b) => b.tag === 'FOOTER');
    if (foot) expect(foot.h).toBeLessThanOrEqual(blockCss ? 200 : 160);
  });
}

test('explain page SVGs are bounded', async ({ page }) => {
  await page.goto('/explain.html');
  const sizes = await page.$$eval('svg', (els) => els.map((el) => el.getBoundingClientRect()).map((r) => [r.width, r.height]));
  expect(sizes.length).toBeGreaterThan(0);
  for (const [w, h] of sizes) {
    expect(w).toBeLessThanOrEqual(24);
    expect(h).toBeLessThanOrEqual(24);
  }
});

test('numbers roll to new values and respect reduced motion', async ({ browser }) => {
  for (const reducedMotion of ['no-preference', 'reduce']) {
    const ctx = await browser.newContext({ reducedMotion });
    const page = await ctx.newPage();
    let speed = 60;
    await page.route('**/api/lanes*', (route) => route.fulfill({
      json: {
        dir: 'S', source: 'tdx', sourceLabel: 'TDX', dataTime: new Date().toISOString(),
        lanes: { left: { speed, vehiclesAhead: 100, slowSuspect: 1 }, right: { speed: 80, vehiclesAhead: 90, slowSuspect: 2 } },
        recommendation: { rec: 'right', diff: speed - 80, held: false },
      },
    }));
    await page.goto('/');
    const num = page.locator('#lane-left [data-field="speed"]');
    await expect(num).toHaveText('60');
    await page.evaluate(() => {
      window.__seen = [];
      const el = document.querySelector('#lane-left [data-field="speed"]');
      new MutationObserver(() => window.__seen.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
    });
    speed = 90;
    await page.locator('.dir-btn[data-dir="N"]').click();
    await expect(num).toHaveText('90');
    const seen = await page.evaluate(() => window.__seen);
    const between = seen.filter((v) => Number(v) > 60 && Number(v) < 90);
    const anim = await page.locator('.flow-left').evaluate((el) => getComputedStyle(el).animationName);
    if (reducedMotion === 'reduce') {
      expect(between).toEqual([]);
      expect(anim).toBe('none');
    } else {
      expect(between.length).toBeGreaterThan(0);
      expect(anim).toBe('flow');
    }
    await ctx.close();
  }
});

test('tunnel ceiling streams toward viewer, tied to lane-dot speed; static under reduced motion', async ({ browser }) => {
  for (const reducedMotion of ['no-preference', 'reduce']) {
    const ctx = await browser.newContext({ reducedMotion });
    const page = await ctx.newPage();
    await page.route('**/api/lanes*', (route) => route.fulfill({
      json: {
        dir: 'S', source: 'tdx', sourceLabel: 'TDX', dataTime: new Date().toISOString(),
        lanes: { left: { speed: 80, vehiclesAhead: 100, slowSuspect: 1 }, right: { speed: 64, vehiclesAhead: 90, slowSuspect: 2 } },
        recommendation: { rec: 'left', diff: 16, held: false },
      },
    }));
    await page.goto('/');
    await expect(page.locator('#banner')).toHaveClass(/banner-left/);
    const info = await page.evaluate(() => {
      const els = [...document.querySelectorAll('.tunnel .ring, .tunnel .light')];
      const flow = document.querySelector('.flow-left');
      return {
        count: els.length,
        rings: document.querySelectorAll('.tunnel .ring').length,
        lights: document.querySelectorAll('.tunnel .light').length,
        names: els.map((el) => getComputedStyle(el).animationName),
        running: els.map((el) => el.getAnimations().filter((a) => a.playState === 'running').length),
        durs: els.map((el) => getComputedStyle(el).animationDuration),
        delays: [...new Set(els.map((el) => getComputedStyle(el).animationDelay))].length,
        flowDur: getComputedStyle(flow).animationDuration,
        flowRunning: flow.getAnimations().length,
      };
    });
    expect(info.rings).toBeGreaterThanOrEqual(4);
    expect(info.lights).toBeGreaterThanOrEqual(4);
    if (reducedMotion === 'reduce') {
      expect(info.names.every((n) => n === 'none')).toBe(true);
      expect(info.running.every((n) => n === 0)).toBe(true);
      expect(info.flowRunning).toBe(0);
    } else {
      expect(info.names.every((n) => n === 'ceiling')).toBe(true);
      expect(info.running.every((n) => n === 1)).toBe(true);
      // 160 / 80 km/h = 2s per lane-dot cycle; ceiling loop = 4 × that same --dur
      expect(info.flowDur).toBe('2s');
      expect(new Set(info.durs)).toEqual(new Set(['8s']));
      expect(info.delays).toBe(info.count); // staggered
    }
    await ctx.close();
  }
});
