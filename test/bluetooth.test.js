import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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

test('Bluetooth: спаренные, скан, режим сопряжения и команды устройствам', async () => {
  const mock = await startMockSpeaker();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sboom-bt-'));
  const store = new Store(path.join(dir, 'speakers.json'));
  const manager = new SpeakerManager({ store });

  try {
    await manager.init();
    const added = await manager.add({ name: 'BT', host: '127.0.0.1', port: mock.port });
    await manager.pair(added.id);
    await waitFor(
      () => manager.snapshot().speakers.find((s) => s.id === added.id)?.status === 'connected',
      { label: 'колонка подключилась' },
    );

    // op=19 — спаренные устройства.
    const info = await manager.bluetoothInfo(added.id);
    assert.equal(info.devices.length, 2);
    assert.deepEqual(info.devices[0], {
      mac: 'AA:BB:CC:DD:EE:FF',
      name: 'Mock Phone',
      connected: true,
    });

    // Снимок состояния тоже содержит BT-данные.
    const snapshot = manager.snapshot().speakers.find((s) => s.id === added.id);
    assert.equal(snapshot.bt.devices.length, 2);

    // op=21 — скан устройств рядом.
    const scanned = await manager.bluetoothScan(added.id);
    assert.equal(scanned.scanned.length, 2);
    assert.equal(scanned.scanned[0].rssi, 42);
    assert.equal(scanned.scanning, false);

    // op=22 — режим сопряжения.
    const discoverable = await manager.bluetoothDiscoverable(added.id);
    assert.equal(discoverable.discoverable, true);
    await sleep(100); // op=22 — fire-and-forget: колонка обрабатывает его асинхронно
    assert.equal(mock.bt.discoverable, true);

    // op=20 — disconnect / connect / remove.
    const mac = 'AA:BB:CC:DD:EE:FF';
    const off = await manager.bluetoothCommand(added.id, mac, 'disconnect');
    assert.equal(off.devices.find((d) => d.mac === mac).connected, false);
    assert.equal(mock.bt.devices.find((d) => d.mac === mac).connected, false);

    const on = await manager.bluetoothCommand(added.id, mac, 'connect');
    assert.equal(on.devices.find((d) => d.mac === mac).connected, true);

    const removed = await manager.bluetoothCommand(added.id, mac, 'remove');
    assert.equal(removed.devices.some((d) => d.mac === mac), false);
    assert.equal(mock.bt.devices.some((d) => d.mac === mac), false);

    await assert.rejects(
      () => manager.bluetoothCommand(added.id, mac, 'reboot'),
      /connect, disconnect или remove/,
    );
  } finally {
    await Promise.allSettled([...manager.runtimes.values()].map((r) => r.stop()));
    await mock.close();
  }
});
