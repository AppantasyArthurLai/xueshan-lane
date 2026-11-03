'use strict';
/**
 * 資料服務：選擇資料來源（TDX / 模擬）、TDX 失敗時回報 unavailable（不改用模擬）、60 秒記憶體快取、保存前次建議（遲滯用）。
 */
const mock = require('./adapters/mock');
const { createTdxAdapter } = require('./adapters/tdx');
const { summarize } = require('./estimate');

const CACHE_TTL_MS = 60 * 1000; // TDX 上游每 60 秒更新

const DIR_INFO = {
  N: { label: '北上', towards: '往台北' },
  S: { label: '南下', towards: '往宜蘭' },
};

const SOURCE_LABEL = {
  tdx: '交通部 TDX 即時 VD 資料',
  mock: '模擬資料',
  unavailable: '資料暫時無法取得（TDX 連線失敗）',
};

function createService({ env = process.env, config, now = () => Date.now(), log = console } = {}) {
  const forceMock = String(env.DATA_SOURCE || '').toLowerCase() === 'mock';
  let tdx = null;
  if (!forceMock && env.TDX_CLIENT_ID && env.TDX_CLIENT_SECRET) {
    tdx = createTdxAdapter({ clientId: env.TDX_CLIENT_ID, clientSecret: env.TDX_CLIENT_SECRET, config });
  }
  const cache = new Map(); // dir -> { at, payload }
  const inflight = new Map(); // dir -> Promise
  const prevRec = { N: null, S: null };

  async function load(dir) {
    let raw;
    let error = null;
    if (tdx) {
      try {
        raw = await tdx.fetchLanes(dir);
      } catch (err) {
        // 不靜默改用模擬資料：明確回報「資料暫時無法取得」
        error = err.message || String(err);
        log.warn?.(`[tdx] ${dir} 失敗：${error}`);
        raw = { source: 'unavailable', dir, dataTime: null, detectors: [] };
      }
    } else {
      raw = await mock.fetchLanes(dir, new Date(now()));
    }
    const { left, right, recommendation } = summarize(raw.detectors, config.tunnelLengthKm, prevRec[dir]);
    if (recommendation.rec !== 'unknown') prevRec[dir] = recommendation.rec;
    const payload = {
      dir,
      dirLabel: DIR_INFO[dir].label,
      towards: DIR_INFO[dir].towards,
      source: raw.source,
      sourceLabel: SOURCE_LABEL[raw.source] || raw.source,
      dataTime: raw.dataTime,
      generatedAt: new Date(now()).toISOString(),
      tunnelLengthKm: config.tunnelLengthKm,
      detectorCount: raw.detectors.length,
      lanes: { left, right },
      recommendation,
      estimated: true,
      note: '所有數值皆為推估，僅供參考；請勿於駕駛中操作。',
    };
    if (raw.source === 'tdx') {
      payload.srcUpdateTime = raw.srcUpdateTime;
      payload.tunnelVdCount = raw.tunnelVdCount;
      payload.laneMapVerified = config.laneMapVerified === true;
      payload.laneMapNote = config.laneMapNote;
    }
    if (error) {
      payload.error = error;
      payload.unavailable = true;
    }
    return payload;
  }

  async function getLanes(dir) {
    const hit = cache.get(dir);
    const ttl = hit?.payload.unavailable ? 15000 : CACHE_TTL_MS; // 失敗時較快重試
    if (hit && now() - hit.at < ttl) return { ...hit.payload, cached: true };
    if (inflight.has(dir)) return inflight.get(dir);
    const p = load(dir)
      .then((payload) => {
        cache.set(dir, { at: now(), payload });
        return { ...payload, cached: false };
      })
      .finally(() => inflight.delete(dir));
    inflight.set(dir, p);
    return p;
  }

  return { getLanes, mode: tdx ? 'tdx' : 'mock' };
}

module.exports = { createService, CACHE_TTL_MS, DIR_INFO };
