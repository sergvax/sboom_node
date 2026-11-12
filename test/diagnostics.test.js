import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { field } from '../lib/tlv.js';
import { OP_GET_META_DATA } from '../lib/protocol.js';
import { parseMetaInfo, parseState } from '../lib/parsers.js';
import {
  analyzePositionSamples,
  median,
  normalizePositionSample,
  pickRecommendedMaster,
  verdictForOffset,
  verdictLabel,
} from '../lib/diagnostics.js';
import { SpeakerManager } from '../lib/manager.js';
import { Store } from '../lib/store.js';
import { startMockSpeaker } from '../mock/speaker.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 10_000, step = 100, label = 'условие' } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await fn();
    if (value) return value;
    await sleep(step);
  }
  throw new Error(`Не дождались: ${label}`);
}

function metaResponse(overrides = {}) {
  const playerState = JSON.stringify({
    playing: true,
    title: 'Mock Track',
    trackId: '1001',
    position: { tsMs: 1794378134225, val: 37 },
    ...overrides.player,
  });
  const deviceInfo = Buffer.concat([
    field(1, 2, '1.104.35'),
    field(2, 2, 'sberboom-mini-2'),
    field(3, 2, 'SberBoom Mini 2'),
    field(4, 2, 'SberDevices'),
    field(5, 2, 'SRG31T09AC023475'),
  ]);
  const meta = Buffer.concat([
    field(1, 2, deviceInfo),
    field(5, 0, 1),
    field(8, 0, 7),
    field(9, 2, JSON.stringify(overrides.multiroom ?? { md: 'MR', master: true, group: ['a', 'b'] })),
    field(11, 2, playerState),
    field(14, 2, '{}'),
    ...(overrides.clockDifferenceMs !== undefined
      ? [field(17, 0, overrides.clockDifferenceMs)]
      : []),
  ]);
  return field(
    5,
    2,
    Buffer.concat([
      field(OP_GET_META_DATA, 2, Buffer.concat([
        field(1, 0, 1),
        field(2, 2, meta),
        field(3, 0, 1794438482408),
      ])),
    ]),
  );
}

test('parseMetaInfo: устройство, UDP, группа и position.tsMs', () => {
  const info = parseMetaInfo(metaResponse());
  assert.ok(info);
  assert.equal(info.status, 1);
  assert.equal(info.timestamp, 1794438482408);
  assert.equal(info.device.starVersion, '1.104.35');
  assert.equal(info.device.product, 'sberboom-mini-2');
  assert.equal(info.udpProtocolVersion, 7);
  assert.equal(info.multiroomSupported, true);
  assert.deepEqual(info.multiRoomServiceInfo, {
    md: 'MR',
    master: true,
    group: ['a', 'b'],
  });
  assert.deepEqual(info.playerPosition, { val: 37, tsMs: 1794378134225 });
  assert.equal(info.playerState.trackId, '1001');
  assert.equal(info.clockDifferenceMs, null);
});

test('parseMetaInfo: clock_difference_ms и NONE-группа', () => {
  const info = parseMetaInfo(
    metaResponse({ multiroom: { md: 'NONE' }, clockDifferenceMs: 14 }),
  );
  assert.equal(info.clockDifferenceMs, 14);
  assert.equal(info.multiRoomServiceInfo.md, 'NONE');
  assert.equal(info.multiRoomServiceInfo.master, null);
  assert.deepEqual(info.multiRoomServiceInfo.group, []);
});

test('parseState: timesync и sbercast из GET_STATE', () => {
  const raw = JSON.stringify({
    timesync: { unixtime: 1794438212.989 },
    multiroom: { enabled: true, mode: 'MASTER' },
    sbercast: {
      enabled: true,
      devices: [
        { id: 'stargate_1', name: 'SberPortal', product: 'stargate' },
        { id: 'mini_2', name: 'SberBoom Mini 2', product: 'sberboom-mini-2' },
      ],
    },
  });
  const state = parseState(field(12, 2, raw));
  assert.deepEqual(state.timesync, { unixtimeMs: 1794438212989 });
  assert.equal(state.multiroom.mode, 'MASTER');
  assert.equal(state.sbercast.devices.length, 2);
  assert.equal(state.sbercast.devices[0].name, 'SberPortal');
});

test('analyzePositionSamples: +15 мс = заметно на слух', () => {
  const result = analyzePositionSamples(
    {
      master: [
        { val: 10, ts: 1000 },
        { val: 11, ts: 2000 },
        { val: 12, ts: 3000 },
      ],
      slave: [
        { val: 10, ts: 1015 },
        { val: 11, ts: 2015 },
        { val: 12, ts: 3015 },
      ],
    },
    { masterId: 'master' },
  );
  assert.equal(result.ok, true);
  assert.equal(result.masterId, 'master');
  assert.equal(result.worstMs, 15);
  assert.equal(result.verdict, 'noticeable');
  assert.equal(result.offsets[0].samples, 3);
  assert.deepEqual(result.offsets[0].vals, [10, 11, 12]);
});

test('analyzePositionSamples: мало общих секунд и <10 мс', () => {
  const few = analyzePositionSamples({
    a: [{ val: 10, ts: 1000 }],
    b: [{ val: 10, ts: 1003 }],
  });
  assert.equal(few.ok, false);
  assert.equal(few.reason, 'not-enough-common-positions');

  const good = analyzePositionSamples(
    {
      a: [{ val: 1, ts: 0 }, { val: 2, ts: 1000 }],
      b: [{ val: 1, ts: 4 }, { val: 2, ts: 1004 }],
    },
    { masterId: 'a' },
  );
  assert.equal(good.ok, true);
  assert.equal(good.verdict, 'sync');
});

test('normalizePositionSample: часы устройств не влияют на возраст', () => {
  const mid = 1_000_000;

  const fresh = normalizePositionSample(
    { val: 10, tsMs: 900_000 },
    { timestamp: 900_150, mid },
  );
  assert.equal(fresh.val, 10);
  assert.equal(fresh.age, 150);
  assert.equal(fresh.ts, mid - 150);

  // Часы второй колонки ушли на +9 000 000 мс — разность timestamp−tsMs та же.
  const skewed = normalizePositionSample(
    { val: 10, tsMs: 9_900_000 },
    { timestamp: 9_900_150, mid },
  );
  assert.equal(skewed.age, 150);
  assert.equal(skewed.ts, mid - 150);

  // Старая отметка (пауза/endless) и битые данные отбрасываются.
  assert.equal(
    normalizePositionSample(
      { val: 37, tsMs: 1794378134225 },
      { timestamp: 1794438482408, mid },
    ),
    null,
  );
  assert.equal(normalizePositionSample(null, { timestamp: 1, mid }), null);
  assert.equal(
    normalizePositionSample({ val: 1, tsMs: 10 }, { timestamp: 0, mid }),
    null,
  );
});

test('verdictForOffset и подписи', () => {
  assert.equal(verdictForOffset(0), 'sync');
  assert.equal(verdictForOffset(10), 'sync');
  assert.equal(verdictForOffset(11), 'noticeable');
  assert.equal(verdictForOffset(30), 'noticeable');
  assert.equal(verdictForOffset(31), 'echo');
  assert.equal(verdictForOffset(null), 'unknown');
  assert.match(verdictLabel('echo'), /эхо/);
});

test('median: чётное и нечётное количество', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([5]), 5);
  assert.equal(median([]), null);
  assert.equal(median([1, Number.NaN, 3]), 2);
});

test('pickRecommendedMaster: полноразмерная колонка важнее RTT портала', () => {
  const rows = [
    {
      id: 'portal',
      name: 'SberPortal',
      status: 'connected',
      playing: true,
      product: 'stargate',
      rttMs: 6,
      udpProtocolVersion: 6,
      stateAgeMs: 100,
    },
    {
      id: 'boom',
      name: 'SberBoom',
      status: 'connected',
      playing: true,
      product: 'sberboom',
      rttMs: 14,
      udpProtocolVersion: 7,
      stateAgeMs: 100,
    },
  ];
  const best = pickRecommendedMaster(rows);
  assert.equal(best.id, 'boom');
  assert.match(best.reason, /RTT 14 мс/);
  assert.equal(best.playing, true);
  assert.equal(pickRecommendedMaster([]), null);
  const idle = pickRecommendedMaster([
    { id: 'x', name: 'X', status: 'connected', playing: false },
  ]);
  assert.equal(idle.id, 'x');
  assert.equal(idle.playing, false);
  assert.match(idle.reason, /включите трек/);

  // Играющий Portal не перевешивает простаивающий полноразмерный Boom:
  // мастером лучше выбрать Boom и включить трек уже на нём.
  const mixed = pickRecommendedMaster([
    { ...rows[0] },
    { ...rows[1], playing: false, id: 'boom', name: 'SberBoom' },
  ]);
  assert.equal(mixed.id, 'boom');
});

test('SpeakerManager: diagnostics и measureClock по mock-колонкам', async () => {
  const mockA = await startMockSpeaker();
  const mockB = await startMockSpeaker();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sboom-diag-'));
  const manager = new SpeakerManager({ store: new Store(path.join(dir, 'speakers.json')) });

  try {
    await manager.init();
    const a = await manager.add({ name: 'A', host: '127.0.0.1', port: mockA.port });
    const b = await manager.add({ name: 'B', host: '127.0.0.1', port: mockB.port });
    await manager.pair(a.id);
    await manager.pair(b.id);
    await waitFor(
      () => {
        const list = manager.snapshot().speakers;
        return list.length === 2 && list.every((s) => s.status === 'connected');
      },
      { label: 'обе mock-колонки подключились' },
    );

    const diag = await manager.diagnostics({ fresh: true });
    assert.equal(diag.speakers.length, 2);
    assert.equal(diag.group.mode, 'none');
    assert.equal(diag.group.members.length, 0);
    for (const row of diag.speakers) {
      assert.equal(row.status, 'connected');
      assert.equal(row.udpProtocolVersion, 7);
      assert.equal(row.product, 'mock-speaker');
      assert.ok(Number.isFinite(row.rttMs));
      assert.ok(Number.isFinite(row.clockOffsetMs));
      assert.ok(Number.isFinite(row.stateAgeMs));
    }

    const clock = await manager.measureClock({ samples: 3, intervalMs: 10 });
    assert.equal(clock.devices.length, 2);
    assert.equal(clock.samplesPerDevice, 3);
    for (const d of clock.devices) {
      assert.equal(d.samples, 3);
      assert.ok(Number.isFinite(d.offsetMs));
      assert.ok(Number.isFinite(d.relativeMs));
      assert.ok(Number.isFinite(d.rttMs));
    }
    assert.ok(Number.isFinite(clock.spreadMs));
  } finally {
    await Promise.allSettled([...manager.runtimes.values()].map((r) => r.stop()));
    await Promise.allSettled([mockA.close(), mockB.close()]);
  }
});

test('SpeakerManager.measureSync: без двух играющих колонок — понятная причина', async () => {
  const mock = await startMockSpeaker();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sboom-diag-sync-'));
  const manager = new SpeakerManager({ store: new Store(path.join(dir, 'speakers.json')) });
  try {
    await manager.init();
    const a = await manager.add({ name: 'A', host: '127.0.0.1', port: mock.port });
    await manager.pair(a.id);
    await waitFor(
      () => manager.snapshot().speakers[0]?.status === 'connected',
      { label: 'mock-колонка подключилась' },
    );
    const result = await manager.measureSync({ durationMs: 2000, intervalMs: 100 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'need-two-playing');
  } finally {
    await Promise.allSettled([...manager.runtimes.values()].map((r) => r.stop()));
    await mock.close();
  }
});
