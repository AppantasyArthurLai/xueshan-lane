'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const mock = require('../../server/adapters/mock');
const tdx = require('../../server/adapters/tdx');
const { createService } = require('../../server/service');
const { loadTunnelConfig } = require('../../server/config');

const config = loadTunnelConfig();

test('mock: per-lane numbers are realistic and deterministic per minute', () => {
  const now = new Date('2026-11-04T03:00:20Z');
  const a = mock.generate('S', now);
  const b = mock.generate('S', new Date('2026-11-04T03:00:50Z'));
  assert.deepEqual(a, b);
  assert.equal(a.source, 'mock');
  assert.ok(a.detectors.length >= 5);
  for (const d of a.detectors) {
    for (const side of ['left', 'right']) {
      const l = d.lanes[side];
      assert.ok(l.speed > 0 && l.speed < 110, `speed ${l.speed}`);
      assert.ok(l.flowPerHour >= 0 && l.flowPerHour < 2200);
      assert.ok(l.occupancy >= 0 && l.occupancy <= 100);
    }
  }
});

test('mock: varies over time and sometimes has slow right-lane platoons', () => {
  let platoonSeen = false;
  const speeds = new Set();
  for (let i = 0; i < 24 * 60; i += 7) {
    const r = mock.generate('N', new Date(Date.parse('2026-11-03T00:00:00Z') + i * 60000));
    speeds.add(r.detectors[0].lanes.left.speed);
    if (r.detectors.some((d) => d.lanes.right.speed < 60 && d.lanes.left.speed > 70)) platoonSeen = true;
  }
  assert.ok(speeds.size > 5);
  assert.ok(platoonSeen);
});

test('tdx: parseMileageKm', () => {
  assert.equal(tdx.parseMileageKm('15K+200'), 15.2);
  assert.equal(tdx.parseMileageKm('27K'), 27);
  assert.equal(tdx.parseMileageKm(20.5), 20.5);
  assert.equal(tdx.parseMileageKm('abc'), null);
});

test('tdx: parseVdid extracts direction and mileage', () => {
  assert.deepEqual(tdx.parseVdid('VD-N5-S-20.412-M-PS-LOOP'), { dir: 'S', mileageKm: 20.412 });
  assert.equal(tdx.parseVdid('VD-N1-S-20.000-M-LOOP'), null);
});

test('tdx: lanesFromLive maps LaneID to left/right and volume to flow/h', () => {
  const lanes = tdx.lanesFromLive(
    {
      LinkFlows: [
        {
          Lanes: [
            { LaneID: 0, Speed: 85, Occupancy: 8, Vehicles: [{ VehicleType: 'S', Volume: 18 }, { VehicleType: 'L', Volume: 2 }] },
            { LaneID: 1, Speed: -99, Occupancy: -99, Vehicles: [] },
          ],
        },
      ],
    },
    config,
  );
  assert.deepEqual(lanes.left, { speed: 85, volume: 20, flowPerHour: 1200, occupancy: 8 });
  assert.equal(lanes.right, undefined);
});

const LIVE = {
  UpdateTime: '2026-11-04T11:00:00+08:00',
  VDLives: [
    {
      VDID: 'VD-N5-S-16.000-M-LOOP',
      Status: 0,
      DataCollectTime: '2026-11-04T11:00:00+08:00',
      LinkFlows: [{ Lanes: [
        { LaneID: 0, Speed: 82, Occupancy: 9, Vehicles: [{ Volume: 20 }], ErrorType: 'diag0' },
        { LaneID: 1, Speed: 64, Occupancy: 14, Vehicles: [{ Volume: 15 }], ErrorType: 'diag0' },
      ] }],
    },
    { VDID: 'VD-N5-N-20.000-M-LOOP', Status: 0, DataCollectTime: '2026-11-04T10:59:00+08:00',
      LinkFlows: [{ Lanes: [{ LaneID: 0, Speed: 70, Occupancy: 9, Vehicles: [{ Volume: 10 }] }] }] },
  ],
};

function fakeFetch({ failLive = false, unauthorizedOnce = false } = {}) {
  const calls = { token: 0, live: 0 };
  let sent401 = false;
  const json = (obj, status = 200) => ({ ok: status < 400, status, json: async () => obj });
  const impl = async (url) => {
    if (url === tdx.TOKEN_URL) {
      calls.token++;
      return json({ access_token: 'tok', expires_in: 86400 });
    }
    if (url === tdx.LIVE_URL) {
      calls.live++;
      if (failLive) return json({}, 503);
      if (unauthorizedOnce && !sent401) { sent401 = true; return json({}, 401); }
      return json(LIVE);
    }
    throw new Error('unexpected ' + url);
  };
  return { impl, calls };
}

const noSleep = async () => {};

test('tdx adapter: one live call serves both directions; caches token and live for 60s', async () => {
  let t = Date.parse('2026-11-04T03:00:00Z');
  const { impl, calls } = fakeFetch();
  const a = tdx.createTdxAdapter({ clientId: 'id', clientSecret: 'sec', config, fetchImpl: impl, now: () => t, sleep: noSleep });
  const r1 = await a.fetchLanes('S');
  const n1 = await a.fetchLanes('N');
  assert.equal(calls.token, 1);
  assert.equal(calls.live, 1);
  assert.equal(r1.source, 'tdx');
  assert.equal(r1.dataTime, '2026-11-04T03:00:00.000Z');
  assert.equal(r1.detectors[0].lanes.right.flowPerHour, 900);
  assert.equal(n1.detectors[0].id, 'VD-N5-N-20.000-M-LOOP');
  t += 61000;
  await a.fetchLanes('S');
  assert.equal(calls.live, 2);
  assert.equal(calls.token, 1);
  t += 23 * 3600 * 1000 + 1000; // 到期前 1 小時換新
  await a.fetchLanes('S');
  assert.equal(calls.token, 2);
});

test('tdx adapter: refreshes token and retries once on 401', async () => {
  const { impl, calls } = fakeFetch({ unauthorizedOnce: true });
  const a = tdx.createTdxAdapter({ clientId: 'id', clientSecret: 'sec', config, fetchImpl: impl, sleep: noSleep });
  const r = await a.fetchLanes('S');
  assert.equal(r.source, 'tdx');
  assert.equal(calls.token, 2);
  assert.equal(calls.live, 2);
});

test('service: uses mock without keys and caches for 60s', async () => {
  let t = Date.parse('2026-11-04T03:00:00Z');
  const svc = createService({ env: {}, config, now: () => t });
  assert.equal(svc.mode, 'mock');
  const a = await svc.getLanes('S');
  assert.equal(a.source, 'mock');
  assert.equal(a.sourceLabel, '模擬資料');
  assert.equal(a.cached, false);
  assert.ok(Number.isFinite(a.lanes.left.speed));
  t += 30000;
  assert.equal((await svc.getLanes('S')).cached, true);
  t += 31000;
  assert.equal((await svc.getLanes('S')).cached, false);
});

test('service: reports "unavailable" (no silent mock) on TDX error', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('network down');
  };
  try {
    const svc = createService({ env: { TDX_CLIENT_ID: 'x', TDX_CLIENT_SECRET: 'y' }, config, log: { warn() {} } });
    assert.equal(svc.mode, 'tdx');
    const r = await svc.getLanes('N');
    assert.equal(r.source, 'unavailable');
    assert.equal(r.unavailable, true);
    assert.match(r.error, /network down/);
    assert.equal(r.lanes.right.speed, null);
    assert.equal(r.recommendation.rec, 'unknown');
    assert.equal(r.detectorCount, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('service: DATA_SOURCE=mock forces mock even with keys', () => {
  const svc = createService({ env: { TDX_CLIENT_ID: 'x', TDX_CLIENT_SECRET: 'y', DATA_SOURCE: 'mock' }, config });
  assert.equal(svc.mode, 'mock');
});
