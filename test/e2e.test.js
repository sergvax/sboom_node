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

