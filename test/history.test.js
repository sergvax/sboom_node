import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SearchHistory } from '../lib/history.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function tmpFile(name = 'search-history.json') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sboom-history-'));
  return path.join(dir, name);
}

test('SearchHistory: запись, дедупликация и сохранение на диск', async () => {
  const file = await tmpFile();
  const history = new SearchHistory({ file });

  await history.record({ kind: 'track', id: '1', title: 'Первый', subtitle: 'Артист', duration: 200 });
  await sleep(3);
  await history.record({ kind: 'playlist', id: '2', title: 'Плейлист' });
  await sleep(3);
  await history.record({
    kind: 'track',
    id: '1',
    title: 'Первый (обновлён)',
    subtitle: 'Артист',
    cover: 'https://cdn-image.zvuk.com/cover.jpg',
    duration: 201,
  });

  const items = await history.list();
  assert.equal(items.length, 2);
  assert.equal(items[0].id, '1');
  assert.equal(items[0].count, 2);
  assert.equal(items[0].title, 'Первый (обновлён)');
  assert.equal(items[0].duration, 201);
  assert.equal(items[1].id, '2');

  // Новый экземпляр читает тот же файл.
  const second = new SearchHistory({ file });
  const restored = await second.list();
  assert.equal(restored.length, 2);
  assert.equal(restored.find((item) => item.id === '1').count, 2);

  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.items.length, 2);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test('SearchHistory: частые запуски, лимит и устойчивость к мусору', async () => {
  const file = await tmpFile();
  const history = new SearchHistory({ file });

  for (let i = 0; i < 3; i += 1) {
    await history.record({ kind: 'track', id: '7', title: 'Частый' });
    await sleep(2);
  }
  await history.record({ kind: 'artist', id: '8', title: 'Артист' });
  await sleep(2);
  await history.record({ kind: 'release', id: '9', title: 'Альбом' });

  const all = await history.list({ limit: 60 });
  assert.equal(all.length, 3);
  assert.equal(all.find((item) => item.id === '7').count, 3);

  const recent = await history.list({ limit: 2 });
  assert.equal(recent.length, 2);

  // Некорректные данные не попадают в историю.
  assert.equal(await history.record({ kind: 'unknown', id: '1', title: 'Нет' }), null);
  assert.equal(await history.record({ kind: 'track', id: 'abc', title: 'Нет' }), null);
  const unsafeCover = await history.record({
    kind: 'track',
    id: '5',
    cover: 'javascript:alert(1)',
  });
  assert.equal(unsafeCover.cover, null);

  // Битый файл не ломает чтение.
  await fs.writeFile(file, '{ not json', 'utf8');
  const broken = new SearchHistory({ file });
  assert.deepEqual(await broken.list(), []);
});

test('SearchHistory: очистка и ограничение размера', async () => {
  const file = await tmpFile();
  const history = new SearchHistory({ file, maxItems: 10 });

  for (let i = 1; i <= 14; i += 1) {
    await history.record({ kind: 'track', id: String(i), title: `Трек ${i}` });
  }

  const all = await history.list({ limit: 60 });
  assert.equal(all.length, 10);

  await history.clear();
  assert.deepEqual(await history.list(), []);

  const restored = new SearchHistory({ file });
  assert.deepEqual(await restored.list(), []);
});
