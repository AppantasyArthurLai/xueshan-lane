'use strict';
/**
 * 交通部 TDX 運輸資料流通服務 adapter。
 *  1. OAuth2 client credentials 取得 access token（快取至到期前 60 秒）
 *  2. 取得高速公路 VD 靜態資料，依 config/tunnel-vd.json 篩出國道5號雪山隧道內的偵測器（快取數小時）
 *  3. 取得 VD 即時資料（車道層級 Speed / Occupancy / Vehicles.Volume），整理成共用格式
 *
 * 注意：欄位對應（LaneID 與左右線、方向代碼、里程範圍）需在取得金鑰後以實際資料核對，
 *   請見 config/tunnel-vd.json 與 README。
 */

const TOKEN_URL = 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';
const API_BASE = 'https://tdx.transportdata.tw/api/basic';
const LIVE_URL = `${API_BASE}/v2/Road/Traffic/Live/VD/Freeway?$format=JSON`;
const STATIC_URL = `${API_BASE}/v2/Road/Traffic/VD/Freeway?$format=JSON`;
const TIMEOUT_MS = 15000;

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

/** 從 VDID 推方向，例如 "VD-N5-S-20.000-M-LOOP" → 'S' */
function directionFromVdid(vdid) {
  const m = String(vdid || '').match(/-N5-([NS])-/i);
  return m ? m[1].toUpperCase() : null;
}

function vdDirectionCode(vd) {
  const link = Array.isArray(vd.DetectionLinks) ? vd.DetectionLinks[0] : null;
  const code = vd.RoadDirection ?? link?.RoadDirection ?? vd.Direction ?? null;
  return code != null ? String(code).toUpperCase() : null;
}

function vdMileageKm(vd) {
  return parseMileageKm(vd.LocationMile ?? vd.Mileage ?? vd.DetectionLinks?.[0]?.LocationMile);
}

function isFreeway5(vd, cfg) {
  if (cfg.roadId && vd.RoadID === cfg.roadId) return true;
  if (cfg.roadNameIncludes && typeof vd.RoadName === 'string' && vd.RoadName.includes(cfg.roadNameIncludes)) return true;
  if (cfg.vdidIncludes && String(vd.VDID || '').includes(cfg.vdidIncludes)) return true;
  return false;
}

/**
 * 依設定篩出隧道內 VD，回傳 { N: [{vdid, mileageKm}], S: [...] }。
 * 若 explicitVDIDs 有填，該方向直接使用清單。
 */
function selectTunnelVDs(staticList, cfg) {
  const out = { N: [], S: [] };
  const { from, to } = cfg.mileageRangeKm;
  for (const dir of ['N', 'S']) {
    const explicit = cfg.explicitVDIDs?.[dir] || [];
    if (explicit.length) {
      const byId = new Map(staticList.map((v) => [v.VDID, v]));
      out[dir] = explicit.map((id) => ({ vdid: id, mileageKm: byId.has(id) ? vdMileageKm(byId.get(id)) : null }));
    }
  }
  for (const vd of staticList) {
    if (!isFreeway5(vd, cfg)) continue;
    const km = vdMileageKm(vd);
    if (km == null || km < from || km > to) continue;
    const code = vdDirectionCode(vd);
    let dir = null;
    for (const d of ['N', 'S']) {
      if (code && cfg.directions[d].codes.map(String).includes(code)) dir = d;
    }
    dir = dir || directionFromVdid(vd.VDID);
    if (!dir || (cfg.explicitVDIDs?.[dir] || []).length) continue;
    out[dir].push({ vdid: vd.VDID, mileageKm: km });
  }
  for (const d of ['N', 'S']) out[d].sort((a, b) => (a.mileageKm ?? 0) - (b.mileageKm ?? 0));
  return out;
}

/** 將單一 VDLive 轉成 { left, right } 車道樣本 */
function lanesFromLive(live, cfg) {
  const interval = cfg.sampleIntervalSec || 60;
  const acc = {};
  for (const link of live.LinkFlows || []) {
    for (const lane of link.Lanes || []) {
      const side = cfg.laneMap[String(lane.LaneID)];
      if (!side) continue;
      const speed = Number(lane.Speed);
      if (!Number.isFinite(speed) || speed < 0) continue; // -99 等為無效值
      const volume = (lane.Vehicles || []).reduce((a, v) => {
        const n = Number(v.Volume);
        return a + (Number.isFinite(n) && n >= 0 ? n : 0);
      }, 0);
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

function createTdxAdapter({ clientId, clientSecret, config, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
  if (!clientId || !clientSecret) throw new Error('TDX_CLIENT_ID / TDX_CLIENT_SECRET 未設定');
  let token = null; // { value, expiresAt }
  let staticCache = null; // { at, selection }

  async function getToken() {
    if (token && token.expiresAt > now()) return token.value;
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
    const ttl = Number(json.expires_in) || 3600;
    token = { value: json.access_token, expiresAt: now() + Math.max(60, ttl - 60) * 1000 };
    return token.value;
  }

  async function getJson(url) {
    const t = await getToken();
    const res = await fetchImpl(url, {
      headers: { authorization: `Bearer ${t}`, accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401) token = null;
    if (!res.ok) throw new Error(`TDX HTTP ${res.status} ${url}`);
    return res.json();
  }

  async function getSelection() {
    const maxAge = (config.staticCacheHours || 6) * 3600 * 1000;
    if (staticCache && now() - staticCache.at < maxAge) return staticCache.selection;
    const json = await getJson(STATIC_URL);
    const selection = selectTunnelVDs(listOf(json, 'VDs', 'VDList'), config);
    staticCache = { at: now(), selection };
    return selection;
  }

  async function fetchLanes(dir) {
    const selection = await getSelection();
    const wanted = selection[dir] || [];
    if (!wanted.length) throw new Error(`找不到 ${dir} 向雪隧 VD（請核對 config/tunnel-vd.json）`);
    const json = await getJson(LIVE_URL);
    const lives = new Map(listOf(json, 'VDLives').map((l) => [l.VDID, l]));
    const detectors = [];
    let latest = 0;
    for (const w of wanted) {
      const live = lives.get(w.vdid);
      if (!live || (live.Status != null && Number(live.Status) !== 0)) continue;
      const lanes = lanesFromLive(live, config);
      if (!lanes.left && !lanes.right) continue;
      const t = Date.parse(live.DataCollectTime);
      if (Number.isFinite(t)) latest = Math.max(latest, t);
      detectors.push({ id: w.vdid, mileageKm: w.mileageKm, lanes });
    }
    if (!detectors.length) throw new Error('雪隧 VD 目前無有效即時資料');
    const updateTime = Date.parse(json.UpdateTime);
    return {
      source: 'tdx',
      dir,
      dataTime: new Date(latest || (Number.isFinite(updateTime) ? updateTime : now())).toISOString(),
      detectors,
    };
  }

  return { fetchLanes, getToken, getSelection };
}

module.exports = {
  createTdxAdapter,
  selectTunnelVDs,
  lanesFromLive,
  parseMileageKm,
  directionFromVdid,
  TOKEN_URL,
  LIVE_URL,
  STATIC_URL,
};
