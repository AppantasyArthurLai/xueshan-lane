'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  aggregateLane,
  recommend,
  summarize,
  density,
  weightedSpeed,
  isSlowSample,
  JAM_DENSITY_PER_KM,
} = require('../../server/estimate');

const s = (speed, flowPerHour, occupancy = 10) => ({ speed, flowPerHour, occupancy });

test('density = flow / speed, capped at jam density', () => {
  assert.equal(density(1200, 80), 15);
  assert.equal(density(1000, 0), Math.min(1000 / 5, JAM_DENSITY_PER_KM));
  assert.ok(density(5000, 1) <= JAM_DENSITY_PER_KM);
});

test('weightedSpeed weights by flow, falls back to mean when flow is 0', () => {
  assert.equal(weightedSpeed([s(90, 1000), s(60, 500)]), (90 * 1000 + 60 * 500) / 1500);
  assert.equal(weightedSpeed([s(90, 0), s(70, 0)]), 80);
  assert.equal(weightedSpeed([]), null);
});

test('aggregateLane: vehiclesAhead = density × 12.9 km', () => {
  const lane = aggregateLane([s(80, 1200), s(80, 1200)], 12.9);
  assert.equal(lane.speed, 80);
  assert.equal(lane.density, 15);
  assert.equal(lane.vehiclesAhead, Math.round(15 * 12.9)); // 194
  assert.equal(lane.slowSuspect, 0);
  assert.equal(lane.estimated, true);
  assert.equal(lane.samples, 2);
});

test('aggregateLane: slowSuspect = slow fraction × vehicles', () => {
  // 4 個樣本中 1 個慢速（<60）、1 個高佔有率 → 比例 0.5
  const lane = aggregateLane([s(80, 1200), s(50, 600), s(80, 1200, 30), s(80, 1200)], 12.9);
  assert.equal(lane.slowFraction, 0.5);
  assert.equal(lane.slowSuspect, Math.round(0.5 * lane.vehiclesAhead));
  assert.ok(isSlowSample(s(59, 100)));
  assert.ok(!isSlowSample(s(60, 100, 24)));
});

test('aggregateLane ignores invalid samples and handles empty input', () => {
  const empty = aggregateLane([]);
  assert.equal(empty.speed, null);
  assert.equal(empty.vehiclesAhead, null);
  const lane = aggregateLane([s(-99, 100), s(NaN, 100), s(80, 1200)], 12.9);
  assert.equal(lane.samples, 1);
  assert.equal(lane.speed, 80);
});

test('recommend: similar when |diff| < 5', () => {
  assert.equal(recommend({ speed: 80 }, { speed: 76 }, null).rec, 'similar');
  assert.equal(recommend({ speed: 76 }, { speed: 80 }, 'left').rec, 'similar');
  assert.equal(recommend({ speed: 80 }, { speed: 80 }, 'right').rec, 'similar');
});

test('recommend: picks faster lane with no prior', () => {
  const r = recommend({ speed: 85 }, { speed: 78 }, null);
  assert.equal(r.rec, 'left');
  assert.equal(r.diff, 7);
  assert.equal(r.held, false);
  assert.equal(recommend({ speed: 70 }, { speed: 82 }, 'similar').rec, 'right');
});

test('recommend hysteresis: does not switch unless diff > 8', () => {
  // 前次建議左線，右線快 6 → 維持左線
  let r = recommend({ speed: 74 }, { speed: 80 }, 'left');
  assert.equal(r.rec, 'left');
  assert.equal(r.held, true);
  // 剛好 8 → 仍維持
  r = recommend({ speed: 72 }, { speed: 80 }, 'left');
  assert.equal(r.rec, 'left');
  // 超過 8 → 改右線
  r = recommend({ speed: 71 }, { speed: 80 }, 'left');
  assert.equal(r.rec, 'right');
  assert.equal(r.held, false);
  // 反方向同理
  assert.equal(recommend({ speed: 86 }, { speed: 80 }, 'right').rec, 'right');
  assert.equal(recommend({ speed: 89 }, { speed: 80 }, 'right').rec, 'left');
});

test('recommend: same-side prior keeps recommendation without hold', () => {
  const r = recommend({ speed: 86 }, { speed: 80 }, 'left');
  assert.deepEqual(r, { rec: 'left', diff: 6, held: false });
});

test('recommend: unknown when data missing', () => {
  assert.equal(recommend({ speed: null }, { speed: 80 }, null).rec, 'unknown');
  assert.equal(recommend(null, null, 'left').rec, 'unknown');
});

test('recommend sequence does not flip-flop on noisy data', () => {
  const series = [[85, 75], [80, 86], [79, 86], [84, 78], [72, 84]];
  let prev = null;
  const out = [];
  for (const [l, r] of series) {
    prev = recommend({ speed: l }, { speed: r }, prev).rec;
    out.push(prev);
  }
  assert.deepEqual(out, ['left', 'left', 'left', 'left', 'right']);
});

test('summarize splits detectors into lanes', () => {
  const detectors = [
    { id: 'a', lanes: { left: s(88, 1300), right: s(55, 900, 30) } },
    { id: 'b', lanes: { left: s(86, 1300), right: s(70, 1000) } },
  ];
  const out = summarize(detectors, 12.9, null);
  assert.equal(out.left.samples, 2);
  assert.equal(out.right.samples, 2);
  assert.equal(out.recommendation.rec, 'left');
  assert.ok(out.right.slowSuspect > 0);
});
