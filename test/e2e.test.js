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
          list.every((s) => s.status === 'connected' && s.track?.trackId)
          ? list
          : null;
      },
      { label: 'обе колонки подключились' },
    );

    // Источник уже играет — с него стартуем мультирум.
    await manager.command(a.id, 'play');
    await waitFor(
      () => manager.snapshot().speakers.find((s) => s.id === a.id)?.track?.playing,
      { label: 'источник заиграл' },
    );

    // Ставим источник на 20-ю секунду: ведомая должна попасть на ту же
    // секунду, а не начать трек с нуля.
    await manager.command(a.id, 'seek', 20);
    await waitFor(
      async () => {
        const view = await manager.get(a.id).measure().catch(() => null);
        return view?.position >= 20 ? view : null;
      },
      { label: 'источник на 20-й секунде' },
    );

    const started = await manager.startMultiroom(a.id);
    assert.equal(started.active, true);
    assert.equal(started.sourceId, a.id);
    assert.deepEqual(new Set(started.memberIds), new Set([a.id, b.id]));

    const [srcView, dstView] = await waitFor(
      async () => {
        const [src, dst] = await Promise.all([
          manager.get(a.id).measure().catch(() => null),
          manager.get(b.id).measure().catch(() => null),
        ]);
        if (!src || !dst || src.position === null || dst.position === null) return null;
        return Math.abs(src.position - dst.position) <= 1 ? [src, dst] : null;
      },
      { timeout: 10_000, label: 'колонки играют с одной секунды' },
    );
    assert.ok(srcView.position >= 19, `источник должен быть на 20-й секунде, а не ${srcView.position}`);
    assert.ok(dstView.position >= 19, `ведомая стартовала с нуля: ${dstView.position}`);

    // Обе колонки играют один и тот же трек.
    const bothPlaying = await waitFor(
      () => {
        const list = manager.snapshot().speakers;
        const src = list.find((s) => s.id === a.id);
        const dst = list.find((s) => s.id === b.id);
        return dst?.track?.trackId === src?.track?.trackId && dst?.track?.playing ? { src, dst } : null;
      },
      { timeout: 15_000, label: 'вторая колонка играет тот же трек' },
    );
    assert.equal(bothPlaying.dst.track.trackId, bothPlaying.src.track.trackId);

    // Пауза на источнике — пауза на всех.
    await manager.command(a.id, 'pause');
    await waitFor(
      () => manager.snapshot().speakers.every((s) => !s.track?.playing),
      { timeout: 10_000, label: 'пауза на обеих колонках' },
    );

    // Продолжаем и переключаем трек на играющем источнике.
    await manager.command(a.id, 'play');
    await waitFor(
      () => manager.snapshot().speakers.every((s) => s.track?.playing),
      { timeout: 10_000, label: 'обе колонки снова играют' },
    );

    // Следующий трек — ведомая догоняет источник через deeplink.
    const before = manager.snapshot().speakers.find((s) => s.id === a.id)?.track?.trackId;
    await manager.command(a.id, 'next');
    const afterNext = await waitFor(
      () => {
        const list = manager.snapshot().speakers;
        const src = list.find((s) => s.id === a.id);
        const dst = list.find((s) => s.id === b.id);
        return src?.track?.trackId &&
          src.track.trackId !== before &&
          dst?.track?.trackId === src.track.trackId
          ? { src, dst }
          : null;
      },
      { timeout: 20_000, label: 'обе колонки перешли на новый трек' },
    );
    assert.equal(afterNext.dst.track.trackId, afterNext.src.track.trackId);

    // И не начала новый трек с нуля: позиции остаются рядом.
    const [nextSrc, nextDst] = await Promise.all([
      manager.get(a.id).measure().catch(() => null),
      manager.get(b.id).measure().catch(() => null),
    ]);
    assert.ok(
      Math.abs(nextSrc.position - nextDst.position) <= 2,
      `после next позиции разъехались: ${nextSrc.position} и ${nextDst.position}`,
    );

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

test('SpeakerClient: очередь op=17 возвращает trackId', async () => {
  const mock = await startMockSpeaker();
  try {
    const client = new SpeakerClient({ host: '127.0.0.1', port: mock.port });
    await client.connect();
    const token = await client.pair();
    await client.close();

    const authed = new SpeakerClient({ host: '127.0.0.1', port: mock.port, token });
    await authed.connect();
    const queue = await authed.getQueue();
    assert.deepEqual(queue.map((x) => x.trackId), ['1001', '1002', '1003']);
    assert.ok(queue.every((x) => typeof x.explicit === 'boolean'));
    await authed.close();
  } finally {
    await mock.close();
  }
});

test('SpeakerManager: playContent по ссылке и очередь с метаданными каталога', async () => {
  const mock = await startMockSpeaker();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sboom-play-'));
  const store = new Store(path.join(dir, 'speakers.json'));
  const zvuk = {
    async resolveInput(input) {
      const match = /track\/(\d+)/.exec(String(input));
      assert.ok(match, 'ожидалась ссылка на трек');
      return {
        kind: 'track',
        id: match[1],
        deeplink: `staros://music?tid=${match[1]}&pt=track`,
        title: `Каталожный трек ${match[1]}`,
      };
    },
    async getTracks(ids) {
      return ids.map((id) => ({
        id: String(id),
        title: `Каталожный трек ${id}`,
        artists: ['Исполнитель'],
        album: 'Альбом',
        cover: null,
        duration: 180,
      }));
    },
  };
  const manager = new SpeakerManager({ store, zvuk });

  try {
    await manager.init();
    const added = await manager.add({ name: 'Тестовая', host: '127.0.0.1', port: mock.port });
    await manager.pair(added.id);
    await waitFor(
      () => {
        const sp = manager.snapshot().speakers[0];
        return sp?.status === 'connected' && sp.track ? sp : null;
      },
      { label: 'колонка подключилась' },
    );

    const queue = await manager.getQueue(added.id);
    assert.equal(queue.items.length, 3);
    assert.equal(queue.items[0].current, true);
    assert.equal(queue.items[0].title, 'Каталожный трек 1001');
    assert.deepEqual(queue.items[0].artists, ['Исполнитель']);

    const played = await manager.playContent(added.id, {
      url: 'https://zvuk.com/track/777',
    });
    assert.equal(played.ok, true);
    assert.equal(played.confirmed, true);
    assert.equal(played.content.id, '777');

    const after = await waitFor(
      () => {
        const sp = manager.snapshot().speakers[0];
        return sp.track?.trackId === '777' && sp.track.playing ? sp : null;
      },
      { label: 'колонка переключилась на трек 777' },
    );
    assert.equal(after.track.title, 'Mock Track 777');

    const queueAfter = await manager.getQueue(added.id);
    assert.equal(queueAfter.currentTrackId, '777');
    assert.equal(queueAfter.items[0].trackId, '777');
    assert.equal(queueAfter.items[0].current, true);

    const playlist = await manager.playContent(added.id, { kind: 'playlist', id: '555' });
    assert.equal(playlist.confirmed, true);
    const withPlaylist = await waitFor(
      () => {
        const sp = manager.snapshot().speakers[0];
        return sp.track?.playlistId === '555' ? sp : null;
      },
      { label: 'плейлист применился' },
    );
    assert.equal(withPlaylist.track.playlist, 'Mock playlist 555');
  } finally {
    await Promise.allSettled([...manager.runtimes.values()].map((r) => r.stop()));
    await mock.close();
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
