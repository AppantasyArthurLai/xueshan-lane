'use strict';
/**
 * 推估邏輯（純函式，無 I/O）。
 * 所有輸出數值皆為「推估」，並非實際量測的車輛數。
 *
 * 單一樣本（某偵測器某車道一次回報）格式：
 *   { speed: km/h, flowPerHour: 輛/小時, occupancy: %（0–100）}
 */

const TUNNEL_LENGTH_KM = 12.9;
const SLOW_SPEED_KMH = 60; // 低於此速度視為「慢」
const HIGH_OCCUPANCY_PCT = 25; // 高於此佔有率視為壅塞/慢車
const MIN_SPEED_KMH = 5; // 避免除以 0
const JAM_DENSITY_PER_KM = 140; // 單車道擁塞密度上限（輛/公里）

const SIMILAR_THRESHOLD = 5; // |差距| < 5 km/h → 兩線差不多
const SWITCH_THRESHOLD = 8; // 從一線改建議另一線需差距 > 8 km/h

function isValidSample(s) {
  return (
    s != null &&
    Number.isFinite(s.speed) &&
    s.speed >= 0 &&
    s.speed < 200 &&
    Number.isFinite(s.flowPerHour) &&
    s.flowPerHour >= 0
  );
}

function round1(x) {
  return Math.round(x * 10) / 10;
}

/** 單一樣本是否「疑似慢車」：速度 < 60 或佔有率偏高 */
function isSlowSample(s) {
  return s.speed < SLOW_SPEED_KMH || (Number.isFinite(s.occupancy) && s.occupancy >= HIGH_OCCUPANCY_PCT);
}

/** 密度（輛/公里）= 流量（輛/小時）÷ 速度（公里/小時），並限制於擁塞密度上限 */
function density(flowPerHour, speed) {
  const v = Math.max(speed, MIN_SPEED_KMH);
  return Math.min(flowPerHour / v, JAM_DENSITY_PER_KM);
}

/**
 * 加權平均車速：以流量為權重（流量 0 時退回一般平均）。
 */
function weightedSpeed(samples) {
  const valid = samples.filter(isValidSample);
  if (valid.length === 0) return null;
  const totalFlow = valid.reduce((a, s) => a + s.flowPerHour, 0);
  if (totalFlow > 0) {
    return valid.reduce((a, s) => a + s.speed * s.flowPerHour, 0) / totalFlow;
  }
  return valid.reduce((a, s) => a + s.speed, 0) / valid.length;
}

/**
 * 彙整單一車道的所有樣本。
 * @returns {{speed:number|null, vehiclesAhead:number|null, slowSuspect:number|null,
 *            density:number|null, slowFraction:number|null, samples:number, estimated:true}}
 */
function aggregateLane(samples, tunnelLengthKm = TUNNEL_LENGTH_KM) {
  const valid = (samples || []).filter(isValidSample);
  if (valid.length === 0) {
    return { speed: null, vehiclesAhead: null, slowSuspect: null, density: null, slowFraction: null, samples: 0, estimated: true };
  }
  const speed = weightedSpeed(valid);
  // 每個偵測器代表隧道內一段，平均各點密度 × 隧道長度 ≈ 整條車道上的車輛數
  const avgDensity = valid.reduce((a, s) => a + density(s.flowPerHour, s.speed), 0) / valid.length;
  const vehiclesAhead = Math.round(avgDensity * tunnelLengthKm);
  const slowFraction = valid.filter(isSlowSample).length / valid.length;
  const slowSuspect = Math.round(slowFraction * vehiclesAhead);
  return {
    speed: Math.round(speed),
    vehiclesAhead,
    slowSuspect,
    density: round1(avgDensity),
    slowFraction: Math.round(slowFraction * 100) / 100,
    samples: valid.length,
    estimated: true,
  };
}

/**
 * 依兩線平均車速給建議，含遲滯（hysteresis）避免來回跳動。
 *  - |差距| < 5 km/h → 'similar'（兩線差不多）
 *  - 前次建議為某一線，而另一線較快：差距需 > 8 km/h 才改建議，否則維持前次（held=true）
 *  - 其他情況 → 較快的那一線
 * @param {{speed:number|null}} left
 * @param {{speed:number|null}} right
 * @param {'left'|'right'|'similar'|null|undefined} prev 前次建議
 * @returns {{rec:'left'|'right'|'similar'|'unknown', diff:number|null, held:boolean}}
 */
function recommend(left, right, prev) {
  const l = left && Number.isFinite(left.speed) ? left.speed : null;
  const r = right && Number.isFinite(right.speed) ? right.speed : null;
  if (l == null || r == null) return { rec: 'unknown', diff: null, held: false };
  const diff = l - r; // 正值：左線較快
  const abs = Math.abs(diff);
  if (abs < SIMILAR_THRESHOLD) return { rec: 'similar', diff, held: false };
  const faster = diff > 0 ? 'left' : 'right';
  if ((prev === 'left' || prev === 'right') && prev !== faster && abs <= SWITCH_THRESHOLD) {
    return { rec: prev, diff, held: true };
  }
  return { rec: faster, diff, held: false };
}

/** 將偵測器資料（含 left/right 車道）拆成兩線樣本並彙整 */
function summarize(detectors, tunnelLengthKm = TUNNEL_LENGTH_KM, prev = null) {
  const leftSamples = [];
  const rightSamples = [];
  for (const d of detectors || []) {
    if (d.lanes?.left) leftSamples.push(d.lanes.left);
    if (d.lanes?.right) rightSamples.push(d.lanes.right);
  }
  const left = aggregateLane(leftSamples, tunnelLengthKm);
  const right = aggregateLane(rightSamples, tunnelLengthKm);
  const recommendation = recommend(left, right, prev);
  return { left, right, recommendation };
}

module.exports = {
  TUNNEL_LENGTH_KM,
  SLOW_SPEED_KMH,
  HIGH_OCCUPANCY_PCT,
  SIMILAR_THRESHOLD,
  SWITCH_THRESHOLD,
  JAM_DENSITY_PER_KM,
  isValidSample,
  isSlowSample,
  density,
  weightedSpeed,
  aggregateLane,
  recommend,
  summarize,
};
