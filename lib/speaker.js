/**
 * WebSocket-клиент одной колонки SberBoom.
 * wss://<host>:20000/ + бинарный TLV. Порт api.py интеграции sboom_ha.
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

import { decode, field } from './tlv.js';
import { parsePairedBt, parseQueue, parseScannedBt, parseState, parseTrack } from './parsers.js';
import {
  BT_CMD,
  DEFAULT_PORT,
  DEFAULT_USER_AGENT,
  ENVELOPE_FIELD_MSG_ID,
  ENVELOPE_FIELD_REQUEST_DATA,
  KEEPALIVE_INTERVAL_SEC,
  MEDIA_CMD,
  OP_BT_DEVICE_COMMAND,
  OP_BT_DISCOVERABLE,
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
  PAIR_CONFIRM_OK,
  PAIR_CONFIRM_REJECTED,
  PAIR_STATUS_AUTHORIZED,
  PAIR_STATUS_BUSY,
  PAIR_STATUS_DISABLED,
  PAIR_STATUS_WAITING,
  PAIR_TIMEOUT_MS,
  REPEAT_CMD,
  REPEAT_TO_CANONICAL,
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
    this._heartbeat = null;
    this._lastPong = 0;
    this._closing = false;
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
    if (!this._open && this._pending.size === 0 && !this._pairCtx) return;
    this._open = false;
    this._stopHeartbeat();
    for (const [, entry] of this._pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Соединение с колонкой потеряно'));
    }
    this._pending.clear();
    this._rejectPair(new Error('Соединение с колонкой потеряно'));
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
   */
  _serverActionEnvelope(msgId, name, payload) {
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
   * @returns {Promise<Record<string, any>|string>} field(4) ответа: {1:'OK'} или текст ошибки
   */
  async sendServerAction(name, payload, timeoutMs = 6000) {
    if (!this.connected) throw new Error('Колонка не подключена');
    const msgId = randomUUID();
    const packet = this._serverActionEnvelope(msgId, name, payload);
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
      } else if (status === PAIR_STATUS_DISABLED) {
        this._rejectPair(new Error('Режим сопряжения отключён на колонке'));
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
      }
    }
  }

  // ────────────────────────────── commands ──────────────────────────────

  async getState() {
    return parseState(await this._request(stateRequest()));
  }

  async getMetadata() {
    return parseTrack(await this._request(metadataRequest()));
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

  keepAlive() {
    return this._fireAndForget(keepAliveRequest());
  }

  /** op=13 — поиск пульта ДУ. */
  findRemote() {
    return this._fireAndForget(field(13, 2, field(1, 2, EMPTY)));
  }
}
