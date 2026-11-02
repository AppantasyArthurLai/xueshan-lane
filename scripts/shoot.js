'use strict';
// 設計檢查用截圖：node scripts/shoot.js <outDir> [port]
// 啟動 mock 伺服器，以 iPhone 14 / iPhone SE與桌機 1440x900（Chromium 模擬）截圖首頁與說明頁。
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { chromium, devices } = require('@playwright/test');

const out = process.argv[2] || 'docs/screens/tmp';
const port = Number(process.argv[3] || 3419);
const base = `http://127.0.0.1:${port}/`;

async function waitUp() {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + 'api/health')).ok) return; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(port), DATA_SOURCE: 'mock', TDX_CLIENT_ID: '', TDX_CLIENT_SECRET: '' },
    stdio: 'ignore',
  });
  try {
    await waitUp();
    const targets = [
      ['iphone14', chromium, { ...devices['iPhone 14'] }],
      ['iphonese', chromium, { ...devices['iPhone SE'] }],
      ['desktop', chromium, { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }],
    ];
    for (const [name, type, ctxOpts] of targets) {
      const browser = await type.launch();
      delete ctxOpts.defaultBrowserType;
      const ctx = await browser.newContext({ ...ctxOpts, reducedMotion: 'reduce' });
      const page = await ctx.newPage();
      await page.goto(base);
      await page.waitForFunction(() => /^\d+$/.test(document.querySelector('#lane-left [data-field="speed"]')?.textContent || ''));
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
      {
        // 綠色建議狀態（固定資料）
        const fixed = (rec, ageMin) => ({
          dir: 'S', source: 'tdx', sourceLabel: '交通部 TDX 即時 VD 資料',
          dataTime: new Date(Date.now() - ageMin * 60000).toISOString(),
          lanes: { left: { speed: 72, vehiclesAhead: 168, slowSuspect: 31 }, right: { speed: 88, vehiclesAhead: 121, slowSuspect: 4 } },
          recommendation: { rec, diff: -16, held: false },
        });
        for (const [suffix, rec, age] of [['rec', 'right', 0], ['stale', 'right', 10]]) {
          await page.route('**/api/lanes*', (r) => r.fulfill({ json: fixed(rec, age) }));
          await page.goto(base);
          await page.waitForFunction(() => document.querySelector('#banner')?.dataset.rec === 'right');
          await page.waitForTimeout(300);
          await page.screenshot({ path: path.join(out, `${name}-${suffix}.png`), fullPage: true });
          await page.unroute('**/api/lanes*');
        }
      }
      await page.goto(base + 'explain.html');
      await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(out, `explain-${name}.png`), fullPage: true });
      await browser.close();
    }
  } finally {
    srv.kill();
  }
})().catch((e) => { console.error(e); process.exit(1); });
