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
    assert.equal(stopped.state, 'stopping', 'стоп отвечает сразу, роспуск — в фоне');
    await manager.nativeStopTask;
    const done = manager.snapshot().nativeMultiroom;
    assert.equal(done.state, 'idle');
    assert.deepEqual(done.memberIds, []);
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
  // Прошивка «гасит» группу не мгновенно; модель с длинной задержкой
  // проверяет, что API отвечает сразу, а роспуск идёт в фоне.
  const mockA = await startMockSpeaker({
    multiroomOffDelayMs: 5000,
    muteOnMultiroomOff: true,
    onMultiroomStart: () => {
      mockB.multiroom.mode = 'SLAVE';
    },
  });
  const mockB = await startMockSpeaker({ multiroomOffDelayMs: 5000, muteOnMultiroomOff: true });

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

    // Пользователь выключил звук на ведомой до остановки — этот mute надо
    // сохранить, а навязанный прошивкой mute после выхода из группы снять.
    await manager.command(b.id, 'mute');
    await waitFor(() => mockB.state.muted === true, { label: 'mute на ведомой' });

    const stopStartedAt = Date.now();
    const stopped = await manager.stopNativeMultiroom();
    // Ответ приходит сразу: прошивка распускает группу сама, мы ждём в фоне.
    const stopMs = Date.now() - stopStartedAt;
    if (stopMs >= 1500) {
      throw new Error(`стоп не должен ждать роспуска, ответил за ${stopMs} мс`);
    }
    assert.equal(stopped.state, 'stopping');
    assert.ok(stopped.dissolveAt > stopStartedAt, 'оценка конца роспуска передана UI');

    // Пока группа распускается, запуск трека отменил бы роспуск.
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

    await manager.nativeStopTask;
    assert.equal(manager.snapshot().nativeMultiroom.state, 'idle');
    assert.equal(mockA.multiroom.mode, 'NONE');
    assert.equal(mockB.multiroom.mode, 'NONE');
    // Прошивка глушит колонки при выходе из группы; звук возвращаем, но
    // только тем, кого пользователь не выключал сам.
    await waitFor(() => mockA.state.muted === false, { label: 'mute на мастере снят' });
    assert.equal(mockA.state.muted, false, 'mute после выхода из группы снят');
    assert.equal(mockB.state.muted, true, 'осознанный mute пользователя сохранён');
    assert.equal(
      manager.snapshot().speakers.find((s) => s.id === b.id).multiroom.mode,
      'NONE',
    );
    // Как только колонки вышли из группы, запуск снова разрешён.
    await manager.command(a.id, 'play');
  } finally {
    await Promise.allSettled([...manager.runtimes.values()].map((r) => r.stop()));
    await mockA.close();
    await mockB.close();
  }
});

test('SpeakerManager: контент с карточки ведомой запускается на мастере', async () => {
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

    // Пользователь нажал «запустить» на карточке ведомой: deeplink уходит
    // мастеру, ведомая остаётся в группе и просто подхватывает трек.
    const result = await manager.playContent(b.id, { kind: 'track', id: '1001' });
    assert.equal(result.ok, true);
    assert.equal(result.speaker.id, a.id, 'запуск подтверждён на мастере');
    assert.equal(result.redirectedFrom, 'Ведомая');
    assert.equal(mockA.state.playing, true, 'deeplink ушёл мастеру');
    assert.equal(mockA.state.trackId, '1001');
    assert.equal(mockB.state.playing, false, 'на ведомую deeplink не отправляем');
  } finally {
    await Promise.allSettled([...manager.runtimes.values()].map((r) => r.stop()));
    await Promise.allSettled([mockA.close(), mockB.close()]);
    await fs.rm(dir, { recursive: true, force: true });
  }
});
