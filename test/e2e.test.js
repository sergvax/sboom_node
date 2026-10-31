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

test('SpeakerClient: pair → reconnect с токеном → state/metadata → команды и push', async () => {
  const mock = await startMockSpeaker();
  try {
    const client = new SpeakerClient({ host: '127.0.0.1', port: mock.port });
    await client.connect();
    const token = await client.pair();
    assert.equal(token, mock.token);
    await client.close();

    const authed = new SpeakerClient({ host: '127.0.0.1', port: mock.port, token });
    await authed.connect();
    const state = await authed.getState();
    assert.equal(state.volume, 20);
    assert.equal(state.muted, false);

    const track = await authed.getMetadata();
    assert.equal(track.title, 'Mock Track');
    assert.deepEqual(track.artists, ['Mock Artist']);
    assert.equal(track.provider, 'zvuk');

    await authed.setVolume(55);
    await sleep(200);
    assert.equal((await authed.getState()).volume, 55);

    const pushed = new Promise((resolve) => authed.once('event', (_raw, parsed) => resolve(parsed)));
    await authed.next();
    const parsed = await pushed;
    assert.ok(parsed[5], 'push содержит request_data');
    assert.ok('12' in parsed[5] || '10' in parsed[5], 'push содержит state или metadata');

    await authed.close();
  } finally {
    await mock.close();
  }
});

test('SpeakerClient: без токена колонка не отвечает (RequestTimeout)', async () => {
  const mock = await startMockSpeaker();
  try {
    const client = new SpeakerClient({ host: '127.0.0.1', port: mock.port });
    await client.connect();
    await assert.rejects(() => client.getState(), /таймаут|timeout/i);
    await client.close();
  } finally {
    await mock.close();
  }
});

test('SpeakerManager: мультирум запускает трек на второй колонке, зеркалит паузу и next, затем стоп', async () => {
  const mockA = await startMockSpeaker();
  const mockB = await startMockSpeaker();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sboom-mr-'));
  const store = new Store(path.join(dir, 'speakers.json'));
  const manager = new SpeakerManager({ store });

  try {
    await manager.init();
    const a = await manager.add({ name: 'Источник', host: '127.0.0.1', port: mockA.port });
    const b = await manager.add({ name: 'Вторая', host: '127.0.0.1', port: mockB.port });
    await manager.pair(a.id);
    await manager.pair(b.id);

    await waitFor(
      () => {
        const list = manager.snapshot().speakers;
        return list.length === 2 &&
          list.every((s) => s.status === 'connected' && s.track?.track_id)
          ? list
          : null;
      },
      { label: 'обе колонки подключились' },
    );

    // Источник играет — с него стартуем мультирум.
    await manager.command(a.id, 'play');
    await waitFor(
      () => manager.snapshot().speakers.find((s) => s.id === a.id)?.track?.playing,
      { label: 'источник заиграл' },
    );

    const started = await manager.startMultiroom(a.id);
    assert.equal(started.active, true);
    assert.equal(started.sourceId, a.id);
    assert.deepEqual(new Set(started.memberIds), new Set([a.id, b.id]));

    // Обе колонки играют один и тот же трек.
    const bothPlaying = await waitFor(
      () => {
        const list = manager.snapshot().speakers;
        const src = list.find((s) => s.id === a.id);
        const dst = list.find((s) => s.id === b.id);
        return dst?.track?.track_id === src?.track?.track_id && dst?.track?.playing ? { src, dst } : null;
      },
      { timeout: 15_000, label: 'вторая колонка играет тот же трек' },
    );
    assert.equal(bothPlaying.dst.track.track_id, bothPlaying.src.track.track_id);

    // Пауза на источнике — пауза на всех.
    await manager.command(a.id, 'pause');
    await waitFor(
      () => manager.snapshot().speakers.every((s) => !s.track?.playing),
      { timeout: 10_000, label: 'пауза на обеих колонках' },
    );

    // Следующий трек — ведомая догоняет источник через deeplink.
    const before = manager.snapshot().speakers.find((s) => s.id === a.id)?.track?.track_id;
    await manager.command(a.id, 'next');
    const afterNext = await waitFor(
      () => {
        const list = manager.snapshot().speakers;
        const src = list.find((s) => s.id === a.id);
        const dst = list.find((s) => s.id === b.id);
        return src?.track?.track_id &&
          src.track.track_id !== before &&
          dst?.track?.track_id === src.track.track_id
          ? { src, dst }
          : null;
      },
      { timeout: 20_000, label: 'обе колонки перешли на новый трек' },
    );
    assert.equal(afterNext.dst.track.track_id, afterNext.src.track.track_id);

    const stopped = await manager.stopMultiroom();
    assert.equal(stopped.active, false);
    assert.deepEqual(stopped.memberIds, []);
    await waitFor(
      () => manager.snapshot().speakers.every((s) => !s.track?.playing),
      { timeout: 10_000, label: 'после стопа всё на паузе' },
    );
  } finally {
    await Promise.allSettled([...manager.runtimes.values()].map((r) => r.stop()));
    await Promise.allSettled([mockA.close(), mockB.close()]);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('SpeakerManager: add → pair → connected → команды → remove', async () => {
  const mock = await startMockSpeaker();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sboom-test-'));
  const store = new Store(path.join(dir, 'speakers.json'));
  const manager = new SpeakerManager({ store });

  try {
    await manager.init();
    const added = await manager.add({ name: 'Тестовая', host: '127.0.0.1', port: mock.port });
    assert.equal(added.name, 'Тестовая');
    assert.equal(added.paired, false);
    assert.equal(added.status, 'unpaired');

    await manager.pair(added.id);

    const speaker = await waitFor(
      () => {
        const sp = manager.snapshot().speakers[0];
        return sp && sp.status === 'connected' && sp.track ? sp : null;
      },
      { label: 'колонка подключилась и получила трек' },
    );
    assert.equal(speaker.track.title, 'Mock Track');
    assert.equal(speaker.volume, 20);
    assert.equal(speaker.paired, true);

    await manager.command(added.id, 'volume', 44);
    const withVolume = await waitFor(
      () => {
        const sp = manager.snapshot().speakers[0];
        return sp.volume === 44 ? sp : null;
      },
      { label: 'громкость 44' },
    );
    assert.equal(withVolume.volume, 44);

    await manager.command(added.id, 'playpause');
    await waitFor(
      () => manager.snapshot().speakers[0].track?.playing,
      { label: 'воспроизведение началось' },
    );

    await manager.command(added.id, 'next');
    await waitFor(
      () => manager.snapshot().speakers[0].track?.title === 'Mock Track 1002',
      { label: 'переключение трека' },
    );

    const persisted = JSON.parse(await fs.readFile(path.join(dir, 'speakers.json'), 'utf8'));
    assert.equal(persisted.speakers.length, 1);
    assert.equal(persisted.speakers[0].token, mock.token);

    await manager.remove(added.id);
    assert.equal(manager.snapshot().speakers.length, 0);
  } finally {
    await Promise.allSettled([...manager.runtimes.values()].map((r) => r.stop()));
    await mock.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
