'use strict';
/**
 * 模擬資料來源：未設定 TDX 金鑰時使用。
 * 產生隨時間變化、各車道的速度 / 流量 / 佔有率，並偶爾在右線出現慢速大車車隊。
 * 同一分鐘內的輸出是決定性的（以分鐘為種子），方便除錯。
 */

const DETECTOR_MILEAGES_KM = [15.6, 16.8, 18.0, 19.2, 20.4, 21.6, 22.8, 24.0, 25.2, 26.4, 27.6];
const LANE_CAPACITY = 1500; // 輛/小時/車道（隧道內約略容量）

function hashStr(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seedStr) {
  let a = hashStr(seedStr);
  return function mulberry32() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 台北時間（UTC+8，無日光節約）的星期與小時（含小數） */
function taipeiClock(date) {
  const t = new Date(date.getTime() + 8 * 3600 * 1000);
  return { day: t.getUTCDay(), hour: t.getUTCHours() + t.getUTCMinutes() / 60 };
}

function bump(hour, center, width) {
  const d = (hour - center) / width;
  return Math.exp(-d * d);
}

/** 需求強度（0–1.1），依方向、星期、時段 */
function demand(dir, date) {
  const { day, hour } = taipeiClock(date);
  const night = hour < 5 ? 0.08 : 0;
  let d = 0.12 + 0.35 * bump(hour, 9, 3) + 0.35 * bump(hour, 17.5, 3) - night;
  const weekend = day === 0 || day === 6;
  if (dir === 'S') {
    if (day === 6) d += 0.6 * bump(hour, 9.5, 2.5); // 週六上午南下
    if (day === 5) d += 0.35 * bump(hour, 19, 2.5); // 週五晚上南下
  } else {
    if (day === 0) d += 0.65 * bump(hour, 17, 3); // 週日下午北上
    if (day === 1) d += 0.25 * bump(hour, 7, 1.5); // 週一清晨北上
  }
  if (weekend) d += 0.1;
  return Math.max(0.05, Math.min(1.1, d));
}

/** 速度-需求關係（簡化）：接近容量時車速明顯下降 */
function speedFromDemand(freeFlow, d) {
  if (d < 0.85) return freeFlow * (1 - 0.25 * Math.pow(d / 0.85, 3));
  // 超過約 85% 容量：開始走走停停
  const over = Math.min(1, (d - 0.85) / 0.25);
  return freeFlow * 0.75 * (1 - 0.6 * over);
}

function laneSample(speed, flowPerHour, rand, intervalSec = 60) {
  const s = Math.max(8, Math.round(speed));
  const q = Math.max(0, Math.round(flowPerHour));
  const dens = q / Math.max(s, 5);
  // 佔有率 ≈ 密度 × 有效車長（約 6.5 公尺）
  const occupancy = Math.min(95, Math.round(dens * 0.65 * (0.9 + rand() * 0.2)));
  return {
    speed: s,
    flowPerHour: q,
    occupancy,
    volume: Math.round((q * intervalSec) / 3600),
  };
}

/**
 * @param {'N'|'S'} dir
 * @param {Date} [now]
 */
function generate(dir, now = new Date()) {
  const minute = Math.floor(now.getTime() / 60000);
  const dataTime = new Date(minute * 60000);
  const d0 = demand(dir, dataTime);
  // 平滑擾動
  const wobble = 1 + 0.07 * Math.sin(minute / 9 + (dir === 'N' ? 1 : 0)) + 0.04 * Math.sin(minute / 3.7);
  const d = Math.min(1.12, d0 * wobble);

  // 慢車車隊：每 8 分鐘一個時窗，約 35% 機率在右線出現，並隨時間往前移動
  const win = Math.floor(minute / 8);
  const pr = rng(`platoon:${dir}:${win}`);
  const platoon = pr() < 0.35 && d < 0.95;
  const platoonStart = Math.floor(pr() * 6);
  const platoonHead = platoonStart + (minute % 8) * 0.6;
  const platoonLen = 2 + Math.floor(pr() * 3);
  const platoonSpeed = 48 + pr() * 12;

  // 兩線間緩慢變化的速度偏差（有時左線較快、有時右線較快）
  const laneBias = 4 * Math.sin(minute / 23 + (dir === 'N' ? 2 : 0)) + 2 * Math.sin(minute / 61);

  const ordered = dir === 'S' ? DETECTOR_MILEAGES_KM : [...DETECTOR_MILEAGES_KM].reverse();
  const detectors = ordered.map((km, idx) => {
    const r = rng(`det:${dir}:${minute}:${idx}`);
    const local = 1 + (r() - 0.5) * 0.12;
    // 左線（內側）略快、流量略高；右線有較多大車
    let leftSpeed = speedFromDemand(89, d * local * 1.03) + laneBias + (r() - 0.5) * 6;
    let rightSpeed = speedFromDemand(86, d * local * 0.96) - laneBias + (r() - 0.5) * 6;
    let leftFlow = LANE_CAPACITY * Math.min(1, d) * 1.02 * local;
    let rightFlow = LANE_CAPACITY * Math.min(1, d) * 0.92 * local;

    const inPlatoon = platoon && idx <= platoonHead && idx > platoonHead - platoonLen;
    if (inPlatoon) {
      rightSpeed = Math.min(rightSpeed, platoonSpeed + (r() - 0.5) * 4);
      rightFlow *= 0.8;
      leftSpeed -= 2; // 輕微影響
    }
    const id = `MOCK-N5-${dir}-${km.toFixed(1)}`;
    return {
      id,
      mileageKm: km,
      lanes: {
        left: laneSample(Math.min(leftSpeed, 98), leftFlow, r),
        right: laneSample(Math.min(rightSpeed, 95), rightFlow, r),
      },
    };
  });

  return {
    source: 'mock',
    dir,
    dataTime: dataTime.toISOString(),
    detectors,
  };
}

async function fetchLanes(dir, now = new Date()) {
  return generate(dir, now);
}

module.exports = { fetchLanes, generate, demand, DETECTOR_MILEAGES_KM };
