import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SpeakerManager } from '../lib/manager.js';
import { Store } from '../lib/store.js';
import { startMockSpeaker } from '../mock/speaker.js';
import { fitPhase, posAt, timeAt } from '../lib/multiroom.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 20_000, step = 100, label = 'условие' } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await fn();
    if (value) return value;
    await sleep(step);
  }
  throw new Error(`Не дождались: ${label}`);
}

/**
 * На реальном железе seek применяется не мгновенно: замер на SberBoom,
 * SberPortal и Mini 2 дал лаг 200–900 мс. Без компенсации каждое
 * выравнивание уводит ведомую вперёд ровно на эту величину — тест
 * проверяет, что компенсация гасит расхождение.
 */
test('Мультирум: лаг seek компенсируется, расхождение не накапливается', async () => {
  const SEEK_LAG = 600;

  const mockA = await startMockSpeaker();
  const mockB = await startMockSpeaker({ seekLatencyMs: SEEK_LAG });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sboom-lag-'));
  const store = new Store(path.join(dir, 'speakers.json'));
  const manager = new SpeakerManager({ store });

  try {
    await manager.init();
    const a = await manager.add({ name: 'Источник', host: '127.0.0.1', port: mockA.port });
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
      () => manager.snapshot().speakers.find((s) => s.id === a.id)?.track?.playing,
      { label: 'источник заиграл' },
    );
    await manager.command(a.id, 'seek', 30);
    await waitFor(
      async () => {
        const view = await manager.get(a.id).measure({ fresh: true }).catch(() => null);
        return view?.position >= 30 ? view : null;
      },
      { label: 'источник на 30-й секунде' },
    );

    await manager.startMultiroom(a.id);

    const pair = await waitFor(
      async () => {
        const [src, dst] = await Promise.all([
          manager.get(a.id).measure({ fresh: true }).catch(() => null),
          manager.get(b.id).measure({ fresh: true }).catch(() => null),
        ]);
        if (!src || !dst || src.position === null || dst.position === null) return null;
        return Math.abs(src.position - dst.position) <= 1 ? [src, dst] : null;
      },
      { label: 'ведомая догнала источник' },
    );
    assert.ok(pair[1].position >= 30, `ведомая стартовала с нуля: ${pair[1].position}`);

    // Несколько интервалов синхронизации спустя расхождение не должно
    // вырасти: именно так выглядит постоянный дрейф без компенсации лага.
    await sleep(12_000);
    const [src, dst] = await Promise.all([
      manager.get(a.id).measure({ fresh: true }).catch(() => null),
      manager.get(b.id).measure({ fresh: true }).catch(() => null),
    ]);
    assert.ok(src && dst, 'обе колонки ответили');
    const delta = Math.abs(src.position - dst.position);
    assert.ok(delta <= 1, `расхождение выросло до ${delta} c — лаг seek не компенсируется`);

    const latency = manager.multiroom._latency.get(b.id);
    assert.ok(
      Number.isFinite(latency) && latency >= 120 && latency <= 1400,
      `некорректная измеренная задержка seek: ${latency}`,
    );

    await manager.stopMultiroom();
  } finally {
    await Promise.allSettled([...manager.runtimes.values()].map((r) => r.stop()));
    await Promise.allSettled([mockA.close(), mockB.close()]);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('fitPhase: фазу можно экстраполировать между целыми секундами', () => {
  const points = [
    { x: 0, p: 10 },
    { x: 250, p: 10 },
    { x: 500, p: 11 },
    { x: 750, p: 11 },
    { x: 1000, p: 11 },
    { x: 1250, p: 12 },
  ];
  const fit = { ...fitPhase(points), tRef: 0 };
  assert.ok(fit, 'фаза должна измериться');
  // Эталон — середина последнего перехода 11→12 (x=875), то есть позиция 11.5.
  assert.ok(Math.abs(fit.pos - 11.5) < 0.001, `эталон фазы: ${fit.pos}`);

  const atPos = timeAt(fit, 11.5);
  assert.ok(Math.abs(posAt(fit, atPos + 1000) - 12.5) < 0.01, 'через секунду — следующая позиция');
  assert.ok(Math.abs(posAt(fit, atPos) - 11.5) < 0.001, 'timeAt и posAt взаимны');
});
