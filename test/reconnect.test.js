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

test('SpeakerClient: внешний close() всегда эмитит closed ровно один раз', async () => {
  const mock = await startMockSpeaker();
  try {
    const client = new SpeakerClient({ host: '127.0.0.1', port: mock.port, token: mock.token });
    await client.connect();
    assert.equal(client.connected, true);

    let closed = 0;
    client.on('closed', () => {
      closed += 1;
    });
    // Внешний close() без pending-запросов — именно так клиент закрывает
    // _pollState после серии таймаутов. Событие не должно теряться.
    await client.close();
    assert.equal(closed, 1);
    assert.equal(client.connected, false);

    // Повторный close() не должен дублировать событие.
    await client.close();
    assert.equal(closed, 1);
  } finally {
    await mock.close();
  }
});

test('SpeakerRuntime: переподключается, если клиент закрыли извне', async () => {
  const mock = await startMockSpeaker();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sboom-reconnect-'));
  const store = new Store(path.join(dir, 'speakers.json'));
  const manager = new SpeakerManager({ store });

  try {
    await manager.init();
    const added = await manager.add({ name: 'Колонка', host: '127.0.0.1', port: mock.port });
    await manager.pair(added.id);

    const runtime = manager.get(added.id);
    const firstClient = await waitFor(
      () => (runtime.status === 'connected' ? runtime.client : null),
      { label: 'первое подключение' },
    );

    // Имитируем путь _pollState: закрываем клиент снаружи, не дожидаясь
    // события от сокета. Supervisor обязан это заметить и создать новый.
    await firstClient.close();

    const secondClient = await waitFor(
      () =>
        runtime.status === 'connected' && runtime.client !== firstClient && runtime.client?.connected
          ? runtime.client
          : null,
      { label: 'переподключение после внешнего close()' },
    );
    assert.notEqual(secondClient, firstClient);
  } finally {
    for (const runtime of manager.runtimes.values()) {
      await runtime.stop().catch(() => {});
    }
    await mock.close();
  }
});
