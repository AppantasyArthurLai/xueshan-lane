#!/usr/bin/env node
'use strict';
/**
 * TDX 即時資料驗證腳本：抓一次國5 VDLive（1 次 API 呼叫 + 必要時 1 次換權杖），
 * 核對雪隧 VD 數量、里程、車道數，輸出兩方向左右線推估車速，
 * 寫入 data/verify/<時間>.json（不含任何金鑰/權杖），並與前一次紀錄比對差異。
 * 用法：node scripts/verify-tdx.js   （金鑰讀自 .env 或環境變數）
 */
const fs = require('node:fs');
const path = require('node:path');
const { loadEnv } = require('../server/env');
const { loadTunnelConfig } = require('../server/config');
const tdx = require('../server/adapters/tdx');
const { summarize } = require('../server/estimate');

const LOG_DIR = path.join(__dirname, '..', 'data', 'verify');

function laneCounts(json, dir) {
  const counts = {};
  for (const v of json.VDLives || []) {
    const p = tdx.parseVdid(v.VDID);
    if (!p || p.dir !== dir) continue;
    const n = (v.LinkFlows || []).reduce((a, l) => a + (l.Lanes || []).length, 0);
    counts[v.VDID] = n;
  }
  return counts;
}

async function main() {
  loadEnv();
  const config = loadTunnelConfig();
  const { TDX_CLIENT_ID: id, TDX_CLIENT_SECRET: sec } = process.env;
  if (!id || !sec) throw new Error('缺少 TDX_CLIENT_ID / TDX_CLIENT_SECRET');
  let rawJson;
  const fetchImpl = async (url, opts) => {
    const res = await fetch(url, opts);
    if (url === tdx.LIVE_URL && res.ok) {
      const j = await res.json();
      rawJson = j;
      return { ok: true, status: res.status, json: async () => j };
    }
    return res;
  };
  const adapter = tdx.createTdxAdapter({ clientId: id, clientSecret: sec, config, fetchImpl });
  const both = await adapter.fetchBoth();
  const checks = [];
  const run = { runAt: new Date().toISOString(), updateTime: rawJson.UpdateTime, srcUpdateTime: rawJson.SrcUpdateTime, totalN5Vds: (rawJson.VDLives || []).length, directions: {}, checks, apiCalls: adapter.stats };
  for (const dir of ['N', 'S']) {
    const r = both[dir];
    const exp = config.directions[dir].expectedVdCount;
    const s = summarize(r.detectors, config.tunnelLengthKm);
    const ids = r.detectors.map((d) => d.id);
    const lc = laneCounts(rawJson, dir);
    const tunnelIds = Object.keys(lc).filter((k) => { const km = tdx.parseVdid(k).mileageKm; const g = config.directions[dir].mileageRangeKm; return km >= g.from && km <= g.to; });
    const non2 = tunnelIds.filter((k) => lc[k] !== 2);
    checks.push({ name: `${dir} tunnel VD count = ${exp}`, ok: r.tunnelVdCount === exp, actual: r.tunnelVdCount });
    checks.push({ name: `${dir} every tunnel VD has 2 lanes`, ok: non2.length === 0, actual: non2 });
    checks.push({ name: `${dir} valid detectors ≥ 80%`, ok: r.detectors.length >= 0.8 * r.tunnelVdCount, actual: r.detectors.length });
    const ageMin = (Date.now() - Date.parse(r.dataTime)) / 60000;
    checks.push({ name: `${dir} data age < 10 min`, ok: ageMin < 10, actual: Math.round(ageMin * 10) / 10 });
    run.directions[dir] = {
      dataTime: r.dataTime,
      tunnelVdCount: r.tunnelVdCount,
      validDetectors: r.detectors.length,
      skipped: r.skipped,
      firstVd: ids[0], lastVd: ids.at(-1),
      left: { speed: s.left.speed, samples: s.left.samples, vehiclesAhead: s.left.vehiclesAhead },
      right: { speed: s.right.speed, samples: s.right.samples, vehiclesAhead: s.right.vehiclesAhead },
      recommendation: s.recommendation,
      vdids: ids,
    };
  }
  run.laneMapVerified = config.laneMapVerified === true;
  run.allOk = checks.every((c) => c.ok);

  fs.mkdirSync(LOG_DIR, { recursive: true });
  const prevFile = fs.readdirSync(LOG_DIR).filter((f) => f.endsWith('.json')).sort().at(-1);
  const file = path.join(LOG_DIR, run.runAt.replace(/[:.]/g, '-') + '.json');
  const text = JSON.stringify(run, null, 2);
  if (text.includes(sec) || text.includes(id)) throw new Error('紀錄含金鑰，拒絕寫入');
  fs.writeFileSync(file, text + '\n');

  console.log(`run ${run.runAt}  TDX UpdateTime ${run.updateTime}  N5 VDs ${run.totalN5Vds}`);
  for (const dir of ['N', 'S']) {
    const d = run.directions[dir];
    console.log(`${dir}: ${d.validDetectors}/${d.tunnelVdCount} VD  ${d.firstVd} … ${d.lastVd}  dataTime ${d.dataTime}  左線 ${d.left.speed} km/h  右線 ${d.right.speed} km/h  → ${d.recommendation.rec}`);
  }
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  (${JSON.stringify(c.actual)})`);
  if (prevFile) {
    const prev = JSON.parse(fs.readFileSync(path.join(LOG_DIR, prevFile), 'utf8'));
    console.log(`diff vs ${prevFile}:`);
    for (const dir of ['N', 'S']) {
      const a = prev.directions[dir], b = run.directions[dir];
      const added = b.vdids.filter((x) => !a.vdids.includes(x));
      const removed = a.vdids.filter((x) => !b.vdids.includes(x));
      console.log(`  ${dir}: VD ${a.tunnelVdCount}→${b.tunnelVdCount}${added.length ? ' +' + added.join(',') : ''}${removed.length ? ' -' + removed.join(',') : ''}  左 ${a.left.speed}→${b.left.speed}  右 ${a.right.speed}→${b.right.speed}  建議 ${a.recommendation.rec}→${b.recommendation.rec}`);
    }
    const prevChecks = new Map(prev.checks.map((c) => [c.name, c.ok]));
    for (const c of checks) if (prevChecks.has(c.name) && prevChecks.get(c.name) !== c.ok) console.log(`  check changed: ${c.name} ${prevChecks.get(c.name)}→${c.ok}`);
  } else {
    console.log('（第一次執行，無前次紀錄可比對）');
  }
  console.log(`log: ${path.relative(process.cwd(), file)}`);
  process.exitCode = run.allOk ? 0 : 1;
}

main().catch((e) => { console.error('verify failed:', e.message); process.exitCode = 2; });
