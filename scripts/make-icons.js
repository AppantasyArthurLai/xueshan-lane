'use strict';
// 由 web/icons/icon.svg 產生 PNG 圖示（使用 Playwright chromium）。用法：node scripts/make-icons.js
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('@playwright/test');

(async () => {
  const dir = path.join(__dirname, '..', 'web', 'icons');
  const svg = fs.readFileSync(path.join(dir, 'icon.svg'), 'utf8');
  const browser = await chromium.launch();
  for (const size of [192, 512, 180]) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
    const name = size === 180 ? 'apple-touch-icon.png' : `icon-${size}.png`;
    await page.screenshot({ path: path.join(dir, name), omitBackground: true });
    await page.close();
  }
  await browser.close();
  console.log('icons written');
})();
