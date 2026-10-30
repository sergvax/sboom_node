/**
 * Mock-колонка SberBoom для локальной разработки и e2e-тестов.
 *
 *   node mock/speaker.js            # wss://0.0.0.0:20000, токен mock-token-…
 *
 * Генерирует самоподписанный сертификат через openssl и ведёт себя как
 * прошивка: pair → ждёт «+» → выдаёт токен, отдаёт state/metadata,
 * принимает команды и пушит обновления.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { field, decode } from '../lib/tlv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function ensureCerts() {
  const dir = path.join(__dirname, 'certs');
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650',
      '-keyout', keyPath, '-out', certPath,
      '-subj', '/CN=sberboom-mock',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ], { stdio: 'ignore' });
  }
  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{port?:number, token?:string, pairDelayMs?:number}} [opts]
 */
export async function startMockSpeaker(opts = {}) {
  const { port = 0, token = 'mock-token-0123456789abcdef', pairDelayMs = 250 } = opts;
  const { key, cert } = ensureCerts();
  const server = https.createServer({ key, cert });
  const wss = new WebSocketServer({ server });

  const st = {
    volume: 20,
    muted: false,
    playing: false,
    trackId: '1001',
    title: 'Mock Track',
    artists: ['Mock Artist'],
    album: 'Mock Album',
    releaseId: '200',
    duration: 240,
    position: 0,
    positionAt: Date.now(),
    shuffle: false,
    repeat: 'none',
    liked: false,
  };

  const position = () => {
    if (!st.playing) return Math.round(st.position);
    return Math.min(st.duration, Math.round(st.position + (Date.now() - st.positionAt) / 1000));
  };

  const pauseClock = () => {
    st.position = position();
    st.positionAt = Date.now();
  };

  const stateJson = () => JSON.stringify({
    volume: { muted: st.muted, percent: st.volume },
    network: { connection_type: 'WIFI', ip: '127.0.0.1' },
    capabilities_state: { led_display: { brightness: 100, turned_on: true } },
    time: { timezone_id: 'Europe/Moscow' },
    background_apps: [
      {
        app_info: { systemName: 'music' },
        state: {
          player: {
            playing: st.playing,
            position: position(),
            duration: st.duration,
            shuffle: st.shuffle,
            repeatType: st.repeat,
            mode: 'music',
            info: {
              title: st.title,
              trackId: st.trackId,
              artists: st.artists.map((name, i) => ({ id: String(i + 1), name })),
              releases: [{ id: st.releaseId, name: st.album }],
              provider: 'zvuk',
              like: st.liked,
            },
          },
        },
      },
    ],
  });

  const trackJson = () => JSON.stringify({
    artists: st.artists.map((name, i) => ({ id: String(i + 1), name })),
    duration: st.duration,
    explicit: false,
    like: st.liked,
    mediaSource: 'MUSIC',
    playbackSpeedRate: 1,
    playing: st.playing,
    position: { tsMs: Date.now(), val: position() },
    provider: 'zvuk',
    releases: [{ id: st.releaseId, name: st.album }],
    repeatType: st.repeat,
    shuffle: st.shuffle,
    title: st.title,
    trackId: st.trackId,
  });

  const reply = (ws, msgId, inner) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(Buffer.concat([field(1, 0, 2), field(2, 2, msgId || randomUUID()), field(5, 2, inner)]));
  };

  const pushState = (ws) => reply(ws, randomUUID(), field(12, 2, stateJson()));
  const pushMeta = (ws) => reply(ws, randomUUID(), field(10, 2, trackJson()));

  const clients = new Set();

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('message', (data) => {
      const parsed = decode(Buffer.from(data));
      const msgId = parsed[2];
      const req = parsed[5];
      if (!req || typeof req !== 'object') return;

      // pair-init
      if ('4' in req) {
        reply(ws, msgId, field(4, 2, Buffer.concat([field(1, 0, 1), field(2, 2, 'mock-session')])));
        setTimeout(() => {
          reply(
            ws,
            randomUUID(),
            field(4, 2, Buffer.concat([field(1, 0, 2), field(2, 2, token)])),
          );
        }, pairDelayMs);
        return;
      }

      // Авторизация: без верного токена колонка молчит.
      if (parsed[3] !== token) return;

      if ('12' in req) {
        reply(ws, msgId, field(12, 2, stateJson()));
        return;
      }
      if ('10' in req) {
        reply(ws, msgId, field(10, 2, trackJson()));
        return;
      }
      if ('14' in req) {
        st.volume = Number(req[14]?.[1] ?? st.volume);
        pushState(ws);
        return;
      }
      if ('15' in req) {
        st.position = Number(req[15]?.[1] ?? st.position);
        st.positionAt = Date.now();
        pushState(ws);
        pushMeta(ws);
        return;
      }
      if ('16' in req) {
        const action = Number(req[16]?.[1]);
        switch (action) {
          case 4: st.positionAt = Date.now(); st.playing = true; break;
          case 5: pauseClock(); st.playing = false; break;
          case 2: st.trackId = String(Number(st.trackId) + 1); st.title = `Mock Track ${st.trackId}`; st.position = 0; st.positionAt = Date.now(); break;
          case 3: st.trackId = String(Math.max(1, Number(st.trackId) - 1)); st.title = `Mock Track ${st.trackId}`; st.position = 0; st.positionAt = Date.now(); break;
          case 0: st.muted = true; break;
          case 1: st.muted = false; break;
          case 6: st.liked = true; break;
          case 7: st.liked = false; break;
          case 9: st.shuffle = true; break;
          case 10: st.shuffle = false; break;
          case 11: st.repeat = 'none'; break;
          case 12: st.repeat = 'playlist'; break;
          case 13: st.repeat = 'track'; break;
          default: break;
        }
        pushState(ws);
        pushMeta(ws);
        return;
      }
      if ('18' in req) {
        reply(ws, msgId, Buffer.alloc(0));
      }
    });
  });

  await new Promise((resolve) => server.listen(port, '0.0.0.0', resolve));
  const actualPort = server.address().port;

  return {
    port: actualPort,
    token,
    state: st,
    async close() {
      for (const ws of clients) {
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
      }
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT || 20000);
  const mock = await startMockSpeaker({ port });
  console.log(`mock SberBoom: wss://0.0.0.0:${port}  token=${mock.token}`);
  console.log('Добавьте 127.0.0.1 в интерфейсе и нажмите «Сопрячь» — «+» жать не нужно.');
  await sleep(1e9);
}
