'use strict';
// 以 2026-11-03 10:33（台北）實錄的 TDX VDLive 樣本（國5 14–29K，無任何金鑰）測試解析與彙整。
const test = require('node:test');
const assert = require('node:assert/strict');
const tdx = require('../../server/adapters/tdx');
const { summarize } = require('../../server/estimate');
const { loadTunnelConfig } = require('../../server/config');
const sample = require('../fixtures/tdx-vdlive-n5-20261103.json');

const config = loadTunnelConfig();

test('fixture: selects 21 southbound and 19 northbound tunnel VDs with verified ranges', () => {
  const p = tdx.parseLive(sample, config);
  assert.equal(p.S.tunnelVdCount, 21);
  assert.equal(p.N.tunnelVdCount, 19);
  assert.equal(p.S.detectors[0].id, 'VD-N5-S-15.139-M-LOOP');
  assert.equal(p.S.detectors.at(-1).id, 'VD-N5-S-28.236-M-LOOP');
  assert.equal(p.N.detectors[0].id, 'VD-N5-N-15.488-M-LOOP');
  assert.equal(p.N.detectors.at(-1).id, 'VD-N5-N-27.779-M-LOOP');
  assert.ok(!p.N.detectors.some((d) => d.mileageKm > 28), 'N 28.420 is outside the tunnel');
  assert.equal(p.S.dataTime, '2026-11-03T02:33:00.000Z');
});

test('fixture: every tunnel VD yields left and right lanes with summed S/L/T volume', () => {
  const p = tdx.parseLive(sample, config);
  for (const dir of ['N', 'S']) {
    for (const d of p[dir].detectors) {
      for (const side of ['left', 'right']) {
        const l = d.lanes[side];
        if (!l) continue;
        assert.ok(l.speed > 0 && l.speed < 150, `${d.id} ${side} ${l.speed}`);
        assert.equal(l.flowPerHour, l.volume * 60);
      }
    }
    assert.ok(p[dir].detectors.filter((d) => d.lanes.left && d.lanes.right).length >= p[dir].tunnelVdCount - 2);
  }
  const raw = sample.VDLives.find((v) => v.VDID === p.S.detectors[0].id);
  const lane0 = raw.LinkFlows[0].Lanes.find((l) => l.LaneID === 0);
  assert.equal(p.S.detectors[0].lanes.left.volume, lane0.Vehicles.reduce((a, v) => a + v.Volume, 0));
});

test('fixture: aggregation produces per-direction lane speeds and a recommendation', () => {
  const p = tdx.parseLive(sample, config);
  for (const dir of ['N', 'S']) {
    const s = summarize(p[dir].detectors, config.tunnelLengthKm);
    assert.ok(Number.isFinite(s.left.speed) && Number.isFinite(s.right.speed));
    assert.ok(['left', 'right', 'similar'].includes(s.recommendation.rec));
    assert.equal(s.left.estimated, true);
  }
});

test('lanesFromLive: drops non-diag0 errors, Status!=0 VDs and empty 0/0 lanes', () => {
  const lanes = tdx.lanesFromLive(
    { LinkFlows: [{ Lanes: [
      { LaneID: 0, Speed: 80, Occupancy: 5, Vehicles: [{ Volume: 3 }], ErrorType: 'diag3' },
      { LaneID: 1, Speed: 0, Occupancy: 0, Vehicles: [{ Volume: 0 }], ErrorType: 'diag0' },
    ] }] },
    config,
  );
  assert.deepEqual(lanes, {});
  const p = tdx.parseLive({ VDLives: [{ VDID: 'VD-N5-S-20.000-M-LOOP', Status: 1, LinkFlows: [] }] }, config);
  assert.equal(p.S.detectors.length, 0);
  assert.equal(p.S.skipped, 1);
});

test('config: direction/mileage verified, LaneID→left still spec-only', () => {
  assert.equal(config.verified, true);
  assert.equal(config.laneMapVerified, false);
  assert.equal(config.laneMap['0'], 'left');
});
