'use strict';
// 隧道動畫影格：node scripts/tunnel-frames.js [port]
// 啟動 mock 伺服器，iPhone 14（Chromium 模擬）下：
//   docs/screens/tunnel-frames/frame1..8.png（建議卡元素截圖，約每 150ms 一張）
//   docs/screens/home.png（首頁整頁）
//   docs/screens/tunnel.gif（若有 ffmpeg）
// 為了畫面穩定，/api/lanes 固定回傳「建議走左線」（左 80 / 右 64 km/h）。
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { chromium, devices } = require('@playwright/test');

const port = Number(process.argv[2] || 3419);
const base = `http://127.0.0.1:${port}/`;
const root = path.join(__dirname, '..');
const outDir = path.join(root, 'docs/screens/tunnel-frames');
const FRAMES = 8;
const GAP_MS = 150;

async function waitUp() {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + 'api/health')).ok) return; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const srv = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(port), DATA_SOURCE: 'mock', TDX_CLIENT_ID: '', TDX_CLIENT_SECRET: '' },
    stdio: 'ignore',
  });
  let browser;
  try {
    await waitUp();
    browser = await chromium.launch();
    const { defaultBrowserType, ...dev } = devices['iPhone 14'];
    const ctx = await browser.newContext({ ...dev });
    const page = await ctx.newPage();
    await page.route('**/api/lanes*', (route) => route.fulfill({
      json: {
        dir: 'S', source: 'mock', sourceLabel: '模擬資料（非即時）', dataTime: new Date().toISOString(),
        lanes: { left: { speed: 80, vehiclesAhead: 120, slowSuspect: 2 }, right: { speed: 64, vehiclesAhead: 150, slowSuspect: 31 } },
        recommendation: { rec: 'left', diff: 16, held: false },
      },
    }));
    await page.goto(base);
    await page.waitForFunction(() => document.querySelector('#lane-left [data-field="speed"]')?.textContent === '80');
    await page.waitForTimeout(1200); // 讓數字滾動與進場動畫結束
    const card = page.locator('#banner');
    // 元素截圖本身有耗時，以實際時間對齊 150ms 間隔
    const t0 = Date.now();
    for (let i = 1; i <= FRAMES; i++) {
      const wait = t0 + (i - 1) * GAP_MS - Date.now();
      if (wait > 0) await page.waitForTimeout(wait);
      await card.screenshot({ path: path.join(outDir, `frame${i}.png`), animations: 'allow' });
    }
    console.log(`frames: ${FRAMES} in ${Date.now() - t0}ms`);
    await page.screenshot({ path: path.join(root, 'docs/screens/home.png'), fullPage: true });
    await ctx.close();
  } finally {
    if (browser) await browser.close();
    srv.kill();
  }

  const ff = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  if (ff.status === 0) {
    const gif = path.join(root, 'docs/screens/tunnel.gif');
    const r = spawnSync('ffmpeg', [
      '-y', '-loglevel', 'error', '-framerate', String(1000 / GAP_MS), '-i', path.join(outDir, 'frame%d.png'),
      '-vf', 'scale=iw/2:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4',
      '-loop', '0', gif,
    ], { stdio: 'inherit' });
    console.log(r.status === 0 ? `gif: ${path.relative(root, gif)}` : 'gif: ffmpeg failed');
  } else {
    console.log('gif: skipped (ffmpeg not found)');
  }
})().catch((e) => { console.error(e); process.exit(1); });
