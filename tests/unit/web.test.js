'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{20E3}]/gu;
const TEXT_FILES = [
  'web/index.html', 'web/explain.html', 'web/app.js', 'web/style.css', 'web/manifest.webmanifest',
  'web/icons/icon.svg', 'README.md', 'package.json', 'server/service.js', 'server/index.js',
];

test('no emoji / pictographs in web, README, manifest, server labels', () => {
  for (const f of TEXT_FILES) assert.deepEqual(read(f).match(EMOJI) || [], [], f);
});

test('product name is 雪隧王道 everywhere, old name gone', () => {
  for (const f of ['web/index.html', 'web/explain.html', 'web/manifest.webmanifest', 'README.md']) {
    assert.match(read(f), /雪隧王道/, f);
    assert.doesNotMatch(read(f), /雪隧車道/, f);
  }
  const m = JSON.parse(read('web/manifest.webmanifest'));
  assert.equal(m.short_name, '雪隧王道');
});

test('asset, API and manifest paths are relative', () => {
  for (const f of ['web/index.html', 'web/explain.html']) {
    assert.deepEqual(read(f).match(/(?:src|href)="\/[^"]*"/g) || [], [], f);
  }
  assert.doesNotMatch(read('web/app.js'), /fetch\(\s*[`'"]\//);
  const m = JSON.parse(read('web/manifest.webmanifest'));
  assert.equal(m.start_url, '.');
  assert.equal(m.scope, '.');
  for (const i of m.icons) assert.ok(!i.src.startsWith('/'), i.src);
});

test('every inline SVG declares width/height so it cannot blow up without CSS', () => {
  for (const f of ['web/index.html', 'web/explain.html']) {
    const svgs = read(f).match(/<svg\b[^>]*>/g) || [];
    assert.ok(svgs.length > 0, f);
    for (const tag of svgs) {
      assert.match(tag, /\swidth="\d+"/, `${f}: ${tag}`);
      assert.match(tag, /\sheight="\d+"/, `${f}: ${tag}`);
    }
  }
});

test('stylesheet and script URLs are versioned (cache-busting)', () => {
  for (const f of ['web/index.html', 'web/explain.html']) {
    assert.match(read(f), /href="style\.css\?v=\w+"/, f);
  }
  assert.match(read('web/index.html'), /src="app\.js\?v=\w+"/);
});
