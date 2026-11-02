'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../../server/index');
const { createService } = require('../../server/service');
const { loadTunnelConfig } = require('../../server/config');

test('HTTP: /api/lanes, static files, traversal guard', async (t) => {
  const server = createServer(createService({ env: {}, config: loadTunnelConfig() }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const api = await fetch(`${base}/api/lanes?dir=N`);
  assert.equal(api.status, 200);
  const body = await api.json();
  assert.equal(body.dir, 'N');
  assert.equal(body.estimated, true);
  assert.ok(['left', 'right', 'similar', 'unknown'].includes(body.recommendation.rec));

  assert.equal((await fetch(`${base}/api/lanes?dir=X`)).status, 400);

  const html = await fetch(`${base}/`);
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-type'), /text\/html/);
  assert.match(await html.text(), /雪隧王道/);

  assert.equal((await fetch(`${base}/manifest.webmanifest`)).status, 200);
  assert.equal((await fetch(`${base}/..%2fpackage.json`)).status, 403);
  assert.equal((await fetch(`${base}/nope.html`)).status, 404);
});
