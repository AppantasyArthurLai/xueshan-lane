'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { loadEnv } = require('./env');
const { loadTunnelConfig } = require('./config');
const { createService } = require('./service');

const WEB_ROOT = path.join(__dirname, '..', 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400).end('Bad Request');
    return;
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(WEB_ROOT, rel));
  if (!file.startsWith(WEB_ROOT + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('找不到頁面');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': ext === '.png' || ext === '.svg' ? 'public, max-age=86400' : 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

function createServer(service) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }
    if (url.pathname === '/api/lanes') {
      const dir = String(url.searchParams.get('dir') || 'S').toUpperCase();
      if (dir !== 'N' && dir !== 'S') return sendJson(res, 400, { error: 'dir 必須為 N 或 S' });
      try {
        return sendJson(res, 200, await service.getLanes(dir));
      } catch (err) {
        console.error('[api] error', err);
        return sendJson(res, 500, { error: '暫時無法取得資料' });
      }
    }
    if (url.pathname === '/api/health') return sendJson(res, 200, { ok: true, mode: service.mode });
    if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });
    return serveStatic(req, res, url.pathname);
  });
}

function main() {
  loadEnv();
  const port = Number(process.env.PORT) || 3410;
  const host = '127.0.0.1';
  const service = createService({ config: loadTunnelConfig() });
  const server = createServer(service);
  server.listen(port, host, () => {
    console.log(`[xueshan-lane] http://${host}:${port}  資料來源模式：${service.mode}`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) main();

module.exports = { createServer };
