import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SpeakerClient } from '../lib/speaker.js';
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

test('startMultiroom: без источника PRS_NOT_SUPPORTED, с музыкой — ok', async () => {
  const mock = await startMockSpeaker();
  try {
    const client = new SpeakerClient({ host: '127.0.0.1', port: mock.port, token: mock.token });
    await client.connect();

    const denied = await client.startMultiroom();
    assert.equal(denied.ok, false);
    assert.equal(denied.status, 1);
    assert.equal(mock.multiroom.mode, 'NONE');

    await client.play();
    await sleep(150);
    const started = await client.startMultiroom();
    assert.equal(started.ok, true);
    assert.equal(started.status, 0);
    assert.equal(mock.multiroom.mode, 'MASTER');

    await client.close();
  } finally {
    await mock.close();
  }
});

test('SpeakerManager: нативный мультирум MASTER/SLAVE, стоп по паузе', async () => {  let slave = null;
  const mockA = await startMockSpeaker({
    onMultiroomStart: () => {
      if (slave) slave.multiroom.mode = 'SLAVE';
    },
    onMultiroomStop: () => {
      if (slave) slave.multiroom.mode = 'NONE';
    },
  });
  const mockB = await startMockSpeaker();
  slave = mockB;

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sboom-native-mr-'));
  const store = new Store(path.join(dir, 'speakers.json'));
  const manager = new SpeakerManager({ store });

  try {
    await manager.init();
    const a = await manager.add({ name: 'Мастер', host: '127.0.0.1', port: mockA.port });
    const b = await manager.add({ name: 'Ведомая', host: '127.0.0.1', port: mockB.port });
    await manager.pair(a.id);
    await manager.pair(b.id);

    await waitFor(
      () => {
        const list = manager.snapshot().speakers;
        return list.length === 2 && list.every((s) => s.status === 'connected') ? list : null;
      },
      { label: 'обе колонки подключились' },
    );

    // Без активного источника нативный мультирум не стартует.
    await assert.rejects(
      () => manager.startNativeMultiroom(a.id),
      /музыку Звука/,
      'нужен активный источник',
    );

    await manager.command(a.id, 'play');
    await waitFor(
      () => manager.snapshot().speakers.find((s) => s.id === a.id)?.player?.playing,
      { label: 'мастер заиграл' },
    );

    const started = await manager.startNativeMultiroom(a.id);
    assert.equal(started.state, 'active');
    assert.equal(started.masterId, a.id);
    assert.deepEqual(new Set(started.memberIds), new Set([a.id, b.id]));

    const snap = manager.snapshot();
    assert.deepEqual(
      new Set(snap.nativeMultiroom.memberIds),
      new Set([a.id, b.id]),
      'снимок отдаёт нативную группу',
    );
    const fromA = snap.speakers.find((s) => s.id === a.id);
    const fromB = snap.speakers.find((s) => s.id === b.id);
    assert.equal(fromA.multiroom.mode, 'MASTER');
    assert.equal(fromB.multiroom.mode, 'SLAVE');
    assert.equal(fromA.player.playing, true);

    const stopped = await manager.stopNativeMultiroom();
    assert.equal(stopped.state, 'idle');
    assert.deepEqual(stopped.memberIds, []);
    assert.equal(
      manager.snapshot().speakers.find((s) => s.id === a.id).multiroom.mode,
      'NONE',
    );
    assert.equal(
      manager.snapshot().speakers.find((s) => s.id === b.id).multiroom.mode,
      'NONE',
    );
  } finally {
    await Promise.allSettled([...manager.runtimes.values()].map((r) => r.stop()));
    await mockA.close();
    await mockB.close();
  }
});

test('SpeakerManager: стоп распускает живую группу и блокирует запуск трека', async () => {
  const mockA = await startMockSpeaker({
    onMultiroomStart: () => {
      mockB.multiroom.mode = 'SLAVE';
    },
  });
  const mockB = await startMockSpeaker();

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sboom-native-mr-stop-'));
  const manager = new SpeakerManager({ store: new Store(path.join(dir, 'speakers.json')) });

  try {
    await manager.init();
    const a = await manager.add({ name: 'Мастер', host: '127.0.0.1', port: mockA.port });
    const b = await manager.add({ name: 'Ведомая', host: '127.0.0.1', port: mockB.port });
    await manager.pair(a.id);
    await manager.pair(b.id);
    await waitFor(
      () => {
        const list = manager.snapshot().speakers;
        return list.length === 2 && list.every((s) => s.status === 'connected');
      },
      { label: 'обе колонки подключились' },
    );

    await manager.command(a.id, 'play');
    await waitFor(
      () => manager.snapshot().speakers.find((s) => s.id === a.id)?.player?.playing,
      { label: 'мастер заиграл' },
    );
    const started = await manager.startNativeMultiroom(a.id);
    assert.equal(started.state, 'active');
    assert.equal(mockB.multiroom.mode, 'SLAVE');

    // Сервер потерял состояние (например, перезапустился), но колонки в группе:
    // снимок должен снова показать активный мультирум, а не «idle».
    manager._resetNative();
    const adopted = manager.snapshot().nativeMultiroom;
    assert.equal(adopted.state, 'active');
    assert.deepEqual(new Set(adopted.memberIds), new Set([a.id, b.id]));

    // Теперь состояние действительно idle: стоп обязан найти группу по живым
    // ролям колонок, а не по сохранённому masterId.
    manager._resetNative();
    const stopping = manager.stopNativeMultiroom();
    const stopped = await stopping;
    assert.equal(stopped.state, 'idle');
    assert.equal(mockA.multiroom.mode, 'NONE');
    assert.equal(mockB.multiroom.mode, 'NONE');
    assert.equal(
      manager.snapshot().speakers.find((s) => s.id === b.id).multiroom.mode,
      'NONE',
    );

    // Пока группа распускается, запуск трека отменил бы роспуск.
    manager.nativeMr = { ...manager.nativeMr, state: 'stopping' };
    await assert.rejects(
      () => manager.command(a.id, 'play'),
      /выходит из группы/,
      'запуск трека во время остановки должен быть заблокирован',
    );
    await assert.rejects(
      () => manager.playContent(a.id, { kind: 'track', id: '1' }),
      /выходит из группы/,
      'запуск контента во время остановки должен быть заблокирован',
    );
  } finally {
    await Promise.allSettled([...manager.runtimes.values()].map((r) => r.stop()));
    await mockA.close();
    await mockB.close();
  }
});

test('SpeakerManager: в нативной группе контент запускают на мастере, а не на ведомой', async () => {
  const mockA = await startMockSpeaker({ onMultiroomStart: () => { mockB.multiroom.mode = 'SLAVE'; } });
  const mockB = await startMockSpeaker();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sboom-native-mr-play-'));
  const manager = new SpeakerManager({ store: new Store(path.join(dir, 'speakers.json')) });

  try {
    await manager.init();
    const a = await manager.add({ name: 'Мастер', host: '127.0.0.1', port: mockA.port });
    const b = await manager.add({ name: 'Ведомая', host: '127.0.0.1', port: mockB.port });
    await manager.pair(a.id);
    await manager.pair(b.id);
    await waitFor(
      () => {
        const list = manager.snapshot().speakers;
        return list.length === 2 && list.every((s) => s.status === 'connected') ? list : null;
      },
      { label: 'обе колонки подключились' },
    );

    await manager.command(a.id, 'play');
    await waitFor(
      () => manager.snapshot().speakers.find((s) => s.id === a.id)?.player?.playing,
      { label: 'мастер заиграл' },
    );
    await manager.startNativeMultiroom(a.id);

    await assert.rejects(
      () => manager.playContent(b.id, { kind: 'track', id: '1001' }),
      /ведомая/,
      'запуск контента на ведомой должен быть заблокирован',
    );
    assert.equal(mockB.state.playing, false, 'deeplink не должен уйти на ведомую');

    const result = await manager.playContent(a.id, { kind: 'track', id: '1001' });
    assert.equal(result.ok, true);
    assert.equal(mockA.state.playing, true);
  } finally {
    await Promise.allSettled([...manager.runtimes.values()].map((r) => r.stop()));
    await Promise.allSettled([mockA.close(), mockB.close()]);
    await fs.rm(dir, { recursive: true, force: true });
  }
});
