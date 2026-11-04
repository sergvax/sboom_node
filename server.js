/**
 * SberBoom Standalone — локальный HTTP-сервер + SSE + веб-интерфейс.
 * Без Home Assistant: один процесс Node.js, состояние в памяти, токены в data/.
 */
import express from 'express';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Store } from './lib/store.js';
import { SpeakerManager } from './lib/manager.js';
import { discover } from './lib/discovery.js';
import { ZvukClient } from './lib/zvuk.js';
import { SearchHistory } from './lib/history.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'speakers.json');
const HISTORY_FILE =
  process.env.HISTORY_FILE || path.join(path.dirname(DATA_FILE), 'search-history.json');

const store = new Store(DATA_FILE);
const zvuk = new ZvukClient({ dataDir: path.join(__dirname, 'data') });
const history = new SearchHistory({ file: HISTORY_FILE });
const manager = new SpeakerManager({ store, zvuk });

const app = express();
app.disable('etag');
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: 0 }));

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    const message = err?.message || 'Внутренняя ошибка';
    const explicit = Number(err?.status);
    const status =
      Number.isInteger(explicit) && explicit >= 400 && explicit <= 599
        ? explicit
        : /не найдена|не найдено/i.test(message)
          ? 404
          : 400;
    res.status(status).json({ error: message });
  }
};

app.get('/api/state', wrap(async (_req, res) => {
  res.json(manager.snapshot());
}));

app.get('/api/discover', wrap(async (_req, res) => {
  res.json({ devices: await discover(4000) });
}));

// ───────────────────────────── каталог Звука ─────────────────────────────

app.get('/api/search', wrap(async (req, res) => {
  const query = String(req.query.q || '').trim();
  if (!query) throw new Error('Введите поисковый запрос');
  const limit = Math.max(1, Math.min(12, Number(req.query.limit) || 6));
  const result = await zvuk.search(query, { limit });
  res.json(result);
}));

app.get('/api/speakers/:id/queue', wrap(async (req, res) => {
  res.json(await manager.getQueue(req.params.id));
}));

// ───────────────────────────── bluetooth ─────────────────────────────

app.get('/api/speakers/:id/bluetooth', wrap(async (req, res) => {
  const bt = await manager.bluetoothInfo(req.params.id);
  res.json({ bt, state: manager.snapshot() });
}));

app.post('/api/speakers/:id/bluetooth/discoverable', wrap(async (req, res) => {
  const bt = await manager.bluetoothDiscoverable(req.params.id);
  res.json({ bt, state: manager.snapshot() });
}));

app.post('/api/speakers/:id/bluetooth/scan', wrap(async (req, res) => {
  const bt = await manager.bluetoothScan(req.params.id);
  res.json({ bt, state: manager.snapshot() });
}));

app.post('/api/speakers/:id/bluetooth/command', wrap(async (req, res) => {
  const { mac, command } = req.body || {};
  const bt = await manager.bluetoothCommand(req.params.id, mac, command);
  res.json({ bt, state: manager.snapshot() });
}));

// История запусков из поиска: только то, что пользователь сам нашёл и включил.
app.get('/api/history', wrap(async (req, res) => {
  const limit = Math.max(1, Math.min(60, Number(req.query.limit) || 30));
  res.json({ items: await history.list({ limit }) });
}));

app.delete('/api/history', wrap(async (_req, res) => {
  await history.clear();
  res.json({ ok: true });
}));

app.post('/api/speakers/:id/play', wrap(async (req, res) => {
  const { kind, id, url, origin, meta } = req.body || {};
  const result = await manager.playContent(req.params.id, { kind, id, url });

  // В историю попадают только осознанные запуски из поиска/истории.
  if (origin === 'search' || origin === 'history') {
    const source = meta && typeof meta === 'object' ? meta : {};
    await history
      .record({
        kind: result.content?.kind || source.kind,
        id: result.content?.id || source.id,
        title: source.title || result.content?.title,
        subtitle: source.subtitle || result.content?.subtitle,
        cover: source.cover || result.content?.cover,
        duration: source.duration ?? result.content?.duration,
      })
      .catch(() => {
        /* история не должна ломать запуск */
      });
  }

  res.json({ ...result, state: manager.snapshot() });
}));

app.post('/api/speakers', wrap(async (req, res) => {
  const { name, host, port } = req.body || {};
  if (!host) throw new Error('Укажите IP-адрес колонки');
  const speaker = await manager.add({ name, host, port });
  res.status(201).json(speaker);
}));

app.patch('/api/speakers/:id', wrap(async (req, res) => {
  await manager.rename(req.params.id, req.body?.name);
  res.json({ ok: true });
}));

app.delete('/api/speakers/:id', wrap(async (req, res) => {
  await manager.remove(req.params.id);
  res.json({ ok: true });
}));

app.post('/api/speakers/:id/pair', wrap(async (req, res) => {
  const runtime = manager.get(req.params.id);
  if (runtime.pairing.active) {
    res.status(409).json({ error: 'Сопряжение уже идёт' });
    return;
  }
  runtime.pair().catch(() => {
    /* ошибка уже отражена в состоянии колонки */
  });
  res.status(202).json({ started: true });
}));

app.post('/api/speakers/:id/command', wrap(async (req, res) => {
  const { command, value } = req.body || {};
  if (!command) throw new Error('Не указана команда');
  await manager.command(req.params.id, command, value);
  res.json(manager.get(req.params.id).snapshot());
}));

app.post('/api/group/command', wrap(async (req, res) => {
  const { command, value, ids } = req.body || {};
  if (!command) throw new Error('Не указана команда');
  const result = await manager.groupCommand(command, value, Array.isArray(ids) ? ids : null);
  res.json({ ...result, state: manager.snapshot() });
}));

// ───────────────────────────── мультирум ─────────────────────────────

app.post('/api/multiroom/start', wrap(async (req, res) => {
  const { sourceId } = req.body || {};
  const multiroom = await manager.startMultiroom(sourceId);
  res.json({ multiroom, state: manager.snapshot() });
}));

app.post('/api/multiroom/stop', wrap(async (_req, res) => {
  const multiroom = await manager.stopMultiroom();
  res.json({ multiroom, state: manager.snapshot() });
}));

app.post('/api/multiroom/leave', wrap(async (req, res) => {
  const { id } = req.body || {};
  if (!id) throw new Error('Не указана колонка');
  const multiroom = await manager.leaveMultiroom(id);
  res.json({ multiroom, state: manager.snapshot() });
}));

// Server-Sent Events: живые обновления состояния.
app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write('retry: 2000\n\n');

  const send = () => {
    try {
      res.write(`data: ${JSON.stringify(manager.snapshot())}\n\n`);
    } catch {
      /* клиент ушёл */
    }
  };
  send();
  manager.on('change', send);
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* ignore */
    }
  }, 15000);
  ping.unref?.();

  req.on('close', () => {
    clearInterval(ping);
    manager.off('change', send);
  });
});

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (iface.family === 'IPv4' && !iface.internal) out.push(iface.address);
    }
  }
  return out;
}

async function main() {
  await manager.init();
  const server = app.listen(PORT, HOST, () => {
    console.log('');
    console.log('  SberBoom Standalone');
    console.log(`  локально:   http://localhost:${PORT}`);
    for (const ip of lanAddresses()) console.log(`  в сети:     http://${ip}:${PORT}`);
    console.log(`  колонок:    ${manager.runtimes.size}`);
    console.log('');
  });

  const shutdown = async (signal) => {
    console.log(`\n${signal}: останавливаемся…`);
    server.close();
    await Promise.allSettled([...manager.runtimes.values()].map((r) => r.stop()));
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Не удалось запустить сервер:', err);
  process.exit(1);
});
