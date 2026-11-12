/**
 * WebSocket-клиент одной колонки SberBoom.
 * wss://<host>:20000/ + бинарный TLV. Порт api.py интеграции sboom_ha.
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

import { decode, field } from './tlv.js';
import { parsePairedBt, parseQueue, parseScannedBt, parseState, parseTrack, parseMetaInfo } from './parsers.js';
import {
  BT_CMD,
  DEFAULT_PORT,
  DEFAULT_USER_AGENT,
  DIRECTIVE_SHOW_YOUTUBE,
  ENVELOPE_FIELD_MSG_ID,
  ENVELOPE_FIELD_REQUEST_DATA,
  KEEPALIVE_INTERVAL_SEC,
  MEDIA_CMD,
  MESSAGE_TYPE_STAR_COMMAND,
  OP_BT_DEVICE_COMMAND,
  OP_BT_DISCOVERABLE,
  OP_CONFIRM_PIN_CONNECT,
  OP_GET_META_DATA,
  OP_GET_PAIRED_BT,
  OP_GET_PLAYING_QUEUE,
  OP_GET_SCANNED_BT,
  OP_GET_STATE,
  OP_KEEP_ALIVE,
  OP_MEDIA_COMMAND,
  OP_PIN_CONNECT,
  OP_SET_PLAYBACK_SPEED,
  OP_SET_TRACK_POS,
  OP_SET_VOLUME,
  PAIR_CONFIRM_ATTEMPTS_LIMIT,
  PLAYER_STATUS_OK,
  PAIR_CONFIRM_BAD_SESSION,
  PAIR_CONFIRM_DISABLED,
  PAIR_CONFIRM_OK,
  PAIR_CONFIRM_REJECTED,
  PAIR_CONFIRM_WRONG_PIN,
  PAIR_STATUS_AUTHORIZED,
  PAIR_STATUS_BUSY,
  PAIR_STATUS_DISABLED,
  PAIR_STATUS_ERROR,
  PAIR_STATUS_TOO_MANY_REQUESTS,
  PAIR_STATUS_WAITING,
  PAIR_TIMEOUT_MS,
  REPEAT_CMD,
  REPEAT_TO_CANONICAL,
  STAR_COMMAND_MEDIUM_WIFI,
  STAR_COMMAND_MULTI_ROOM_MESSAGE,
  STAR_COMMAND_SHOW_YOUTUBE,
  TOKEN_TYPE_PIN_AUTH,
} from './protocol.js';

export class RequestTimeout extends Error {
  constructor(message = 'Колонка не ответила (таймаут)') {
    super(message);
    this.name = 'RequestTimeout';
  }
}

const EMPTY = Buffer.alloc(0);
const stateRequest = () => field(OP_GET_STATE, 2, field(1, 2, EMPTY));
const metadataRequest = () => field(OP_GET_META_DATA, 2, field(1, 2, EMPTY));
const queueRequest = () => field(OP_GET_PLAYING_QUEUE, 2, field(1, 2, EMPTY));
const pairedBtRequest = () => field(OP_GET_PAIRED_BT, 2, field(1, 2, EMPTY));
const scannedBtRequest = () => field(OP_GET_SCANNED_BT, 2, field(1, 2, EMPTY));
const btDiscoverableRequest = () => field(OP_BT_DISCOVERABLE, 2, field(1, 2, EMPTY));
const keepAliveRequest = () => field(OP_KEEP_ALIVE, 2, field(1, 2, EMPTY));

export class SpeakerClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.host
   * @param {number} [opts.port]
   * @param {string|null} [opts.token]
   * @param {string} [opts.clientId]
   * @param {string} [opts.clientName]
   */
  constructor({ host, port = DEFAULT_PORT, token = null, clientId = null, clientName = 'Sboom' }) {
    super();
    this.host = host;
    this.port = port;
    this.token = token;
    this.clientId = clientId || randomUUID();
    this.clientName = clientName;

    this.ws = null;
    this._open = false;
    this._pending = new Map();
    this._pairCtx = null;
    this._pinCtx = null;
    this._heartbeat = null;
    this._lastPong = 0;
    this._closing = false;
    // Одно соединение — одно событие 'closed'. Без флага внешний close()
    // (например, после серии неудачных опросов) не эмитил событие, и
    // supervisor навсегда зависал в ожидании обрыва.
    this._closeHandled = false;
  }

  get connected() {
    return Boolean(this.ws && this._open && this.ws.readyState === WebSocket.OPEN);
  }

  connect() {
    return new Promise((resolve, reject) => {
      const url = `wss://${this.host}:${this.port}/`;
      let settled = false;
      const ws = new WebSocket(url, {
        rejectUnauthorized: false,
        handshakeTimeout: 10_000,
        headers: { 'User-Agent': DEFAULT_USER_AGENT },
      });
      this.ws = ws;
      this._closing = false;
      this._closeHandled = false;

      const fail = (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      ws.on('open', () => {
        if (settled) return;
        settled = true;
        this._open = true;
        this._lastPong = Date.now();
        this._startHeartbeat();
        resolve();
      });
      ws.on('message', (data) => this._onMessage(data));
      ws.on('pong', () => {
        this._lastPong = Date.now();
      });
      ws.on('error', (err) => {
        if (!settled) fail(err);
      });
      ws.on('close', () => {
        if (!settled) fail(new Error('Соединение закрыто колонкой'));
        this._handleClose();
      });
    });
  }

  async close() {
    this._closing = true;
    this._stopHeartbeat();
    this._rejectPair(new Error('Соединение закрыто'));
    this._rejectPin(new Error('Соединение закрыто'));
    const ws = this.ws;
    this.ws = null;
    this._open = false;
    if (ws) {
      try {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 1500);
          ws.once('close', () => {
            clearTimeout(timer);
            resolve();
          });
          ws.close();
        });
      } catch {
        /* ignore */
      }
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
    }
    this._handleClose();
  }

  _handleClose() {
    // Всегда ровно одно 'closed' на соединение. Раньше при внешнем close()
    // (когда _open уже сброшен и нет pending-запросов) событие не уходило,
    // и supervisor вечно ждал обрыва — колонка оставалась «мёртвой» до
    // перезапуска процесса.
    if (this._closeHandled) return;
    this._closeHandled = true;
    this._open = false;
    this._stopHeartbeat();
    for (const [, entry] of this._pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Соединение с колонкой потеряно'));
    }
    this._pending.clear();
    this._rejectPair(new Error('Соединение с колонкой потеряно'));
    this._rejectPin(new Error('Соединение с колонкой потеряно'));
    this.emit('closed');
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    const intervalMs = KEEPALIVE_INTERVAL_SEC * 1000;
    this._heartbeat = setInterval(() => {
      if (!this.connected) return;
      if (Date.now() - this._lastPong > intervalMs * 2.5) {
        // Half-open TCP: ответов на ping нет — рвём, супервизор переподключится.
        try {
          this.ws.terminate();
        } catch {
          /* ignore */
        }
        return;
      }
      try {
        this.ws.ping();
      } catch {
        /* ignore */
      }
    }, intervalMs);
    this._heartbeat.unref?.();
  }

  _stopHeartbeat() {
    if (this._heartbeat) {
      clearInterval(this._heartbeat);
      this._heartbeat = null;
    }
  }

  _envelope(msgId, requestData, token = this.token) {
    const parts = [field(1, 0, 2), field(2, 2, msgId)];
    if (token) parts.push(field(3, 2, token));
    parts.push(
      field(5, 2, requestData),
      field(6, 0, TOKEN_TYPE_PIN_AUTH),
      field(7, 2, this.clientName),
      field(10, 0, 1),
      field(11, 2, this.clientId),
    );
    return Buffer.concat(parts);
  }

  _onMessage(data) {
    let raw;
    try {
      raw = Buffer.isBuffer(data) ? data : Buffer.from(data);
    } catch {
      return;
    }
    let parsed;
    try {
      parsed = decode(raw);
    } catch {
      return;
    }

    const msgId = parsed[ENVELOPE_FIELD_MSG_ID];
    if (typeof msgId === 'string' && this._pending.has(msgId)) {
      const entry = this._pending.get(msgId);
      this._pending.delete(msgId);
      clearTimeout(entry.timer);
      entry.resolve(raw);
      return;
    }

    if (this._pairCtx) {
      this._handlePairMessage(parsed);
      return;
    }

    if (this._pinCtx) {
      this._handlePinMessage(parsed);
      return;
    }

    this.emit('event', raw, parsed);
  }

  _send(raw) {
    return new Promise((resolve, reject) => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Колонка не подключена'));
        return;
      }
      ws.send(raw, (err) => (err ? reject(err) : resolve()));
    });
  }

  async _request(requestData, timeoutMs = 5000) {
    if (!this.connected) throw new Error('Колонка не подключена');
    const msgId = randomUUID();
    const packet = this._envelope(msgId, requestData);
    const raw = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(msgId);
        reject(new RequestTimeout());
      }, timeoutMs);
      this._pending.set(msgId, { resolve, reject, timer });
      this._send(packet).catch((err) => {
        clearTimeout(timer);
        this._pending.delete(msgId);
        reject(err);
      });
    });
    return raw;
  }

  async _fireAndForget(requestData) {
    await this._send(this._envelope(randomUUID(), requestData));
  }

  // ─────────────────────────── server actions ───────────────────────────

  /**
   * ServerAction / DEEPLINK канал: конверт type=1, payload в field(4).
   * Порт _deeplink.py интеграции sboom_ha.
   *
   * @param {string} msgId
   * @param {string} name
   * @param {Record<string, any>} payload
   * @param {Record<string, string>|null} [smartAppInfo] 6 camelCase-полей
   */
  _serverActionEnvelope(msgId, name, payload, smartAppInfo = null) {
    const body = {
      name,
      payload,
      smartAppInfo: {
        appVersionId: '',
        applicationId: '',
        frontendEndpoint: '',
        frontendType: '',
        projectId: '',
        systemName: '',
        ...(smartAppInfo || {}),
      },
      type: 1,
    };
    const parts = [field(1, 0, 1), field(2, 2, msgId)];
    if (this.token) parts.push(field(3, 2, this.token));
    parts.push(
      field(4, 2, field(1, 2, JSON.stringify(body))),
      field(6, 0, TOKEN_TYPE_PIN_AUTH),
      field(7, 2, this.clientName),
      field(10, 0, 1),
      field(11, 2, this.clientId),
    );
    return Buffer.concat(parts);
  }

  /**
   * @param {string} name
   * @param {Record<string, any>} payload
   * @param {number} [timeoutMs]
   * @param {Record<string, string>|null} [smartAppInfo]
   * @returns {Promise<Record<string, any>|string>} field(4) ответа: {1:'OK'} или текст ошибки
   */
  async sendServerAction(name, payload, timeoutMs = 6000, smartAppInfo = null) {
    if (!this.connected) throw new Error('Колонка не подключена');
    const msgId = randomUUID();
    const packet = this._serverActionEnvelope(msgId, name, payload, smartAppInfo);
    const raw = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(msgId);
        reject(new RequestTimeout());
      }, timeoutMs);
      this._pending.set(msgId, { resolve, reject, timer });
      this._send(packet).catch((err) => {
        clearTimeout(timer);
        this._pending.delete(msgId);
        reject(err);
      });
    });
    const parsed = decode(raw);
    return parsed[4] ?? {};
  }

  /** Проиграть staros:// deeplink (например, `staros://music?tid=<id>&pt=track`). */
  async playDeeplink(url) {
    const result = await this.sendServerAction('DEEPLINK', { deeplink: url });
    const ok =
      typeof result === 'string'
        ? result.includes('OK')
        : Boolean(result && typeof result === 'object' && Object.values(result).some((v) => typeof v === 'string' && v.includes('OK')));
    return { ok, result };
  }

  /**
   * Показать YouTube на устройстве с экраном (SberBox/Portal).
   * `videoId` открывает конкретное видео, `searchQuery` — поиск, без аргументов
   * просто открывает приложение. Это директива type=1, приёмник сам превратит
   * её в StarCommand.
   *
   * @param {{videoId?: string, searchQuery?: string}} [opts]
   */
  async showYoutube({ videoId, searchQuery } = {}) {
    const payload = videoId
      ? { videoId: String(videoId) }
      : searchQuery
        ? { searchQuery: String(searchQuery) }
        : {};
    const result = await this.sendServerAction(DIRECTIVE_SHOW_YOUTUBE, payload);
    const ok =
      typeof result === 'string'
        ? result.includes('OK')
        : Boolean(result && typeof result === 'object' && Object.values(result).some((v) => typeof v === 'string' && v.includes('OK')));
    return { ok, result };
  }

  // ────────────────────────────── pair flow ──────────────────────────────

  /**
   * Pair-handshake: пользователь нажимает «+» на корпусе колонки.
   * @param {(status: string) => void} [onStatus]
   * @returns {Promise<string>} pin-токен
   */
  pair(onStatus = () => {}) {
    if (this._pairCtx) return Promise.reject(new Error('Pair уже выполняется'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._rejectPair(new Error("Кнопка «+» не была нажата за 2 минуты"));
      }, PAIR_TIMEOUT_MS);

      this._pairCtx = { resolve, reject, timer, onStatus };
      const reqId = randomUUID();
      const packet = this._envelope(
        reqId,
        field(OP_PIN_CONNECT, 2, field(1, 2, EMPTY)),
        null, // при спаривании токена ещё нет
      );
      this._send(packet).catch((err) => this._rejectPair(err));
    });
  }

  _resolvePair(token) {
    if (!this._pairCtx) return;
    const ctx = this._pairCtx;
    this._pairCtx = null;
    clearTimeout(ctx.timer);
    this.token = token;
    ctx.resolve(token);
  }

  _rejectPair(err) {
    if (!this._pairCtx) return;
    const ctx = this._pairCtx;
    this._pairCtx = null;
    clearTimeout(ctx.timer);
    ctx.reject(err);
  }

  _handlePairMessage(parsed) {
    const ctx = this._pairCtx;
    if (!ctx) return;
    const reqData = parsed[ENVELOPE_FIELD_REQUEST_DATA];
    if (!reqData || typeof reqData !== 'object') return;

    const first = reqData[OP_PIN_CONNECT];
    if (first && typeof first === 'object') {
      const status = first[1];
      const payload = first[2];
      if (status === PAIR_STATUS_AUTHORIZED) {
        if (typeof payload === 'string' && payload.length >= 16) {
          this._resolvePair(payload);
          return;
        }
      } else if (status === PAIR_STATUS_WAITING) {
        ctx.onStatus?.('waiting');
        return;
      } else if (status === PAIR_STATUS_BUSY) {
        this._rejectPair(new Error('На колонке уже активна пара. Попробуйте позже.'));
        return;
      } else if (status === PAIR_STATUS_TOO_MANY_REQUESTS) {
        this._rejectPair(new Error('Слишком много запросов на сопряжение. Подождите.'));
        return;
      } else if (status === PAIR_STATUS_DISABLED) {
        this._rejectPair(new Error('Режим сопряжения отключён на колонке'));
        return;
      } else if (status === PAIR_STATUS_ERROR) {
        this._rejectPair(new Error('Колонка вернула ошибку сопряжения'));
        return;
      }
    }

    const confirm = reqData[6];
    if (confirm && typeof confirm === 'object') {
      const status = confirm[1];
      if (status === PAIR_CONFIRM_OK) {
        const token = confirm[2];
        if (typeof token === 'string' && token.length >= 16) {
          this._resolvePair(token);
          return;
        }
      } else if (status === PAIR_CONFIRM_REJECTED) {
        this._rejectPair(new Error('Колонка отклонила сопряжение'));
      } else if (status === PAIR_CONFIRM_ATTEMPTS_LIMIT) {
        this._rejectPair(new Error('Превышено число попыток ввода PIN'));
      } else if (status === PAIR_CONFIRM_BAD_SESSION) {
        this._rejectPair(new Error('Сессия сопряжения устарела'));
      } else if (status === PAIR_CONFIRM_DISABLED) {
        this._rejectPair(new Error('PIN-сопряжение отключено на колонке'));
      }
    }
  }

  /**
   * Сопряжение по PIN с экрана (pinValidateStrategy = "screen").
   *
   * 1) op=4 PinConnect.Request{} → ответ со status=INPUT_PIN_CODE и
   *    pin_connection_session;
   * 2) op=6 ConfirmPinConnect.Request{session, pin_code} → AUTHORIZED + токен.
   *
   * Ответ приходит отдельным сообщением и может не эхо-ить `id` запроса,
   * поэтому, как и в кнопочном `pair()`, используется контекст, а не `_request`.
   * Не конфликтует с кнопочным `pair()`.
   *
   * @param {string} pinCode 4-значный код с экрана устройства
   * @param {(status: string) => void} [onStatus]
   * @returns {Promise<string>} PIN-токен
   */
  pairWithPin(pinCode, onStatus = () => {}) {
    if (this._pairCtx || this._pinCtx) return Promise.reject(new Error('Pair уже выполняется'));
    const code = String(pinCode ?? '').trim();
    if (!code) return Promise.reject(new Error('Не указан PIN-код'));

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._rejectPin(new Error('PIN-сопряжение не завершено за 60 секунд'));
      }, 60_000);

      this._pinCtx = { resolve, reject, timer, code, onStatus, session: null, stage: 'start' };
      const packet = this._envelope(
        randomUUID(),
        field(OP_PIN_CONNECT, 2, field(1, 2, EMPTY)),
        null, // при спаривании токена ещё нет
      );
      this._send(packet).catch((err) => this._rejectPin(err));
    });
  }

  _resolvePin(token) {
    const ctx = this._pinCtx;
    if (!ctx) return;
    this._pinCtx = null;
    clearTimeout(ctx.timer);
    if (typeof token !== 'string' || token.length < 16) {
      ctx.reject(new Error('Колонка не вернула токен'));
      return;
    }
    this.token = token;
    ctx.resolve(token);
  }

  _rejectPin(err) {
    const ctx = this._pinCtx;
    if (!ctx) return;
    this._pinCtx = null;
    clearTimeout(ctx.timer);
    ctx.reject(err);
  }

  /** Ответы PIN-флоу: op=4 (начало) и op=6 (подтверждение кода). */
  _handlePinMessage(parsed) {
    const ctx = this._pinCtx;
    if (!ctx) return;
    const reqData = parsed[ENVELOPE_FIELD_REQUEST_DATA];
    if (!reqData || typeof reqData !== 'object') return;

    if (ctx.stage === 'start') {
      const resp = reqData[OP_PIN_CONNECT];
      if (!resp || typeof resp !== 'object') return;
      const status = resp[1];
      const session = resp[2];

      if (status === PAIR_STATUS_AUTHORIZED) {
        this._resolvePin(session); // кнопочный сценарий сработал раньше PIN
        return;
      }
      if (status === PAIR_STATUS_WAITING) {
        if (typeof session !== 'string' || !session) {
          this._rejectPin(new Error('Колонка не вернула pin_connection_session'));
          return;
        }
        ctx.session = session;
        ctx.stage = 'confirm';
        ctx.onStatus?.('pin');
        const inner = Buffer.concat([field(1, 2, session), field(2, 2, ctx.code)]);
        this._send(this._envelope(randomUUID(), field(OP_CONFIRM_PIN_CONNECT, 2, inner)))
          .catch((err) => this._rejectPin(err));
        return;
      }

      const messages = {
        [PAIR_STATUS_ERROR]: 'Колонка вернула ошибку сопряжения',
        [PAIR_STATUS_BUSY]: 'На колонке уже активна пара. Попробуйте позже.',
        [PAIR_STATUS_TOO_MANY_REQUESTS]: 'Слишком много запросов на сопряжение. Подождите.',
        [PAIR_STATUS_DISABLED]: 'PIN-сопряжение отключено на колонке',
      };
      this._rejectPin(
        new Error(messages[status] || `Колонка не запросила PIN (статус ${status ?? '—'})`),
      );
      return;
    }

    const resp = reqData[OP_CONFIRM_PIN_CONNECT];
    if (!resp || typeof resp !== 'object') return;
    switch (resp[1]) {
      case PAIR_CONFIRM_OK:
        this._resolvePin(resp[2]);
        break;
      case PAIR_CONFIRM_WRONG_PIN:
        this._rejectPin(new Error('Неверный PIN-код'));
        break;
      case PAIR_CONFIRM_ATTEMPTS_LIMIT:
        this._rejectPin(new Error('Превышено число попыток ввода PIN'));
        break;
      case PAIR_CONFIRM_BAD_SESSION:
        this._rejectPin(new Error('Сессия сопряжения устарела'));
        break;
      case PAIR_CONFIRM_DISABLED:
        this._rejectPin(new Error('PIN-сопряжение отключено на колонке'));
        break;
      default:
        this._rejectPin(new Error(`Ошибка подтверждения PIN (статус ${resp[1] ?? '—'})`));
    }
  }

  // ────────────────────────────── commands ──────────────────────────────

  async getState() {
    return parseState(await this._request(stateRequest()));
  }

  async getMetadata() {
    return parseTrack(await this._request(metadataRequest()));
  }

  /**
   * Один запрос op=10, из которого достаём и трек, и диагностическую
   * метадату (UDP-протокол, состав нативной группы, position.tsMs).
   * @returns {Promise<{track: object|null, info: object|null, raw: Buffer}>}
   */
  async getMetadataBundle() {
    const raw = await this._request(metadataRequest());
    return { track: parseTrack(raw), info: parseMetaInfo(raw), raw };
  }

  /** Текущая очередь колонки: до 20 пар {trackId, explicit} без названий. */
  async getQueue() {
    return parseQueue(await this._request(queueRequest(), 6000));
  }

  // ─────────────────────────── bluetooth ───────────────────────────

  /** op=19 — список спаренных Bluetooth-устройств колонки. */
  async getPairedBtDevices() {
    return parsePairedBt(await this._request(pairedBtRequest()));
  }

  /** op=21 — найденные при сканировании BT-устройства (имя, MAC, RSSI). */
  async getScannedBtDevices(timeoutMs = 15_000) {
    return parseScannedBt(await this._request(scannedBtRequest(), timeoutMs));
  }

  /**
   * op=22 — включить режим Bluetooth-сопряжения (A2DP sink).
   * Длительность окна видимости задаёт прошивка колонки.
   */
  async btMakeDiscoverable() {
    await this._fireAndForget(btDiscoverableRequest());
  }

  /**
   * op=20 — команда спаренному BT-устройству по MAC.
   * @param {string} mac
   * @param {'connect'|'disconnect'|'remove'} command
   */
  async btDeviceCommand(mac, command) {
    const cmd = BT_CMD[String(command).toLowerCase()];
    if (cmd === undefined) throw new Error(`Неизвестная Bluetooth-команда: ${command}`);
    const address = String(mac || '').trim();
    if (!address) throw new Error('Не указан MAC-адрес Bluetooth-устройства');
    const inner = Buffer.concat([field(1, 2, address), field(2, 0, cmd)]);
    await this._fireAndForget(field(OP_BT_DEVICE_COMMAND, 2, inner));
  }

  async setVolume(percent) {
    const value = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
    await this._fireAndForget(field(OP_SET_VOLUME, 2, field(1, 0, value)));
  }

  async seek(positionSec) {
    const value = Math.max(0, Math.round(Number(positionSec) || 0));
    await this._fireAndForget(field(OP_SET_TRACK_POS, 2, field(1, 0, value)));
  }

  /**
   * Скорость воспроизведения (op=23): float32 в TLV kind=5.
   * Нужна для плавной подстройки фазы без рывка seek.
   */
  async setPlaybackSpeed(rate) {
    const value = Math.min(2, Math.max(0.5, Number(rate) || 1));
    await this._fireAndForget(field(OP_SET_PLAYBACK_SPEED, 2, field(1, 5, value)));
  }

  async _mediaCommand(action) {
    await this._fireAndForget(field(OP_MEDIA_COMMAND, 2, field(1, 0, action)));
  }

  play() { return this._mediaCommand(MEDIA_CMD.play); }
  pause() { return this._mediaCommand(MEDIA_CMD.pause); }
  next() { return this._mediaCommand(MEDIA_CMD.next); }
  prev() { return this._mediaCommand(MEDIA_CMD.prev); }
  mute() { return this._mediaCommand(MEDIA_CMD.mute); }
  unmute() { return this._mediaCommand(MEDIA_CMD.unmute); }
  like() { return this._mediaCommand(MEDIA_CMD.like); }
  removeLike() { return this._mediaCommand(MEDIA_CMD.removeLike); }
  dislike() { return this._mediaCommand(MEDIA_CMD.dislike); }
  removeDislike() { return this._mediaCommand(MEDIA_CMD.removeDislike); }

  shuffle(on) {
    return this._mediaCommand(on ? MEDIA_CMD.shuffleOn : MEDIA_CMD.shuffleOff);
  }

  repeat(mode) {
    const canonical = REPEAT_TO_CANONICAL[String(mode).toLowerCase()] || 'off';
    return this._mediaCommand(REPEAT_CMD[canonical]);
  }

  /**
   * MediaCommand.START_MULTIROOM (op=16, команда 8).
   *
   * Прошивка строит группу локально из SberCast-устройств в той же сети,
   * но только если на колонке уже играет аудиоисточник. Иначе в ответе
   * приходит `PlayerResponseStatus = 1`
   * (`PRS_NOT_SUPPORTED_BY_AUDIO_SOURCE`).
   *
   * Успешный ответ часто пустой — это нормально и тоже означает `ok`.
   *
   * @param {{timeoutMs?: number}} [opts]
   * @returns {Promise<{ok: boolean, status: number}>}
   */
  async startMultiroom({ timeoutMs = 5000 } = {}) {
    const raw = await this._request(
      field(OP_MEDIA_COMMAND, 2, field(1, 0, MEDIA_CMD.startMultiroom)),
      timeoutMs,
    );
    return this._multiroomReply(raw);
  }

  /**
   * MediaCommand.STOP_MULTIROOM (op=16, oneof command=3, `Empty`).
   *
   * Явный роспуск группы. В отличие от паузы не ждёт
   * `multiroom.turnOffMultiroomAfterPauseMs` (~10 с). Отправлять на мастера;
   * для надёжности менеджер дублирует команду участникам группы.
   *
   * @param {{timeoutMs?: number}} [opts]
   * @returns {Promise<{ok: boolean, status: number}>}
   */
  async stopMultiroom({ timeoutMs = 5000 } = {}) {
    const raw = await this._request(
      field(OP_MEDIA_COMMAND, 2, field(3, 2, EMPTY)),
      timeoutMs,
    );
    return this._multiroomReply(raw);
  }

  /**
   * Разбор ответа MediaCommand: `{status}` внутри поля 16. Пустой ответ
   * прошивка отдаёт и при успехе — считаем его `ok`.
   * @param {Buffer} raw
   */
  _multiroomReply(raw) {
    let status = PLAYER_STATUS_OK;
    try {
      const reply = decode(raw)[5]?.[OP_MEDIA_COMMAND];
      if (reply && typeof reply === 'object' && reply[1] !== undefined) {
        status = Number(reply[1]);
      }
    } catch {
      // Пустой/неразобранный ответ трактуем как успех: прошивка так и отвечает.
    }
    return { ok: status === PLAYER_STATUS_OK, status };
  }

  keepAlive() {
    return this._fireAndForget(keepAliveRequest());
  }

  /** op=13 — поиск пульта ДУ. */
  findRemote() {
    return this._fireAndForget(field(13, 2, field(1, 2, EMPTY)));
  }

  // ─────────────────────────── star commands ───────────────────────────

  /**
   * Собрать `Source` для StarCommand: `{sbercast:{client_name, medium=WIFI}}`.
   * Кладётся в `BaseCommand.source` (поле 1) каждой команды.
   */
  _starCommandSource() {
    const sbercast = Buffer.concat([
      field(1, 2, this.clientName),
      field(2, 0, STAR_COMMAND_MEDIUM_WIFI),
    ]);
    return field(1, 2, field(2, 2, sbercast)); // BaseCommand{ source{ sbercast{...} } }
  }

  /**
   * Сериализованный `ru.sber.staros.protobuf.StarCommand` для show_youtube.
   * @param {{videoId?: string, searchQuery?: string}} [opts]
   * @returns {Buffer}
   */
  makeShowYoutubeStarCommand({ videoId, searchQuery } = {}) {
    const payload = videoId
      ? { videoId: String(videoId) }
      : searchQuery
        ? { searchQuery: String(searchQuery) }
        : {};
    const showYoutube = Buffer.concat([
      field(1, 2, this._starCommandSource()), // ShowYoutube.base_command
      field(2, 2, JSON.stringify(payload)),   // ShowYoutube.payload
    ]);
    return field(STAR_COMMAND_SHOW_YOUTUBE, 2, showYoutube);
  }

  /**
   * Отправить произвольный `StarCommand` (type=3, поле 8).
   *
   * Прошивка 1.104.35 принимает `StarCommand` только от backend-валидированных
   * клиентов либо когда включён `sbercastPublicMode` (в `star.json` он выключен,
   * в allowlist лишь `sber_cast_connection_established` и `device_selector_msg`).
   * С PIN-токеном устройство молча игнорирует type=3 и не отвечает, поэтому
   * таймаут — штатный исход: возвращаем `null`, а не бросаем ошибку.
   *
   * @param {Buffer} starCommandBytes сериализованный StarCommand
   * @param {number} [timeoutMs]
   * @returns {Promise<Record<number, any> | null>} ответ или null, если устройство промолчало
   */
  async sendStarCommand(starCommandBytes, timeoutMs = 1500) {
    if (!this.connected) throw new Error('Колонка не подключена');
    const msgId = randomUUID();
    const parts = [
      field(1, 0, MESSAGE_TYPE_STAR_COMMAND),
      field(2, 2, msgId),
    ];
    if (this.token) parts.push(field(3, 2, this.token));
    parts.push(
      field(8, 2, field(1, 2, starCommandBytes)),
      field(6, 0, TOKEN_TYPE_PIN_AUTH),
      field(7, 2, this.clientName),
      field(10, 0, 1),
      field(11, 2, this.clientId),
    );
    const packet = Buffer.concat(parts);
    let raw;
    try {
      raw = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this._pending.delete(msgId);
          reject(new RequestTimeout());
        }, timeoutMs);
        this._pending.set(msgId, { resolve, reject, timer });
        this._send(packet).catch((err) => {
          clearTimeout(timer);
          this._pending.delete(msgId);
          reject(err);
        });
      });
    } catch (err) {
      if (err instanceof RequestTimeout) return null;
      throw err;
    }
    return decode(raw);
  }

  /** Показать YouTube через StarCommand вместо директивы (type=3). */
  async showYoutubeStarCommand(opts) {
    return this.sendStarCommand(this.makeShowYoutubeStarCommand(opts));
  }

  /**
   * `StarCommand.multi_room_message` (тип 140) с
   * `MultiRoomCommand.stop_multiroom = 3`.
   *
   * Проверено на живых колонках (SberBoom 1.104.35, SberPortal 1.102.34,
   * SberBoom Mini 2 1.104.35): команда принимается (generic ACK), но группа
   * не распадается — роли `MASTER`/`SLAVE` держатся, пока прошивка не
   * сработает по таймеру паузы. Оставлено как запасной путь для других
   * версий прошивки.
   *
   * @param {{masterCastDeviceId?: string, timeoutMs?: number}} [opts]
   * @returns {Promise<Record<number, any> | null>}
   */
  async stopMultiroomStar({ masterCastDeviceId = '', timeoutMs = 2000 } = {}) {
    const command = field(3, 2, EMPTY); // MultiRoomCommand.stop_multiroom
    const parts = [field(1, 2, this._starCommandSource())]; // base_command
    if (masterCastDeviceId) parts.push(field(2, 2, masterCastDeviceId));
    parts.push(field(4, 2, command)); // MultiRoomMessage.command
    const multiRoomMessage = Buffer.concat(parts);
    return this.sendStarCommand(
      field(STAR_COMMAND_MULTI_ROOM_MESSAGE, 2, multiRoomMessage),
      timeoutMs,
    );
  }
}
