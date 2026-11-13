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

/**
 * Самоподписанный сертификат мок-колонки генерируется один раз на процесс в
 * изолированном temp-каталоге. `node --test` запускает тестовые файлы
 * параллельно, и общий файл в `mock/certs` давал гонку: один процесс читал
 * `key.pem`, другой в это момент переписывал `cert.pem`, и https-сервер падал
 * с «key values mismatch».
 */
let mockCerts = null;

function ensureCerts() {
  if (mockCerts) return mockCerts;
  const dir = path.join(os.tmpdir(), 'sboom-mock-certs', randomUUID());
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650',
    '-keyout', keyPath, '-out', certPath,
    '-subj', '/CN=sberboom-mock',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ], { stdio: 'ignore' });
  mockCerts = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  return mockCerts;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{port?:number, token?:string, pairDelayMs?:number, musicInCurrentApp?:boolean, pinCode?:string|null}} [opts]
 */
export async function startMockSpeaker(opts = {}) {
  const {
    port = 0,
    token = 'mock-token-0123456789abcdef',
    pairDelayMs = 250,
    musicInCurrentApp = false,
    seekLatencyMs = 0,
    pinCode = null,
    multiroomOffDelayMs = 600,
    onMultiroomStart = null,
    onMultiroomStop = null,
    // Прошивка глушит колонки, когда группа распадается.
    muteOnMultiroomOff = false,
  } = opts;
  const { key, cert } = ensureCerts();
  const server = https.createServer({ key, cert });
  const wss = new WebSocketServer({ server });

  const bt = {
    discoverable: false,
    devices: [
      { mac: 'AA:BB:CC:DD:EE:FF', name: 'Mock Phone', connected: true },
      { mac: '11:22:33:44:55:66', name: 'Mock Headphones', connected: false },
    ],
    scanned: [
      { mac: '77:88:99:AA:BB:CC', name: 'Mock Speaker', rssi: 42 },
      { mac: 'DD:EE:FF:00:11:22', name: 'Mock Watch', rssi: 76 },
    ],
  };

  // Нативный мультирум: как на прошивке, START_MULTIROOM делает колонку
  // мастером, пауза распускает группу с задержкой.
  const multiroom = {
    enabled: true,
    mode: 'NONE',
    stereoPair: { active: false, channelFromConfig: '', pairDeviceFromConfig: '' },
  };

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
    playlistId: null,
    playlistTitle: null,
    playlistType: null,
    queue: ['1001', '1002', '1003'],
  };

  const position = () => {
    if (!st.playing) return Math.round(st.position);
    return Math.min(st.duration, Math.round(st.position + (Date.now() - st.positionAt) / 1000));
  };

  const pauseClock = () => {
    st.position = position();
    st.positionAt = Date.now();
  };

  const stateJson = () => {
    const mediaApp = {
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
            playlistId: st.playlistId,
            playlistTitle: st.playlistTitle,
            playlistType: st.playlistType,
            artists: st.artists.map((name, i) => ({ id: String(i + 1), name })),
            releases: [{ id: st.releaseId, name: st.album }],
            provider: 'zvuk',
            like: st.liked,
          },
        },
      },
    };
    return JSON.stringify({
      volume: { muted: st.muted, percent: st.volume },
      multiroom,
      network: { connection_type: 'WIFI', ip: '127.0.0.1' },
      timesync: { unixtime: Date.now() / 1000 },
      sbercast: { enabled: true, devices: [] },
      capabilities_state: { led_display: { brightness: 100, turned_on: true } },
      time: { timezone_id: 'Europe/Moscow' },
      ...(musicInCurrentApp
        ? { current_app: mediaApp, background_apps: [] }
        : { background_apps: [mediaApp] }),
    });
  };

  const playerJson = () => JSON.stringify({
    artists: st.artists.map((name, i) => ({ id: String(i + 1), name })),
    duration: st.duration,
    explicit: false,
    like: st.liked,
    mediaSource: 'MUSIC',
    playbackSpeedRate: 1,
    playing: st.playing,
    playingPending: false,
    position: { tsMs: Date.now(), val: position() },
    provider: 'zvuk',
    releases: [{ id: st.releaseId, name: st.album }],
    repeatType: st.repeat,
    shuffle: st.shuffle,
    title: st.title,
    trackId: st.trackId,
    playlistId: st.playlistId,
    playlistTitle: st.playlistTitle,
    playlistType: st.playlistType,
  });

  /**
   * GetMetaData.Response: поля 1 status, 2 meta_data, 3 timestamp.
   * В meta_data — device_info, UDP-версия, состав нативной группы и
   * media_player_state_json с `position.tsMs`.
   */
  const metaResponse = () => {
    const deviceInfo = Buffer.concat([
      field(1, 2, '1.0.0-mock'),
      field(2, 2, 'mock-speaker'),
      field(3, 2, 'Mock Speaker'),
      field(4, 2, 'SberDevices'),
      field(5, 2, 'MOCK000000000001'),
    ]);
    const mrInfo = JSON.stringify({
      md: multiroom.mode === 'NONE' ? 'NONE' : 'MR',
      ...(multiroom.mode === 'MASTER' ? { master: true } : {}),
      group: [],
    });
    const meta = Buffer.concat([
      field(1, 2, deviceInfo),
      field(5, 0, 1),
      field(8, 0, 7),
      field(9, 2, mrInfo),
      field(10, 0, 4),
      field(11, 2, playerJson()),
      field(14, 2, '{}'),
    ]);
    const resp = Buffer.concat([
      field(1, 0, 1),
      field(2, 2, meta),
      field(3, 0, Date.now()),
    ]);
    return field(10, 2, resp);
  };

  const btDeviceMsg = ({ mac, name, connected }) =>
    Buffer.concat([
      field(1, 2, mac),
      field(2, 2, name || ''),
      field(3, 0, connected ? 1 : 0),
    ]);

  const btScannedMsg = ({ mac, name, rssi }) =>
    Buffer.concat([
      field(1, 2, mac),
      field(2, 2, name || ''),
      field(3, 0, Number(rssi) || 0),
    ]);

  const reply = (ws, msgId, inner) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(Buffer.concat([field(1, 0, 2), field(2, 2, msgId || randomUUID()), field(5, 2, inner)]));
  };

  /** Ответ ServerAction: поле 4 верхнего уровня (как у прошивки). */
  const replyAction = (ws, msgId, inner) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(Buffer.concat([field(1, 0, 2), field(2, 2, msgId || randomUUID()), field(4, 2, inner)]));
  };

  const playDeeplink = (ws, msgId, deeplink) => {
    const raw = String(deeplink || '');
    const tid = /[?&]tid=(\d+)/.exec(raw);
    const pid = /[?&]pid=(\d+)/.exec(raw);
    const pt = /[?&]pt=([a-z]+)/i.exec(raw)?.[1]?.toLowerCase() || 'track';

    if (tid) {
      st.trackId = tid[1];
      st.title = `Mock Track ${st.trackId}`;
      st.playlistId = null;
      st.playlistTitle = pt === 'podcast' ? 'Mock Podcast' : null;
      st.playlistType = pt === 'podcast' ? 'podcast' : null;
      st.queue = [st.trackId, String(Number(st.trackId) + 1), String(Number(st.trackId) + 2)];
    } else if (pid) {
      st.playlistId = pid[1];
      st.playlistTitle = `Mock ${pt} ${pid[1]}`;
      st.playlistType = pt;
      st.trackId = String(4000 + Number(pid[1]) % 1000);
      st.title = `Mock ${pt} track`;
      st.queue = [st.trackId, String(Number(st.trackId) + 1), String(Number(st.trackId) + 2)];
    } else {
      replyAction(ws, msgId, field(1, 2, 'BAD DEEPLINK'));
      return;
    }

    st.position = 0;
    st.positionAt = Date.now();
    st.playing = true;
    replyAction(ws, msgId, field(1, 2, 'OK'));
    pushState(ws);
    pushMeta(ws);
  };

  const pushState = (ws) => reply(ws, randomUUID(), field(12, 2, stateJson()));
  const pushMeta = (ws) => reply(ws, randomUUID(), metaResponse());

  const clients = new Set();
  let multiroomOffTimer = null;

  /** Пауза на мастере → через multiroomOffDelayMs группа распускается. */
  const scheduleMultiroomOff = () => {
    if (multiroom.mode === 'NONE') return;
    clearTimeout(multiroomOffTimer);
    multiroomOffTimer = setTimeout(() => {
      multiroom.mode = 'NONE';
      if (muteOnMultiroomOff) st.muted = true;
      onMultiroomStop?.(multiroom);
      for (const client of clients) pushState(client);
    }, multiroomOffDelayMs);
    multiroomOffTimer.unref?.();
  };

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('message', (data) => {
      const parsed = decode(Buffer.from(data));
      const msgId = parsed[2];

      // ServerAction / DEEPLINK: field(4) = {1: '{"name":"DEEPLINK",…}'}
      if (parsed[4] && typeof parsed[4] === 'object') {
        if (parsed[3] !== token) return;
        let body = null;
        try {
          body = JSON.parse(parsed[4][1]);
        } catch {
          body = null;
        }
        if (body?.name === 'DEEPLINK') {
          playDeeplink(ws, msgId, body.payload?.deeplink);
        } else {
          replyAction(ws, msgId, field(1, 2, 'UNKNOWN ACTION'));
        }
        return;
      }

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

      // PIN с экрана (pinValidateStrategy = "screen"): op=6, без токена.
      if ('6' in req) {
        if (pinCode === null) return;
        const session = req[6]?.[1];
        const code = req[6]?.[2];
        const ok = session === 'mock-session' && String(code) === String(pinCode);
        const body = ok
          ? Buffer.concat([field(1, 0, 1), field(2, 2, token)])
          : field(1, 0, 2);
        reply(ws, msgId, field(6, 2, body));
        return;
      }

      // Авторизация: без верного токена колонка молчит.
      if (parsed[3] !== token) return;

      if ('12' in req) {
        reply(ws, msgId, field(12, 2, stateJson()));
        return;
      }
      if ('10' in req) {
        reply(ws, msgId, metaResponse());
        return;
      }
      if ('17' in req) {
        const queue = st.queue.map((trackId) => ({
          explicit: false,
          trackId: Number(trackId),
        }));
        reply(ws, msgId, field(17, 2, field(5, 2, JSON.stringify(queue))));
        return;
      }
      if ('19' in req) {
        const devices = Buffer.concat(bt.devices.map((d) => field(1, 2, btDeviceMsg(d))));
        reply(ws, msgId, field(19, 2, devices));
        return;
      }
      if ('20' in req) {
        const mac = String(req[20]?.[1] ?? '');
        const cmd = Number(req[20]?.[2]);
        const index = bt.devices.findIndex((d) => d.mac === mac);
        if (index >= 0) {
          if (cmd === 0) bt.devices[index].connected = true;
          else if (cmd === 1) bt.devices[index].connected = false;
          else if (cmd === 2) bt.devices.splice(index, 1);
        }
        return;
      }
      if ('21' in req) {
        const devices = Buffer.concat(bt.scanned.map((d) => field(2, 2, btScannedMsg(d))));
        reply(ws, msgId, field(21, 2, devices));
        return;
      }
      if ('22' in req) {
        bt.discoverable = true;
        return;
      }
      if ('14' in req) {
        st.volume = Number(req[14]?.[1] ?? st.volume);
        pushState(ws);
        return;
      }
      if ('15' in req) {
        const target = Number(req[15]?.[1] ?? st.position);
        // Прошивка применяет seek не мгновенно (200–900 мс), поэтому mock
        // с seekLatencyMs>0 моделирует реальное железо.
        if (seekLatencyMs > 0) {
          setTimeout(() => {
            st.position = target;
            st.positionAt = Date.now();
            pushState(ws);
            pushMeta(ws);
          }, seekLatencyMs);
          return;
        }
        st.position = target;
        st.positionAt = Date.now();
        pushState(ws);
        pushMeta(ws);
        return;
      }
      if ('16' in req) {
        // STOP_MULTIROOM (oneof command = 3, Empty): роспуск группы сразу,
        // не дожидаясь таймаута после паузы.
        if (req[16] && typeof req[16] === 'object' && '3' in req[16]) {
          clearTimeout(multiroomOffTimer);
          multiroom.mode = 'NONE';
          if (muteOnMultiroomOff) st.muted = true;
          st.playing = false;
          onMultiroomStop?.(multiroom);
          reply(ws, msgId, field(16, 2, Buffer.alloc(0)));
          pushState(ws);
          pushMeta(ws);
          return;
        }
        const action = Number(req[16]?.[1]);
        if (action === 8) {
          // START_MULTIROOM: без активного источника прошивка отказывает.
          if (!st.playing) {
            reply(ws, msgId, field(16, 2, field(1, 0, 1)));
            return;
          }
          clearTimeout(multiroomOffTimer);
          multiroom.mode = 'MASTER';
          onMultiroomStart?.(multiroom);
          reply(ws, msgId, field(16, 2, Buffer.alloc(0)));
          pushState(ws);
          pushMeta(ws);
          return;
        }
        switch (action) {
          case 4: st.positionAt = Date.now(); st.playing = true; break;
          case 5: pauseClock(); st.playing = false; scheduleMultiroomOff(); break;
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
    bt,
    multiroom,
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
