/**
 * Менеджер колонок: по одному supervisor-циклу на устройство,
 * push-обновления трека, поллинг громкости, optimistic-команды.
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import { SpeakerClient } from './speaker.js';
import { parseState, parseTrack, parseUpdatedMetaData, trackFromState, mediaPlayerFromState, coverUrl } from './parsers.js';
import { deeplinkFor, PLAY_KINDS } from './zvuk.js';
import { MultiroomController, MULTIROOM_PROPAGATE } from './multiroom.js';
import { MEASURE_CACHE_MS } from './protocol.js';
import {
  DEFAULT_PORT,
  METADATA_POLL_INTERVAL_SEC,
  POLL_FAILURES_BEFORE_RECONNECT,
  RECONNECT_BACKOFF_SEC,
  REPEAT_TO_CANONICAL,
  STABLE_SESSION_SEC,
  VOLUME_POLL_INTERVAL_SEC,
  ENVELOPE_FIELD_REQUEST_DATA,
  OP_GET_META_DATA,
  OP_GET_STATE,
  RESP_UPDATE_META_DATA,
} from './protocol.js';

function log(...args) {
  console.log(new Date().toISOString().slice(11, 19), ...args);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Локальная оценка окна видимости BT (точную длительность задаёт прошивка). */
const BT_DISCOVERABLE_WINDOW_MS = 120_000;

function humanError(err) {
  const msg = err?.message || String(err || '');
  if (err?.name === 'RequestTimeout' || /таймаут|timeout/i.test(msg)) {
    return 'Колонка не ответила. Проверьте IP и что она в той же сети.';
  }
  if (/ECONNREFUSED/i.test(msg)) return 'Порт 20000 закрыт. Проверьте IP и питание колонки.';
  if (/EHOSTUNREACH|ENETUNREACH|EHOSTDOWN/i.test(msg)) return 'Колонка недоступна по сети.';
  if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) return 'Не удалось разрешить адрес колонки.';
  if (/CERT|SSL|TLS/i.test(msg)) return 'Ошибка TLS-соединения с колонкой.';
  return msg || 'Неизвестная ошибка';
}

/** Нормализует ввод пользователя: "wss://192.168.1.5:20000/" → {host, port}. */
export function parseHostInput(raw, fallbackPort = DEFAULT_PORT) {
  let s = String(raw || '').trim();
  s = s.replace(/^wss?:\/\//i, '').replace(/\/+$/, '');
  let port = fallbackPort;
  const m = /^(.+):(\d{1,5})$/.exec(s);
  if (m) {
    s = m[1];
    port = Number(m[2]);
  }
  if (!s) throw new Error('Укажите IP-адрес колонки');
  if (!/^[a-zA-Z0-9._-]+$/.test(s)) throw new Error('Некорректный IP-адрес или имя хоста');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Некорректный порт');
  return { host: s, port };
}

export class SpeakerRuntime {
  constructor(cfg, manager) {
    this.cfg = cfg;
    this.manager = manager;

    this.client = null;
    this.pairClient = null;
    this.status = cfg.token ? 'connecting' : 'unpaired';
    this.pairing = { active: false, message: null };
    this.lastError = null;

    this.volume = null;
    this.muted = null;
    this.device = null;
    this.track = null;
    this.bt = {
      devices: [],
      scanned: [],
      scanning: false,
      discoverableAt: null,
      error: null,
      updatedAt: null,
    };

    this._stopping = false;
    this._loopPromise = null;
    this._everConnected = false;
    this._volTimer = null;
    this._metaTimer = null;
    this._pollFailures = 0;
    this._wake = null;
    this._pairFailures = 0;
    this._measureCache = null;
  }

  snapshot() {
    const t = this.track;
    return {
      id: this.cfg.id,
      name: this.cfg.name,
      host: this.cfg.host,
      port: this.cfg.port,
      paired: Boolean(this.cfg.token),
      status: this.pairing.active ? 'pairing' : this.status,
      error: this.lastError,
      pairing: { ...this.pairing },
      volume: this.volume,
      muted: this.muted,
      device: {
        ip: this.device?.network_ip ?? this.cfg.host,
        network: this.device?.network_type ?? null,
        timezone: this.device?.timezone_id ?? null,
      },
      track: t
        ? {
            title: t.title,
            artists: t.artists || [],
            album: t.album,
            trackId: t.track_id,
            cover: coverUrl(t),
            duration: t.duration,
            position: t.position,
            positionAt: t.positionAt ?? null,
            playing: Boolean(t.playing),
            shuffle: Boolean(t.shuffle),
            repeat: REPEAT_TO_CANONICAL[String(t.repeat || '').toLowerCase()] || 'off',
            liked: Boolean(t.liked),
            source: t.media_source || null,
            station: t.station_name || null,
            provider: t.provider || null,
            playlist: t.playlist_title || null,
            playlistId: t.playlist_id || null,
            playlistType: t.playlist_type || null,
            buffering: Boolean(t.buffering),
          }
        : null,
      bt: this._btSnapshot(),
      updatedAt: Date.now(),
    };
  }

  _btSnapshot() {
    const devices = Array.isArray(this.bt.devices) ? this.bt.devices : [];
    const scanned = Array.isArray(this.bt.scanned) ? this.bt.scanned : [];
    const discoverableUntil = this.bt.discoverableAt
      ? this.bt.discoverableAt + BT_DISCOVERABLE_WINDOW_MS
      : null;
    return {
      devices: devices.map((d) => ({
        mac: d.mac,
        name: d.name || '',
        connected: Boolean(d.connected),
      })),
      scanned: scanned.map((d) => ({
        mac: d.mac,
        name: d.name || '',
        rssi: typeof d.rssi === 'number' ? d.rssi : null,
      })),
      scanning: Boolean(this.bt.scanning),
      discoverable: Boolean(discoverableUntil && Date.now() < discoverableUntil),
      discoverableAt: this.bt.discoverableAt,
      discoverableUntil,
      error: this.bt.error,
      updatedAt: this.bt.updatedAt,
    };
  }

  _notify() {
    this.manager.notify();
  }

  _setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this._notify();
  }

  _setPairMessage(message) {
    this.pairing.message = message;
    this._notify();
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  start() {
    if (this._loopPromise) return;
    this._stopping = false;
    this._loopPromise = this._loop().finally(() => {
      this._loopPromise = null;
    });
  }

  async stop() {
    this._stopping = true;
    this._wake?.();
    await this.client?.close().catch(() => {});
    try {
      await this._loopPromise;
    } catch {
      /* ignore */
    }
    this._loopPromise = null;
    this._stopping = false;
  }

  async _sleep(ms) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._wake = null;
        resolve();
      }, ms);
      timer.unref?.();
      this._wake = () => {
        clearTimeout(timer);
        this._wake = null;
        resolve();
      };
    });
  }

  async _loop() {
    if (!this.cfg.token) {
      this._setStatus('unpaired');
      return;
    }
    let attempt = 0;

    while (!this._stopping) {
      this._setStatus(this._everConnected ? 'reconnecting' : 'connecting');
      const client = new SpeakerClient({
        host: this.cfg.host,
        port: this.cfg.port,
        token: this.cfg.token,
        clientId: this.cfg.clientId,
        clientName: this.cfg.clientName,
      });
      this.client = client;
      client.on('event', (raw, parsed) => this._handleEvent(raw, parsed));

      let sessionStart = 0;
      try {
        await client.connect();
        if (this._stopping) break;
        await this._sync(client);
        if (this._stopping) break;

        sessionStart = Date.now();
        this._everConnected = true;
        this._lastError = null;
        attempt = 0;
        this._pollFailures = 0;
        this._setStatus('connected');
        this._startPolling(client);

        // Ждём обрыва связи (listen-loop / heartbeat / close()).
        // Дополнительно проверяем client.connected: событие 'closed' может
        // потеряться, и тогда supervisor завис бы навсегда. Вотчдог делает
        // выход независимым от доставки события.
        await new Promise((resolve) => {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            clearInterval(watch);
            client.off('closed', finish);
            resolve();
          };
          const watch = setInterval(() => {
            if (this._stopping || !client.connected) finish();
          }, 1000);
          watch.unref?.();
          client.once('closed', finish);
          if (this._stopping || !client.connected) finish();
        });
      } catch (err) {
        if (!this._stopping) {
          this._lastError =
            err?.name === 'RequestTimeout'
              ? 'Колонка принимает соединение, но не отвечает. Проверьте IP или сопрягите заново.'
              : humanError(err);
          if (this._lastError) log(`[${this.cfg.name}] ошибка: ${this._lastError}`);
        }
      } finally {
        this._stopPolling();
        client.removeAllListeners('event');
        await client.close().catch(() => {});
        if (this.client === client) this.client = null;
        if (!this._stopping) {
          this._setStatus(this.cfg.token ? 'reconnecting' : 'unpaired');
        }
      }

      if (this._stopping) break;
      if (sessionStart && Date.now() - sessionStart >= STABLE_SESSION_SEC * 1000) attempt = 0;

      attempt += 1;
      const base = RECONNECT_BACKOFF_SEC[Math.min(attempt - 1, RECONNECT_BACKOFF_SEC.length - 1)];
      await this._sleep(base * 1000 + Math.random() * base * 300);
    }
  }

  async _sync(client) {
    const state = await client.getState(); // обязательный запрос — проверка связи
    if (state) this._mergeState(state);

    // get_metadata активирует push-subscribe поток.
    try {
      const track = await client.getMetadata();
      if (track) this._adoptTrack(track);
      else if (state?.raw) this._adoptFromStateJson(state.raw);
    } catch (err) {
      if (err?.name !== 'RequestTimeout') throw err;
      // Метаданные могли не прийти — не повод считать связь мёртвой.
    }
    this._notify();
  }

  /** Радио/Bluetooth: now-playing без trackId достаём из GET_STATE. */
  _adoptFromStateJson(raw) {
    try {
      const parsed = JSON.parse(raw);
      const fromState = trackFromState(parsed);
      if (!fromState) return false;
      if (!fromState.title && !fromState.station_name) return false;
      this._adoptTrack(fromState);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Свежий срез воспроизведения (для мультирума). В отличие от track,
   * позиция всегда актуальная: GET_STATE обновляется каждую секунду,
   * а op=10 может отдавать кэш.
   * @returns {Promise<{playing:boolean, position:number|null, trackId:string|null, title:string|null, buffering:boolean}|null>}
   */
  async pollNow() {
    const client = this.client;
    if (!client?.connected) return null;
    let state;
    try {
      state = await client.getState();
    } catch {
      return null;
    }
    if (!state) return null;
    this._mergeState(state);

    let json = null;
    if (state.raw) {
      try {
        json = JSON.parse(state.raw);
      } catch {
        json = null;
      }
    }
    const media = mediaPlayerFromState(json);
    const player = media?.player;
    const info = media?.info || {};
    const view = {
      playing: Boolean(player?.playing),
      position: typeof player?.position === 'number' ? Math.round(player.position) : null,
      trackId: info.trackId !== undefined && info.trackId !== null ? String(info.trackId) : null,
      playlistId:
        info.playlistId !== undefined && info.playlistId !== null ? String(info.playlistId) : null,
      playlistTitle: info.playlistTitle || null,
      playlistType: info.playlistType || null,
      title: info.title || null,
      buffering: Boolean(player?.playingPending),
    };

    // Другой трек/контекст (радио/BT/deeplink) — подтягиваем его в state для UI.
    const contextChanged =
      view.trackId &&
      (view.trackId !== this.track?.track_id ||
        (view.playlistId && view.playlistId !== this.track?.playlist_id));
    if (json && (contextChanged || (!view.trackId && !this.track?.track_id))) {
      const fresh = trackFromState(json);
      if (fresh) this._adoptTrack(fresh);
    }

    // Живые поля того же трека обновляем сразу: метаданные приходят реже,
    // а start()/UI должны видеть реальные playing/position уже сейчас.
    let liveChanged = false;
    if (this.track && view.trackId && view.trackId === String(this.track.track_id)) {
      const now = Date.now();
      if (Boolean(this.track.playing) !== view.playing) {
        this.track.playing = view.playing;
        liveChanged = true;
      }
      if (view.position !== null) {
        this.track.position = view.position;
        this.track.positionAt = now;
        liveChanged = true;
      }
      if (Boolean(this.track.buffering) !== view.buffering) {
        this.track.buffering = view.buffering;
        liveChanged = true;
      }
    }
    if (liveChanged) this._notify();
    return view;
  }

  /**
   * Замер для синхронизации: позиция + оценка момента, к которому она относится.
   * Не трогает состояние UI и не шлёт notify — можно опрашивать часто.
   * `at` = середина RTT, точность ~10 мс.
   *
   * Кэш короткий (150 мс): он убирает повторные запросы внутри одного замера
   * фазы, но не мешает поймать переход целой секунды. Инвалидируется любой
   * командой, которая меняет воспроизведение.
   */
  async measure({ fresh = false } = {}) {
    const client = this.client;
    if (!client?.connected) return null;
    if (!fresh && this._measureCache && Date.now() - this._measureCache.at < MEASURE_CACHE_MS) {
      return this._measureCache.view;
    }
    const t0 = Date.now();
    let state;
    try {
      state = await client.getState();
    } catch {
      return null;
    }
    const t1 = Date.now();
    if (!state?.raw) return null;
    let json;
    try {
      json = JSON.parse(state.raw);
    } catch {
      return null;
    }
    const media = mediaPlayerFromState(json);
    const player = media?.player;
    if (!player) return null;
    const view = {
      at: t0 + (t1 - t0) / 2,
      rtt: t1 - t0,
      position: typeof player.position === 'number' ? player.position : null,
      duration: typeof player.duration === 'number' ? player.duration : null,
      playing: Boolean(player.playing),
      pending: Boolean(player.playingPending),
      trackId:
        player.info?.trackId !== undefined && player.info?.trackId !== null
          ? String(player.info.trackId)
          : null,
    };
    this._measureCache = { at: view.at, view };
    return view;
  }

  /** Любая команда меняет воспроизведение — cached-замер больше не действителен. */
  _invalidateMeasure() {
    this._measureCache = null;
  }

  /** Deeplink перезапускает плеер: позиция и трек гарантированно новые. */
  async playDeeplink(url) {
    this._invalidateMeasure();
    return this.client.playDeeplink(url);
  }

  // ───────────────────────────── polling ─────────────────────────────

  _startPolling(client) {
    this._stopPolling();
    this._volTimer = setInterval(() => this._pollState(client), VOLUME_POLL_INTERVAL_SEC * 1000);
    this._metaTimer = setInterval(() => this._pollMeta(client), METADATA_POLL_INTERVAL_SEC * 1000);
    this._volTimer.unref?.();
    this._metaTimer.unref?.();
  }

  _stopPolling() {
    if (this._volTimer) clearInterval(this._volTimer);
    if (this._metaTimer) clearInterval(this._metaTimer);
    this._volTimer = null;
    this._metaTimer = null;
  }

  async _pollState(client) {
    if (!client.connected) return;
    try {
      const state = await client.getState();
      this._pollFailures = 0;
      if (state) {
        this._mergeState(state);
        this._notify();
      }
    } catch {
      this._pollFailures += 1;
      if (this._pollFailures >= POLL_FAILURES_BEFORE_RECONNECT) {
        // Half-open, не пойманный WS ping: принудительный reconnect.
        client.close().catch(() => {});
      }
    }
  }

  async _pollMeta(client) {
    if (!client.connected) return;
    try {
      const track = await client.getMetadata();
      if (track) {
        this._adoptTrack(track);
        this._notify();
        return;
      }
      // Радио/BT: метаданные пустые — берём now-playing из состояния.
      const state = await client.getState();
      if (state) {
        this._mergeState(state);
        if (state.raw) this._adoptFromStateJson(state.raw);
        this._notify();
      }
    } catch {
      /* пусто — следующий poll попробует снова */
    }
  }

  // ───────────────────────────── data ─────────────────────────────

  _mergeState(state) {
    if (!state) return;
    if (state.volume !== null && state.volume !== undefined) this.volume = state.volume;
    if (state.muted !== null && state.muted !== undefined) this.muted = state.muted;
    if (state.device) this.device = state.device;
  }

  /** Текущая позиция с экстраполяцией на момент now (ms). */
  _currentPosition(track = this.track, now = Date.now()) {
    if (!track || track.position === null || track.position === undefined) return null;
    if (!track.playing) return track.position;
    const base = track.positionAt ?? now;
    return track.position + Math.max(0, (now - base) / 1000);
  }

  _adoptTrack(track) {
    const old = this.track;
    const now = Date.now();
    const sameTrack = old && track.track_id && old.track_id === track.track_id;
    const sameSnapshot =
      sameTrack && track.position === old.position && track.position_ts_ms === old.position_ts_ms;

    if (sameSnapshot) {
      if (Boolean(track.playing) !== Boolean(old.playing) && track.position !== null) {
        // Пауза/плей без новой позиции: фиксируем реальную текущую позицию,
        // иначе таймлайн прыгнет назад/вперёд.
        track.position = Math.round(this._currentPosition(old, now));
        track.positionAt = now;
      } else {
        track.positionAt = old.positionAt ?? now;
      }
    } else {
      track.positionAt = now;
    }
    this.track = track;
  }

  _patchTrack(patch) {
    if (!this.track) return;
    Object.assign(this.track, patch);
  }

  _handleEvent(raw, parsed) {
    const reqData = parsed?.[ENVELOPE_FIELD_REQUEST_DATA];
    if (!reqData || typeof reqData !== 'object') return;
    let changed = false;

    if (String(OP_GET_META_DATA) in reqData) {
      try {
        const track = parseTrack(raw);
        if (track) {
          this._adoptTrack(track);
          changed = true;
        }
      } catch {
        /* битый push — игнорируем */
      }
    }
    if (String(OP_GET_STATE) in reqData) {
      try {
        const state = parseState(raw);
        if (state) {
          this._mergeState(state);
          // Радио/BT: push трека приходит только как state-обновление.
          if (state.raw && !this.track?.track_id) this._adoptFromStateJson(state.raw);
          changed = true;
        }
      } catch {
        /* битый push — игнорируем */
      }
    }
    if (String(RESP_UPDATE_META_DATA) in reqData) {
      try {
        const update = parseUpdatedMetaData(raw);
        if (update) {
          const state = {
            volume: update.volumePercent,
            muted: update.volumeMuted,
            device: null,
            raw: update.mediaPlayerState,
          };
          this._mergeState(state);
          if (state.raw && !this.track?.track_id) this._adoptFromStateJson(state.raw);
          changed = true;
        }
      } catch {
        /* битый push — игнорируем */
      }
    }
    if (changed) this._notify();
  }

  // ───────────────────────────── bluetooth ─────────────────────────────

  _btClient() {
    const client = this.client;
    if (!client?.connected) throw new Error('Колонка не в сети');
    return client;
  }

  /** Свежий список спаренных BT-устройств (op=19). */
  async refreshBluetooth() {
    const client = this._btClient();
    try {
      const devices = await client.getPairedBtDevices();
      this.bt.devices = devices;
      this.bt.error = null;
      this.bt.updatedAt = Date.now();
      this._notify();
      return this._btSnapshot();
    } catch (err) {
      this.bt.error = humanError(err);
      this._notify();
      throw err;
    }
  }

  /** op=22 — включить режим сопряжения (колонка становится видимой по BT). */
  async makeBluetoothDiscoverable() {
    const client = this._btClient();
    await client.btMakeDiscoverable();
    this.bt.discoverableAt = Date.now();
    this.bt.error = null;
    this._notify();
    return this._btSnapshot();
  }

  /** op=21 — скан BT-устройств рядом. Долгий запрос, поэтому один за раз. */
  async scanBluetooth() {
    const client = this._btClient();
    if (this.bt.scanning) throw new Error('Сканирование уже идёт');
    this.bt.scanning = true;
    this.bt.error = null;
    this._notify();
    try {
      const scanned = await client.getScannedBtDevices();
      this.bt.scanned = scanned;
      this.bt.updatedAt = Date.now();
    } catch (err) {
      this.bt.error = humanError(err);
      throw err;
    } finally {
      this.bt.scanning = false;
      this._notify();
    }
    return this._btSnapshot();
  }

  /**
   * op=20 — connect/disconnect/remove спаренного устройства.
   * Прошивка отвечает молча, поэтому список перечитываем после паузы.
   */
  async bluetoothCommand(mac, command) {
    const client = this._btClient();
    const address = String(mac || '').trim();
    if (!address) throw new Error('Не указан MAC-адрес Bluetooth-устройства');
    const action = String(command || '').trim().toLowerCase();
    if (!['connect', 'disconnect', 'remove'].includes(action)) {
      throw new Error('Команда должна быть connect, disconnect или remove');
    }

    await client.btDeviceCommand(address, action);
    this.bt.error = null;

    // Мгновенный отклик в UI, затем подтверждение от колонки.
    if (action === 'remove') {
      this.bt.devices = this.bt.devices.filter((d) => d.mac !== address);
    } else {
      this.bt.devices = this.bt.devices.map((d) =>
        d.mac === address ? { ...d, connected: action === 'connect' } : d,
      );
    }
    this._notify();

    await sleep(600);
    try {
      const devices = await client.getPairedBtDevices();
      this.bt.devices = devices;
      this.bt.updatedAt = Date.now();
      this._notify();
    } catch {
      // Команда уже отправлена — оставляем оптимистичный список.
    }
    return this._btSnapshot();
  }

  // ───────────────────────────── pairing ─────────────────────────────

  async pair() {
    if (this.pairing.active) throw new Error('Сопряжение уже идёт');
    this.pairing = { active: true, message: 'Останавливаем текущее соединение…' };
    this.lastError = null;
    this._notify();

    await this.stop();

    const client = new SpeakerClient({
      host: this.cfg.host,
      port: this.cfg.port,
      token: null,
      clientId: this.cfg.clientId,
      clientName: this.cfg.clientName,
    });
    this.pairClient = client;

    try {
      await client.connect();
      this._setPairMessage('Нажмите и удерживайте «+» на корпусе колонки');
      const token = await client.pair((status) => {
        if (status === 'waiting') this._setPairMessage('Ждём нажатия «+» на колонке…');
      });
      this.cfg.token = token;
      await this.manager.persist();
      this._setPairMessage('Готово — колонка сопряжена');
      log(`[${this.cfg.name}] сопряжение успешно`);
    } catch (err) {
      this.lastError = humanError(err);
      log(`[${this.cfg.name}] сопряжение не удалось: ${this.lastError}`);
      throw err;
    } finally {
      this.pairClient = null;
      await client.close().catch(() => {});
      this.pairing = { active: false, message: null };
      this.status = this.cfg.token ? 'connecting' : 'unpaired';
      this._notify();
      this.start();
    }
  }

  // ───────────────────────────── commands ─────────────────────────────

  async command(name, value) {
    const client = this.client;
    const online = client?.connected;
    if (!online) throw new Error('Колонка не в сети');
    this._invalidateMeasure();

    switch (name) {
      case 'play':
        await client.play();
        if (this.track) {
          if (this.track.position !== null) this.track.positionAt = Date.now();
          this.track.playing = true;
        }
        break;
      case 'pause': {
        const pos = this._currentPosition();
        await client.pause();
        if (this.track) {
          this.track.playing = false;
          if (pos !== null) {
            this.track.position = Math.round(pos);
            this.track.positionAt = Date.now();
          }
        }
        break;
      }
      case 'playpause': {
        const playing = Boolean(this.track?.playing);
        return this.command(playing ? 'pause' : 'play');
      }
      case 'next':
        await client.next();
        break;
      case 'prev':
        await client.prev();
        break;
      case 'volume': {
        const v = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
        await client.setVolume(v);
        this.volume = v;
        break;
      }
      case 'mute':
        await client.mute();
        this.muted = true;
        break;
      case 'unmute':
        await client.unmute();
        this.muted = false;
        break;
      case 'mutetoggle': {
        const m = Boolean(this.muted);
        await (m ? client.unmute() : client.mute());
        this.muted = !m;
        break;
      }
      case 'shuffle': {
        const on = typeof value === 'boolean' ? value : !this.track?.shuffle;
        await client.shuffle(on);
        if (this.track) this.track.shuffle = on;
        break;
      }
      case 'repeat': {
        const mode = ['off', 'all', 'one'].includes(value) ? value : 'off';
        await client.repeat(mode);
        if (this.track) this.track.repeat = mode === 'all' ? 'playlist' : mode === 'one' ? 'track' : 'none';
        break;
      }
      case 'like':
        await client.like();
        if (this.track) this.track.liked = true;
        break;
      case 'unlike':
        await client.removeLike();
        if (this.track) this.track.liked = false;
        break;
      case 'dislike':
        await client.dislike();
        if (this.track) this.track.liked = false;
        break;
      case 'seek': {
        const pos = Math.max(0, Math.round(Number(value) || 0));
        await client.seek(pos);
        if (this.track) {
          this.track.position = pos;
          this.track.positionAt = Date.now();
        }
        break;
      }
      case 'refresh': {
        const state = await client.getState();
        if (state) this._mergeState(state);
        const track = await client.getMetadata();
        if (track) this._adoptTrack(track);
        break;
      }
      case 'findRemote':
        await client.findRemote();
        break;
      default:
        throw new Error(`Неизвестная команда: ${name}`);
    }
    this._notify();
  }
}

export class SpeakerManager extends EventEmitter {
  constructor({ store, zvuk = null }) {
    super();
    this.store = store;
    this.zvuk = zvuk;
    this.runtimes = new Map();
    this._notifyTimer = null;
    this.multiroom = new MultiroomController(this);
  }

  async init() {
    await this.store.load();
    for (const cfg of this.store.data.speakers) {
      this._spawn(cfg);
    }
  }

  _spawn(cfg) {
    const runtime = new SpeakerRuntime(cfg, this);
    this.runtimes.set(cfg.id, runtime);
    runtime.start();
    return runtime;
  }

  async persist() {
    this.store.data.speakers = [...this.runtimes.values()].map((r) => r.cfg);
    await this.store.save();
  }

  notify() {
    if (this._notifyTimer) return;
    this._notifyTimer = setTimeout(() => {
      this._notifyTimer = null;
      this.emit('change');
    }, 80);
  }

  snapshot() {
    return {
      speakers: [...this.runtimes.values()].map((r) => r.snapshot()),
      multiroom: this.multiroom.snapshot(),
      serverTime: Date.now(),
    };
  }

  async add({ name, host, port }) {
    const parsed = parseHostInput(host, port || DEFAULT_PORT);
    for (const r of this.runtimes.values()) {
      if (r.cfg.host.toLowerCase() === parsed.host.toLowerCase() && r.cfg.port === parsed.port) {
        throw new Error('Такая колонка уже добавлена');
      }
    }
    const baseName = String(name || '').trim() || 'SberBoom';
    let finalName = baseName;
    let n = 2;
    const names = new Set([...this.runtimes.values()].map((r) => r.cfg.name));
    while (names.has(finalName)) finalName = `${baseName} ${n++}`;

    const cfg = {
      id: randomUUID(),
      name: finalName,
      host: parsed.host,
      port: parsed.port,
      token: null,
      clientId: randomUUID(),
      clientName: 'Sboom',
    };
    this._spawn(cfg);
    await this.persist();
    this.notify();
    log(`добавлена колонка ${finalName} (${cfg.host}:${cfg.port})`);
    return this.runtimes.get(cfg.id).snapshot();
  }

  async remove(id) {
    const runtime = this.runtimes.get(id);
    if (!runtime) throw new Error('Колонка не найдена');
    await this.multiroom.forget(id);
    this.runtimes.delete(id);
    await runtime.stop();
    await this.persist();
    this.notify();
  }

  async rename(id, name) {
    const runtime = this.runtimes.get(id);
    if (!runtime) throw new Error('Колонка не найдена');
    const trimmed = String(name || '').trim();
    if (!trimmed) throw new Error('Имя не может быть пустым');
    runtime.cfg.name = trimmed.slice(0, 64);
    await this.persist();
    this.notify();
  }

  get(id) {
    const runtime = this.runtimes.get(id);
    if (!runtime) throw new Error('Колонка не найдена');
    return runtime;
  }

  async pair(id) {
    return this.get(id).pair();
  }

  async command(id, name, value) {
    const runtime = this.get(id);
    const mr = this.multiroom;
    if (mr.active && MULTIROOM_PROPAGATE.has(name) && mr.memberIds.includes(id)) {
      // В мультируме транспорт и переключение треков ведёт источник,
      // остальные колонки догоняют его.
      return mr.command(mr.sourceId, name, value);
    }
    return runtime.command(name, value);
  }

  async groupCommand(name, value, ids = null) {
    const mr = this.multiroom;
    if (mr.active && MULTIROOM_PROPAGATE.has(name)) {
      const targets = ids?.length ? ids : mr.memberIds;
      if (targets.includes(mr.sourceId)) return mr.command(mr.sourceId, name, value);
    }
    const targets = ids?.length ? ids.map((id) => this.get(id)) : [...this.runtimes.values()];
    const results = await Promise.allSettled(
      targets.filter((r) => r.client?.connected).map((r) => r.command(name, value)),
    );
    const errors = results
      .filter((r) => r.status === 'rejected')
      .map((r) => r.reason?.message)
      .filter(Boolean);
    return { ok: results.filter((r) => r.status === 'fulfilled').length, errors };
  }

  // ───────────────────────────── bluetooth ─────────────────────────────

  async bluetoothInfo(id) {
    return this.get(id).refreshBluetooth();
  }

  async bluetoothDiscoverable(id) {
    return this.get(id).makeBluetoothDiscoverable();
  }

  async bluetoothScan(id) {
    return this.get(id).scanBluetooth();
  }

  async bluetoothCommand(id, mac, command) {
    return this.get(id).bluetoothCommand(mac, command);
  }

  // ───────────────────────── каталог / очередь / запуск ─────────────────────────

  /** Очередь колонки с названиями из каталога Звука (или без них, если каталог недоступен). */
  async getQueue(id) {
    const runtime = this.get(id);
    if (!runtime.client?.connected) throw new Error('Колонка не в сети');

    // Свежий контекст: play/pause и смена плейлиста приходят push'ем не всегда.
    await runtime.pollNow().catch(() => null);
    const entries = await runtime.client.getQueue();

    let catalog = [];
    let catalogError = null;
    if (entries.length && this.zvuk?.getTracks) {
      try {
        catalog = await this.zvuk.getTracks(entries.map((item) => item.trackId));
      } catch (err) {
        catalogError = err?.message || 'Каталог Звука недоступен';
      }
    }
    const meta = new Map((catalog || []).filter(Boolean).map((item) => [String(item.id), item]));
    const currentTrackId = runtime.track?.track_id || null;
    const items = entries.map((entry) => {
      const info = meta.get(entry.trackId);
      return {
        trackId: entry.trackId,
        explicit: entry.explicit,
        title: info?.title || null,
        artists: info?.artists || [],
        album: info?.album || null,
        cover: info?.cover || null,
        duration: info?.duration ?? null,
        current: entry.trackId === currentTrackId,
      };
    });

    return {
      speakerId: id,
      items,
      currentTrackId,
      context: {
        playlistId: runtime.track?.playlist_id || null,
        playlistTitle: runtime.track?.playlist_title || null,
        playlistType: runtime.track?.playlist_type || null,
      },
      catalogError,
      fetchedAt: Date.now(),
    };
  }

  /** Разобрать запрос на запуск: {url} или {kind,id}. */
  async _resolvePlayInput(payload) {
    const url = typeof payload?.url === 'string' ? payload.url.trim() : '';
    if (url) {
      if (!this.zvuk?.resolveInput) throw new Error('Каталог Звука не подключён');
      return this.zvuk.resolveInput(url);
    }

    let kind = String(payload?.kind || '').trim().toLowerCase();
    if (kind === 'album') kind = 'release';
    const contentId = String(payload?.id ?? '').trim();
    if (!kind || !contentId) throw new Error('Укажите тип и ID контента или ссылку zvuk.com');
    if (!PLAY_KINDS.has(kind)) throw new Error(`Неизвестный тип контента: ${kind}`);
    if (!/^\d{1,20}$/.test(contentId)) throw new Error('ID должен состоять из цифр');

    const deeplink = deeplinkFor(kind, contentId);
    if (!deeplink) throw new Error('Не удалось собрать deeplink для колонки');
    return { kind, id: contentId, title: null, subtitle: null, cover: null, deeplink };
  }

  /**
   * Запустить трек/плейлист/альбом/исполнителя на колонке.
   *
   * Если колонка — источник активного мультирума, deeplink уходит всем
   * участникам: они стартуют тот же контекст, дальше работает синхронизация.
   * На ведомую колонку отправлять нельзя — иначе группа развалится.
   */
  async playContent(id, payload = {}) {
    const runtime = this.get(id);
    if (!runtime.client?.connected) throw new Error('Колонка не в сети');

    const content = await this._resolvePlayInput(payload);
    const mr = this.multiroom;

    let targets = [runtime];
    if (mr.active && mr.memberIds.includes(id)) {
      if (id !== mr.sourceId) {
        throw new Error('Мультирум включён: отправьте контент на колонку-источник');
      }
      targets = mr._members();
    }

    const results = await Promise.allSettled(
      targets.map(async (target) => {
        const { ok } = await target.client.playDeeplink(content.deeplink);
        if (!ok) throw new Error('колонка отклонила запуск');
        return target;
      }),
    );

    const sent = targets.filter((_, i) => results[i].status === 'fulfilled');
    const failed = results
      .map((result, i) =>
        result.status === 'rejected'
          ? `${targets[i].cfg.name}: ${humanError(result.reason)}`
          : null,
      )
      .filter(Boolean);

    if (!sent.includes(runtime)) {
      throw new Error(failed[0] || 'Колонка не приняла команду запуска');
    }

    const beforeTrack = runtime.track?.track_id || null;
    const beforePlaylist = runtime.track?.playlist_id || null;
    let view = null;
    let confirmed = false;
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      view = await runtime.pollNow().catch(() => null);
      if (view) {
        if (content.kind === 'track') {
          if (view.trackId === String(content.id)) confirmed = true;
          else if (view.trackId && view.trackId !== beforeTrack) confirmed = true;
        } else {
          if (view.playlistId && view.playlistId === String(content.id)) confirmed = true;
          else if (view.playlistId && view.playlistId !== beforePlaylist) confirmed = true;
          else if (view.trackId && view.trackId !== beforeTrack) confirmed = true;
        }
      }
      if (confirmed) break;
      await sleep(350);
    }

    if (!confirmed) {
      try {
        const track = await runtime.client.getMetadata();
        if (track) runtime._adoptTrack(track);
      } catch {
        /* подтверждение необязательно — команда уже принята */
      }
    }

    this.notify();
    log(
      `[${runtime.cfg.name}] запуск ${content.kind} ${content.id}` +
        `${confirmed ? '' : ' (без подтверждения)'}${failed.length ? `; ошибки: ${failed.join('; ')}` : ''}`,
    );

    return {
      ok: true,
      confirmed,
      content: {
        kind: content.kind,
        id: content.id,
        title: content.title || null,
        subtitle: content.subtitle || null,
        cover: content.cover || null,
        deeplink: content.deeplink,
      },
      failed,
      multiroom: mr.snapshot(),
      speaker: runtime.snapshot(),
    };
  }

  // ───────────────────────────── multiroom ─────────────────────────────

  async startMultiroom(sourceId) {
    const id =
      sourceId ||
      [...this.runtimes.values()].find((r) => r.track?.playing && r.track?.media_source === 'MUSIC')?.cfg.id ||
      [...this.runtimes.values()].find((r) => r.track?.track_id)?.cfg.id;
    if (!id) throw new Error('Укажите колонку, с которой начинается мультирум');
    return this.multiroom.start(id);
  }

  async stopMultiroom() {
    return this.multiroom.stop({ pause: true });
  }

  async leaveMultiroom(id) {
    return this.multiroom.leave(id);
  }
}
