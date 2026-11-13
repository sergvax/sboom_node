#!/usr/bin/env node
/**
 * Перезапуск локального сервера: останавливает процесс, занявший PORT,
 * и запускает новый в фоне с логом в data/server.log.
 *
 * Нужен, когда старая копия осталась висеть после закрытия терминала:
 * в этом случае `npm start` падает с EADDRINUSE, а сервер продолжает
 * работать со старым кодом.
 *
 *   npm run restart          # остановить + запустить заново
 *   npm run restart -- --stop # только остановить
 *   PORT=3000 npm run restart
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 8080);
const logFile = path.join(root, 'data', 'server.log');
const stopOnly = process.argv.includes('--stop');

/** PID процессов, слушающих TCP-порт (macOS/Linux, lsof). */
function listeningPids(p) {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${p}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
    });
    return [...new Set(out.split(/\s+/).filter(Boolean).map(Number))];
  } catch {
    return [];
  }
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(150);
  }
  return Boolean(await predicate());
}

const pids = listeningPids(port).filter((pid) => pid !== process.pid);
if (pids.length) {
  console.log(`Останавливаю процесс на :${port} (pid ${pids.join(', ')})…`);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* процесс уже завершился */
    }
  }
  if (!(await waitFor(() => listeningPids(port).length === 0, 6000))) {
    console.log('SIGTERM не помог — завершаю принудительно.');
    for (const pid of listeningPids(port)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* ignore */
      }
    }
    await waitFor(() => listeningPids(port).length === 0, 3000);
  }
} else {
  console.log(`На :${port} никто не слушает.`);
}

if (stopOnly) {
  console.log('Сервер остановлен.');
  process.exit(0);
}

fs.mkdirSync(path.dirname(logFile), { recursive: true });
const log = fs.openSync(logFile, 'a');
const child = spawn(process.execPath, ['server.js'], {
  cwd: root,
  detached: true,
  stdio: ['ignore', log, log],
  env: process.env,
});
child.unref();

const started = await waitFor(async () => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/state`, {
      signal: AbortSignal.timeout(1000),
    });
    return res.ok;
  } catch {
    return false;
  }
}, 15000);

if (!started) {
  console.error(`Сервер не ответил на :${port}. Смотрите ${logFile}`);
  process.exit(1);
}

console.log(`Сервер запущен: http://localhost:${port}`);
console.log(`PID ${child.pid}, лог ${path.relative(root, logFile)}`);
