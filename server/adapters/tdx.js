'use strict';
/**
 * 交通部 TDX 運輸資料流通服務 adapter（2026-11-03 以實際資料核對）。
 *  1. OAuth2 client credentials 取得 access token：快取至到期前 1 小時（效期 24h），遇 401 清除並重試一次。
 *  2. 每次刷新只呼叫一次 Live/VD/Freeway?$filter=contains(VDID,'-N5-')，南北兩方向共用（伺服器快取 60 秒）。
 *  3. 直接由 VDID（VD-N5-{N|S}-{里程}-M-…）解析方向與里程，篩出雪隧內偵測器；不再需要 VD 靜態清單。
 *
 * LaneID 0 = 左線（內側）僅依 TDX 規格，尚未以現場影像驗證（config.laneMapVerified=false）。
 */

const TOKEN_URL = 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';
const API_BASE = 'https://tdx.transportdata.tw/api/basic';
const LIVE_URL = `${API_BASE}/v2/Road/Traffic/Live/VD/Freeway?$filter=${encodeURIComponent("contains(VDID,'-N5-')")}&$format=JSON`;
const TIMEOUT_MS = 15000;
const LIVE_TTL_MS = 60 * 1000;
const TOKEN_EARLY_REFRESH_MS = 3600 * 1000;
const MIN_INTERVAL_MS = 250; // ≤ 4 req/s（TDX 上限 5 req/s）

/** 解析里程："15K+200" / "15.2" / 15.2 → 15.2（公里） */
function parseMileageKm(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim().toUpperCase();
  const m = s.match(/^(\d+)\s*K\s*\+?\s*(\d+(?:\.\d+)?)?/);
  if (m) return Number(m[1]) + (m[2] ? Number(m[2]) / 1000 : 0);
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** "VD-N5-S-20.412-M-LOOP" → { dir:'S', mileageKm:20.412 } */
function parseVdid(vdid) {
  const m = String(vdid || '').match(/-N5-([NS])-(\d+(?:\.\d+)?)-M/i);
  return m ? { dir: m[1].toUpperCase(), mileageKm: Number(m[2]) } : null;
}

function directionFromVdid(vdid) {
  return parseVdid(vdid)?.dir ?? null;
}

function rangeFor(cfg, dir) {
  return cfg.directions?.[dir]?.mileageRangeKm || cfg.mileageRangeKm;
}

/** 由 VDLive 清單篩出雪隧內 VD，回傳 { N: [live...], S: [live...] }（依里程排序） */
function selectTunnelLives(lives, cfg) {
  const out = { N: [], S: [] };
  for (const live of lives || []) {
    const p = parseVdid(live.VDID);
    if (!p) continue;
    const explicit = cfg.explicitVDIDs?.[p.dir] || [];
    if (explicit.length) {
      if (!explicit.includes(live.VDID)) continue;
    } else {
      const { from, to } = rangeFor(cfg, p.dir);
      if (p.mileageKm < from || p.mileageKm > to) continue;
    }
    out[p.dir].push({ ...live, _mileageKm: p.mileageKm });
  }
  for (const d of ['N', 'S']) out[d].sort((a, b) => a._mileageKm - b._mileageKm);
  return out;
}

/** 將單一 VDLive 轉成 { left, right } 車道樣本；排除 ErrorType 非 diag0、速度無效者 */
function lanesFromLive(live, cfg) {
  const interval = cfg.sampleIntervalSec || 60;
  const acc = {};
  for (const link of live.LinkFlows || []) {
    for (const lane of link.Lanes || []) {
      const side = cfg.laneMap[String(lane.LaneID)];
      if (!side) continue;
      if (lane.ErrorType != null && lane.ErrorType !== 'diag0') continue;
      const speed = Number(lane.Speed);
      if (!Number.isFinite(speed) || speed < 0) continue; // -99 等為無效值
      const volume = (lane.Vehicles || []).reduce((a, v) => {
        const n = Number(v.Volume);
        return a + (Number.isFinite(n) && n >= 0 ? n : 0);
      }, 0);
      if (speed === 0 && volume === 0) continue; // 無車，不是塞車
      const occ = Number(lane.Occupancy);
      acc[side] = {
        speed,
        volume,
        flowPerHour: (volume * 3600) / interval,
        occupancy: Number.isFinite(occ) && occ >= 0 ? occ : null,
      };
    }
  }
  return acc;
}

function listOf(json, ...keys) {
  if (Array.isArray(json)) return json;
  for (const k of keys) if (Array.isArray(json?.[k])) return json[k];
  return [];
}

/** 純函式：把一次 VDLive 回應轉成兩方向的偵測器樣本 */
function parseLive(json, cfg, nowMs = Date.now()) {
  const sel = selectTunnelLives(listOf(json, 'VDLives'), cfg);
  const updateTime = Date.parse(json?.UpdateTime);
  const srcUpdateTime = Date.parse(json?.SrcUpdateTime);
  const result = {};
  for (const dir of ['N', 'S']) {
    const detectors = [];
    let latest = 0;
    let skipped = 0;
    for (const live of sel[dir]) {
      if (live.Status != null && Number(live.Status) !== 0) { skipped++; continue; }
      const lanes = lanesFromLive(live, cfg);
      if (!lanes.left && !lanes.right) { skipped++; continue; }
      const t = Date.parse(live.DataCollectTime);
      if (Number.isFinite(t)) latest = Math.max(latest, t);
      detectors.push({ id: live.VDID, mileageKm: live._mileageKm, lanes });
    }
    result[dir] = {
      source: 'tdx',
      dir,
      dataTime: new Date(latest || (Number.isFinite(updateTime) ? updateTime : nowMs)).toISOString(),
      srcUpdateTime: Number.isFinite(srcUpdateTime) ? new Date(srcUpdateTime).toISOString() : null,
      tunnelVdCount: sel[dir].length,
      skipped,
      detectors,
    };
  }
  return result;
}

function createTdxAdapter({ clientId, clientSecret, config, fetchImpl = globalThis.fetch, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  if (!clientId || !clientSecret) throw new Error('TDX_CLIENT_ID / TDX_CLIENT_SECRET 未設定');
  let token = null; // { value, expiresAt }
  let liveCache = null; // { at, parsed }
  let inflight = null;
  let lastCallAt = 0;
  const stats = { tokenRequests: 0, apiCalls: 0 };

  async function throttle() {
    const wait = lastCallAt + MIN_INTERVAL_MS - now();
    if (wait > 0) await sleep(wait);
    lastCallAt = now();
  }

  async function getToken() {
    if (token && token.expiresAt > now()) return token.value;
    await throttle();
    stats.tokenRequests++;
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret });
    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`TDX token HTTP ${res.status}`);
    const json = await res.json();
    if (!json.access_token) throw new Error('TDX token 回應缺少 access_token');
    const ttlMs = (Number(json.expires_in) || 3600) * 1000;
    const early = Math.min(TOKEN_EARLY_REFRESH_MS, ttlMs / 2);
    token = { value: json.access_token, expiresAt: now() + Math.max(60000, ttlMs - early) };
    return token.value;
  }

  async function getJson(url, retried = false) {
    const t = await getToken();
    await throttle();
    stats.apiCalls++;
    const res = await fetchImpl(url, {
      headers: { authorization: `Bearer ${t}`, accept: 'application/json', 'accept-encoding': 'gzip' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401) {
      token = null;
      if (!retried) return getJson(url, true);
    }
    if (!res.ok) throw new Error(`TDX HTTP ${res.status}`);
    return res.json();
  }

  /** 取得兩方向資料（共用一次呼叫，快取 60 秒） */
  async function fetchBoth() {
    if (liveCache && now() - liveCache.at < LIVE_TTL_MS) return liveCache.parsed;
    if (inflight) return inflight;
    inflight = getJson(LIVE_URL)
      .then((json) => {
        const parsed = parseLive(json, config, now());
        liveCache = { at: now(), parsed };
        return parsed;
      })
      .finally(() => { inflight = null; });
    return inflight;
  }

  async function fetchLanes(dir) {
    const both = await fetchBoth();
    const r = both[dir];
    if (!r || !r.detectors.length) throw new Error('雪隧 VD 目前無有效即時資料');
    return r;
  }

  return { fetchLanes, fetchBoth, getToken, stats };
}

module.exports = {
  createTdxAdapter,
  selectTunnelLives,
  lanesFromLive,
  parseLive,
  parseVdid,
  parseMileageKm,
  directionFromVdid,
  TOKEN_URL,
  LIVE_URL,
  LIVE_TTL_MS,
};
