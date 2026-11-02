'use strict';
const fs = require('node:fs');
const path = require('node:path');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'tunnel-vd.json');

function loadTunnelConfig(file = CONFIG_PATH) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

module.exports = { loadTunnelConfig, CONFIG_PATH };
