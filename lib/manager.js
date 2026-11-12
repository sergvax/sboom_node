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
import { analyzePositionSamples, pickRecommendedMaster, verdictLabel, median } from './diagnostics.js';
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
  MULTIROOM_MODE,
} from './protocol.js';

function log(...args) {
  console.log(new Date().toISOString().slice(11, 19), ...args);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Локальная оценка окна видимости BT (точную длительность задаёт прошивка). */
const BT_DISCOVERABLE_WINDOW_MS = 120_000;

/** Нативный мультирум: как часто опрашивать роли и сколько ждать переход. */
const NATIVE_MR_POLL_MS = 700;
const NATIVE_MR_START_TIMEOUT_MS = 8000;
const NATIVE_MR_STOP_TIMEOUT_MS = 16_000;

/**
 * Команды, которые могут возобновить воспроизведение и тем самым отменить
 * роспуск группы (пауза + 10 с). Пока идёт остановка, их лучше не слать.
 */
const NATIVE_MR_PLAYBACK_ACTIONS = new Set([
  'play',
  'playpause',
  'next',
  'prev',
  'seek',
]);

/**
 * Один и тот же трек в нативной группе может прийти с обложкой только от
 * одной колонки: остальные отдают урезанный GetMetaData. Дополняем снимки
 * друг друга по trackId (или названию+длительности для радио).
 */
export function shareTrackArtwork(speakers) {
  const keyOf = (t) =>
    t?.trackId
      ? `id:${t.trackId}`
      : t?.title
        ? `t:${t.title}|${t.duration ?? ''}`
        : null;
  const byKey = new Map();

  for (const sp of speakers) {
    const t = sp.track;
    const key = keyOf(t);
    if (!key) continue;
    const acc = byKey.get(key) || {};
    if (!acc.cover && t.cover) acc.cover = t.cover;
    if (!acc.album && t.album) acc.album = t.album;
    if ((!acc.artists || !acc.artists.length) && t.artists?.length) acc.artists = t.artists;
    if (!acc.duration && t.duration) acc.duration = t.duration;
    byKey.set(key, acc);
  }

  for (const sp of speakers) {
    const t = sp.track;
    const src = byKey.get(keyOf(t));
    if (!src) continue;
    if (!t.cover && src.cover) t.cover = src.cover;
    if (!t.album && src.album) t.album = src.album;
    if ((!t.artists || !t.artists.length) && src.artists) t.artists = src.artists;
    if (!t.duration && src.duration) t.duration = src.duration;
  }
}

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
    this.multiroom = null;
    this.player = null;
    this.meta = null;
    this.clock = null;
    this.peers = null;
    this.lastStateAt = null;
    this.stateRttMs = null;
    this.lastMetaAt = null;
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
      multiroom: this.multiroom
        ? {
            enabled: this.multiroom.enabled,
            mode: this.multiroom.mode,
            stereoPair: this.multiroom.stereoPair,
          }
        : null,
      player: this.player
        ? {
            source: this.player.source,
            playing: this.player.playing,
            position: this.player.position,
            duration: this.player.duration,
            trackId: this.player.trackId,
            title: this.player.title,
          }
        : null,
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
    const t0 = Date.now();
    const state = await client.getState(); // обязательный запрос — проверка связи
    const t1 = Date.now();
    if (state) {
      this._mergeState(state);
      this.lastStateAt = t1;
      this.stateRttMs = t1 - t0;
    }

    // get_metadata активирует push-subscribe поток.
    try {
      const bundle = await client.getMetadataBundle();
      if (bundle.info) {
        this.meta = bundle.info;
        this.lastMetaAt = Date.now();
      }
      if (bundle.track) this._adoptTrack(bundle.track);
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
    const t0 = Date.now();
    try {
      state = await client.getState();
    } catch {
      return null;
    }
    const t1 = Date.now();
    if (!state) return null;
    this._mergeState(state);
    this.lastStateAt = t1;
    this.stateRttMs = t1 - t0;

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
    this.lastStateAt = t1;
    this.stateRttMs = t1 - t0;
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

  /**
   * Свежий срез для диагностики: GET_STATE + GetMetaData.
   * Не шлёт notify — панель диагностики запрашивает данные явно.
   * @returns {Promise<object|null>}
   */
  async diagProbe() {
    const client = this.client;
    if (!client?.connected) return null;
    let state = null;
    let rttMs = null;
    const t0 = Date.now();
    try {
      state = await client.getState();
      rttMs = Date.now() - t0;
      if (state) {
        this._mergeState(state);
        this.lastStateAt = Date.now();
        this.stateRttMs = rttMs;
      }
    } catch {
      /* останется прошлый срез */
    }
    try {
      const bundle = await client.getMetadataBundle();
      if (bundle.info) {
        this.meta = bundle.info;
        this.lastMetaAt = Date.now();
      }
      if (bundle.track) this._adoptTrack(bundle.track);
    } catch {
      /* метадата не обязательна для панели */
    }
    return state;
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
    const t0 = Date.now();
    try {
      const state = await client.getState();
      const t1 = Date.now();
      this._pollFailures = 0;
      if (state) {
        this._mergeState(state);
        this.lastStateAt = t1;
        this.stateRttMs = t1 - t0;
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
      const bundle = await client.getMetadataBundle();
      if (bundle.info) {
        this.meta = bundle.info;
        this.lastMetaAt = Date.now();
      }
      if (bundle.track) {
        this._adoptTrack(bundle.track);
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
    if (state.multiroom) this.multiroom = state.multiroom;
    if (state.player) this.player = state.player;
    if (state.timesync) this.clock = state.timesync;
    if (state.sbercast) this.peers = state.sbercast.devices;
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
    this._enrichArtwork(track);
  }

  /**
   * Если прошивка не отдала release_id/artist_ids, обложку можно добрать из
   * каталога Звука по trackId. Это особенно заметно в нативной группе:
   * трек с обложкой приходит не со всех колонок.
   */
  _enrichArtwork(track) {
    if (!track?.track_id || coverUrl(track)) return;
    const zvuk = this.manager?.zvuk;
    if (!zvuk?.getTracks) return;
    if (!this._artworkTried) this._artworkTried = new Map();
    const id = String(track.track_id);
    const triedAt = this._artworkTried.get(id);
    if (triedAt && Date.now() - triedAt < 10 * 60 * 1000) return;
    this._artworkTried.set(id, Date.now());

    zvuk
      .getTracks([id])
      .then((items) => {
        const info = (items || []).find((item) => String(item.id) === id);
        const cur = this.track;
        if (!info || !cur || String(cur.track_id) !== id) return;
        let changed = false;
        if (!cur.release_id && info.releaseId) {
          cur.release_id = String(info.releaseId);
          changed = true;
        }
        if ((!cur.artist_ids || !cur.artist_ids.length) && info.artistIds?.length) {
          cur.artist_ids = info.artistIds.map(String);
          changed = true;
        }
        if (!cur.provider) {
          cur.provider = 'zvuk';
          changed = true;
        }
        if (!cur.album && info.album) {
          cur.album = info.album;
          changed = true;
        }
        if ((!cur.artists || !cur.artists.length) && info.artists?.length) {
          cur.artists = info.artists;
          changed = true;
        }
        if (!cur.duration && info.duration) {
          cur.duration = info.duration;
          changed = true;
        }
        if (changed) this._notify();
      })
      .catch(() => {
        /* каталог недоступен — обложка останется пустой */
      });
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
    this.nativeMr = {
      state: 'idle',
      masterId: null,
      memberIds: [],
      error: null,
      message: null,
      startedAt: null,
      updatedAt: Date.now(),
    };
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
    this._syncNativeFromSpeakers();
    const speakers = [...this.runtimes.values()].map((r) => r.snapshot());
    shareTrackArtwork(speakers);
    return {
      speakers,
      multiroom: this.multiroom.snapshot(),
      nativeMultiroom: this._nativeSnapshot(),
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
    if (NATIVE_MR_PLAYBACK_ACTIONS.has(name)) this._assertNotLeavingMultiroom();
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
    if (NATIVE_MR_PLAYBACK_ACTIONS.has(name)) this._assertNotLeavingMultiroom();
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
    this._assertNotLeavingMultiroom();
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
    if (this.nativeMr.state === 'active' || this.nativeMr.state === 'starting') {
      throw new Error('Сначала выключите нативный мультирум');
    }
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

  // ─────────────────────── нативный мультирум ───────────────────────
  //
  // Прошивка умеет строить группу сама: `MediaCommand START_MULTIROOM`
  // (op=16, cmd=8) на играющей колонке. Группа собирается локально из
  // SberCast-устройств в той же сети, без облака; мастер получает
  // `multiroom.mode = MASTER`, ведомые — `SLAVE`. Через 10 с после паузы
  // прошивка выключает мультирум.

  _nativeSnapshot() {
    return { ...this.nativeMr, memberIds: [...this.nativeMr.memberIds] };
  }

  _resetNative(patch = {}) {
    this.nativeMr = {
      state: 'idle',
      masterId: null,
      memberIds: [],
      error: null,
      message: null,
      startedAt: this.nativeMr.startedAt,
      updatedAt: Date.now(),
      ...patch,
    };
    this.notify();
  }

  /**
   * Держать состояние менеджера в согласии с живыми ролями колонок.
   *
   * - Все вернулись в `NONE` → группа распущена, сбрасываем `active`.
   * - Колонки уже в группе, а менеджер считает себя `idle` (после
   *   перезапуска сервера или неудачной остановки) → показываем группу
   *   активной, чтобы кнопка «Стоп» была доступна.
   * - `starting`/`stopping` не трогаем: там идёт собственный сценарий.
   */
  _syncNativeFromSpeakers() {
    if (this.nativeMr.state === 'starting' || this.nativeMr.state === 'stopping') return;
    const list = [...this.runtimes.values()].filter((r) => r.client?.connected);
    const grouped = list.filter(
      (r) =>
        r.multiroom?.mode === MULTIROOM_MODE.master ||
        r.multiroom?.mode === MULTIROOM_MODE.slave,
    );

    if (!grouped.length) {
      if (this.nativeMr.state === 'active') {
        this.nativeMr = {
          state: 'idle',
          masterId: null,
          memberIds: [],
          error: null,
          message: null,
          startedAt: this.nativeMr.startedAt,
          updatedAt: Date.now(),
        };
      }
      return;
    }

    if (this.nativeMr.state === 'active') {
      // Состав мог измениться (колонка вышла/добавилась) — обновляем.
      const memberIds = grouped.map((r) => r.cfg.id);
      const masterId =
        this._nativeMasterCandidate(list, grouped)?.cfg.id ?? this.nativeMr.masterId ?? null;
      const same =
        masterId === this.nativeMr.masterId &&
        memberIds.length === this.nativeMr.memberIds.length &&
        memberIds.every((id) => this.nativeMr.memberIds.includes(id));
      if (same) return;
      this.nativeMr = { ...this.nativeMr, masterId, memberIds, updatedAt: Date.now() };
      return;
    }

    this.nativeMr = {
      state: 'active',
      masterId: this._nativeMasterCandidate(list, grouped)?.cfg.id ?? null,
      memberIds: grouped.map((r) => r.cfg.id),
      error: null,
      message: null,
      startedAt: this.nativeMr.startedAt ?? Date.now(),
      updatedAt: Date.now(),
    };
  }

  _nativeMembers(list) {
    return list
      .filter(
        (r) =>
          r.multiroom?.mode === MULTIROOM_MODE.master ||
          r.multiroom?.mode === MULTIROOM_MODE.slave,
      )
      .map((r) => r.cfg.id);
  }

  async _pollNativeModes(timeoutMs, done) {
    const list = [...this.runtimes.values()].filter((r) => r.client?.connected);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await Promise.allSettled(list.map((r) => r.pollNow()));
      if (done(list) || Date.now() >= deadline) return list;
      await sleep(NATIVE_MR_POLL_MS);
    }
  }

  /**
   * Запустить нативный мультирум с колонки-мастера.
   * @param {string} [masterId] по умолчанию — колонка, где играет музыка
   */
  async startNativeMultiroom(masterId) {
    if (this.nativeMr.state === 'starting' || this.nativeMr.state === 'stopping') {
      throw new Error('Мультирум уже переключается');
    }
    // Колонки могли уже быть в группе (например, её поднял другой клиент).
    this._syncNativeFromSpeakers();
    if (this.nativeMr.state === 'active') return this._nativeSnapshot();
    if (this.multiroom.active) throw new Error('Сначала выключите программный мультирум');

    const id =
      masterId ||
      [...this.runtimes.values()].find(
        (r) => r.track?.playing && r.track?.media_source === 'MUSIC',
      )?.cfg.id ||
      [...this.runtimes.values()].find((r) => r.player?.playing)?.cfg.id;
    if (!id) throw new Error('Укажите колонку-мастер');
    const master = this.get(id);
    if (!master.client?.connected) throw new Error('Колонка-мастер не в сети');

    // Без активного источника прошивка отвечает PRS_NOT_SUPPORTED_BY_AUDIO_SOURCE.
    const view = await master.pollNow();
    if (!view?.playing) {
      throw new Error(
        'Сначала включите музыку Звука на мастере — без активного источника прошивка не создаёт группу',
      );
    }

    this.nativeMr = {
      state: 'starting',
      masterId: id,
      memberIds: [id],
      error: null,
      message: 'Мультирум запускается…',
      startedAt: null,
      updatedAt: Date.now(),
    };
    this.notify();

    let result;
    try {
      result = await master.client.startMultiroom();
    } catch (err) {
      const message = humanError(err);
      this._resetNative({ error: message, message });
      throw new Error(message);
    }
    if (!result.ok) {
      const message =
        'Прошивка не создала группу: нужен активный источник (трек или радио Звука)';
      this._resetNative({ error: message, message });
      throw new Error(message);
    }

    const list = await this._pollNativeModes(NATIVE_MR_START_TIMEOUT_MS, (rows) =>
      rows.some(
        (r) =>
          r.multiroom?.mode === MULTIROOM_MODE.master ||
          r.multiroom?.mode === MULTIROOM_MODE.slave,
      ),
    );
    const members = this._nativeMembers(list);
    if (!members.length) {
      const message =
        'Колонки не перешли в нативный мультирум. Проверьте, что они в одной сети и играет музыка Звука';
      this._resetNative({ error: message, message });
      throw new Error(message);
    }

    this.nativeMr = {
      state: 'active',
      masterId: id,
      memberIds: members.includes(id) ? members : [id, ...members],
      error: null,
      message:
        members.length < 2 ? 'Другие колонки не подключились к группе' : null,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.notify();
    return this._nativeSnapshot();
  }

  /**
   * Пока группа распускается (пауза + таймаут прошивки), новый запуск звука
   * отменил бы роспуск, и колонки остались бы в мультируме. Поэтому такие
   * действия на ~10 секунд блокируем с понятным сообщением.
   */
  _assertNotLeavingMultiroom() {
    if (this.nativeMr.state === 'stopping') {
      throw new Error(
        'Мультирум ещё выходит из группы — подождите около 10 секунд и попробуйте снова',
      );
    }
  }

  /**
   * Кто в группе мастер. Прошивка не всегда показывает `MASTER` даже на
   * мастере (ведомые при этом уже `SLAVE`), поэтому смотрим ещё на
   * сохранённый id и на совпадение трека с группой.
   */
  _nativeMasterCandidate(list, grouped) {
    const direct = grouped.find((r) => r.multiroom?.mode === MULTIROOM_MODE.master);
    if (direct) return direct;
    const stored = this.nativeMr.masterId
      ? list.find((r) => r.cfg.id === this.nativeMr.masterId)
      : null;
    if (stored) return stored;
    const ids = new Set(
      grouped.map((r) => r.player?.trackId || r.track?.track_id).filter(Boolean),
    );
    if (!ids.size) return null;
    const outside = list.filter((r) => r.multiroom?.mode !== MULTIROOM_MODE.slave);
    return (
      outside.find((r) => r.player?.playing && ids.has(r.player?.trackId)) ||
      outside.find((r) => ids.has(r.player?.trackId) || ids.has(r.track?.track_id)) ||
      null
    );
  }

  /**
   * Выключить нативный мультирум.
   *
   * Сначала пробуем явную `STOP_MULTIROOM` (op=16, cmd=3) — она распускает
   * группу сразу. Если прошивка её не приняла, остаётся старый путь: пауза
   * на мастере → группа вянет по таймауту
   * (`multiroom.turnOffMultiroomAfterPauseMs`, ~10 с).
   *
   * Группу определяем по живому `multiroom.mode`, а не только по
   * сохранённому состоянию: после перезапуска сервера или неудачной
   * остановки группа может играть, пока менеджер считает себя `idle`.
   */
  async stopNativeMultiroom() {
    if (this.nativeMr.state === 'stopping') return this._nativeSnapshot();
    const list = [...this.runtimes.values()].filter((r) => r.client?.connected);
    if (!list.length) {
      this._resetNative();
      return this._nativeSnapshot();
    }

    // Берём роли из последнего среза: если группа видна, паузу отправляем
    // сразу, не дожидаясь полного опроса (GET_STATE может подвиснуть на 5 с).
    let grouped = list.filter(
      (r) =>
        r.multiroom?.mode === MULTIROOM_MODE.master ||
        r.multiroom?.mode === MULTIROOM_MODE.slave,
    );
    if (!grouped.length) {
      await Promise.allSettled(list.map((r) => r.pollNow()));
      grouped = list.filter(
        (r) =>
          r.multiroom?.mode === MULTIROOM_MODE.master ||
          r.multiroom?.mode === MULTIROOM_MODE.slave,
      );
    }
    if (!grouped.length) {
      this._resetNative();
      return this._nativeSnapshot();
    }

    // Мастер может скрывать свой режим (`NONE`, хотя ведомые уже `SLAVE`),
    // поэтому паузу шлём всем участникам группы и найденному кандидату в
    // мастера. Лишняя пауза ведомой не мешает роспуску.
    const candidate = this._nativeMasterCandidate(list, grouped);
    const targets = [...grouped];
    if (candidate && !targets.includes(candidate)) targets.push(candidate);

    this.nativeMr = {
      ...this.nativeMr,
      state: 'stopping',
      masterId: candidate?.cfg.id ?? grouped[0]?.cfg.id ?? null,
      memberIds: grouped.map((r) => r.cfg.id),
      message: 'Мультирум останавливается…',
      updatedAt: Date.now(),
    };
    this.notify();

    // `STOP_MULTIROOM` шлём не дожидаясь ответа: прошивка 1.104.35 его
    // игнорирует (отдельная команда живёт в StarCommand-канале), но на
    // других версиях он может сработать. Ждать таймаут нельзя — это лишние
    // 5 секунд к остановке.
    for (const r of targets) {
      r.client.stopMultiroom({ timeoutMs: 800 }).catch(() => {});
    }

    // Основной путь: пауза запускает штатный таймаут роспуска
    // (`multiroom.turnOffMultiroomAfterPauseMs`, ~10 с).
    const pauseAll = () =>
      Promise.allSettled(
        targets.map((r) =>
          r.client.pause().catch(() => {
            /* одна колонка могла уже уйти из группы */
          }),
        ),
      );
    await pauseAll();

    const isNone = (rows) =>
      rows.every((r) => !r.multiroom?.mode || r.multiroom.mode === MULTIROOM_MODE.none);

    // Если за 6 секунд группа не распалась, повторяем паузу: прошивка
    // взводит таймаут именно по команде, а не по факту тишины.
    let after = await this._pollNativeModes(6000, isNone);
    if (!isNone(after)) {
      await pauseAll();
      after = await this._pollNativeModes(NATIVE_MR_STOP_TIMEOUT_MS - 6000, isNone);
    }

    const left = after.filter(
      (r) => r.multiroom?.mode && r.multiroom.mode !== MULTIROOM_MODE.none,
    );
    const message = left.length
      ? `Часть колонок осталась в группе: ${left.map((r) => r.cfg.name).join(', ')}`
      : null;
    this._resetNative({ error: message, message });
    return this._nativeSnapshot();
  }

  // ─────────────────────────── диагностика ───────────────────────────

  /** Диагностический срез по одной колонке (без сети). */
  _diagRow(r) {
    const now = Date.now();
    const player = r.player;
    const meta = r.meta;
    // GET_STATE обновляет позицию каждую секунду, а media_player_state_json
    // в GetMetaData может быть снимком момента старта трека. Для UI важнее
    // живая позиция, метаданные — запасной источник.
    const position = player?.position ?? meta?.playerPosition?.val ?? null;
    return {
      id: r.cfg.id,
      name: r.cfg.name,
      host: r.cfg.host,
      status: r.status,
      mode: r.multiroom?.mode ?? null,
      stereo: Boolean(r.multiroom?.stereoPair?.active),
      playing: Boolean(player?.playing),
      position: Number.isFinite(position) ? position : null,
      positionTsMs: meta?.playerPosition?.tsMs ?? null,
      trackId: player?.trackId ?? meta?.playerState?.trackId ?? null,
      title: player?.title ?? meta?.playerState?.title ?? null,
      rttMs: Number.isFinite(r.stateRttMs) ? r.stateRttMs : null,
      stateAgeMs: r.lastStateAt ? now - r.lastStateAt : null,
      metaAgeMs: r.lastMetaAt ? now - r.lastMetaAt : null,
      clockOffsetMs: this._clockOffsetMs(r),
      udpProtocolVersion: meta?.udpProtocolVersion ?? null,
      product: meta?.device?.product ?? null,
      starVersion: meta?.device?.starVersion ?? null,
      peers: (r.peers || []).map((p) => p?.name || p?.id).filter(Boolean),
      mrInfo: meta?.multiRoomServiceInfo ?? null,
      deviceGroup: meta?.deviceGroupInfo ?? null,
    };
  }

  /**
   * Оценка смещения часов колонки относительно локального времени.
   * Учитываем середину RTT: запрос шёл t0→t1.
   */
  _clockOffsetMs(r) {
    const u = r.clock?.unixtimeMs;
    if (!Number.isFinite(u) || !r.lastStateAt) return null;
    const mid = r.lastStateAt - (Number(r.stateRttMs) || 0) / 2;
    return Math.round(u - mid);
  }

  /**
   * Панель диагностики: по каждой колонке роль, позиция, RTT, свежесть,
   * UDP-версия, соседи и состав нативной группы. `fresh` опрашивает
   * колонки перед сборкой — иначе отдаёт последние известные значения.
   *
   * @param {{fresh?: boolean}} [opts]
   */
  async diagnostics({ fresh = false } = {}) {
    if (fresh) {
      await Promise.allSettled(
        [...this.runtimes.values()].map((r) => (r.client?.connected ? r.diagProbe() : null)),
      );
    }
    const rows = [...this.runtimes.values()].map((r) => this._diagRow(r));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const peerNames = new Map();
    for (const r of this.runtimes.values()) {
      for (const peer of r.peers || []) {
        if (peer?.id) peerNames.set(peer.id, peer.name || peer.id);
      }
    }
    for (const row of rows) {
      const info = row.mrInfo;
      row.mrGroup = Array.isArray(info?.group)
        ? info.group.map((id) => byId.get(id)?.name || peerNames.get(id) || id)
        : null;
    }
    const masters = rows.filter((r) => r.mode === 'MASTER');
    const slaves = rows.filter((r) => r.mode === 'SLAVE');
    const native = this._nativeSnapshot();
    return {
      generatedAt: Date.now(),
      nativeMultiroom: native,
      group: {
        mode: native.state === 'active' ? 'native' : masters.length ? 'native' : 'none',
        masters: masters.map((r) => r.name),
        slaves: slaves.map((r) => r.name),
        members: rows.filter((r) => r.mode && r.mode !== 'NONE').map((r) => r.name),
      },
      speakers: rows,
      recommendedMaster: pickRecommendedMaster(rows),
    };
  }

  /**
   * Замер смещения часов: несколько GET_STATE на колонку, медиана
   * `timesync.unixtime - середина RTT`. Показывает, насколько часы колонок
   * расходятся между собой. На синхронизацию аудио это напрямую не влияет
   * (там монотонные часы), но расхождение полезно видеть.
   *
   * @param {{samples?: number, intervalMs?: number}} [opts]
   */
  async measureClock({ samples = 5, intervalMs = 60 } = {}) {
    const count = Math.max(1, Math.min(20, Number(samples) || 5));
    const gap = Math.max(0, Math.min(2000, Number(intervalMs) || 0));
    const list = [...this.runtimes.values()].filter((r) => r.client?.connected);

    const devices = await Promise.all(
      list.map(async (r) => {
        const readings = [];
        for (let i = 0; i < count; i++) {
          if (!r.client?.connected) break;
          const t0 = Date.now();
          let state;
          try {
            state = await r.client.getState();
          } catch {
            continue;
          }
          const t1 = Date.now();
          if (state?.timesync?.unixtimeMs) {
            const mid = (t0 + t1) / 2;
            readings.push({ offset: state.timesync.unixtimeMs - mid, rtt: t1 - t0 });
            r.clock = state.timesync;
            r.lastStateAt = t1;
            r.stateRttMs = t1 - t0;
          }
          if (gap && i < count - 1) await new Promise((res) => setTimeout(res, gap));
        }
        // Берём половину с наименьшим RTT: у неё меньше ошибка середины.
        const best = readings
          .slice()
          .sort((a, b) => a.rtt - b.rtt)
          .slice(0, Math.max(1, Math.ceil(readings.length / 2)));
        const offset = median(best.map((x) => x.offset));
        return {
          id: r.cfg.id,
          name: r.cfg.name,
          status: r.status,
          offsetMs: offset === null ? null : Math.round(offset),
          rttMs: median(readings.map((x) => x.rtt)),
          samples: readings.length,
        };
      }),
    );

    const valid = devices.filter((d) => Number.isFinite(d.offsetMs));
    const base = valid.length ? Math.round(median(valid.map((d) => d.offsetMs))) : null;
    for (const d of devices) {
      d.relativeMs =
        base !== null && Number.isFinite(d.offsetMs) ? d.offsetMs - base : null;
      if (Number.isFinite(d.rttMs)) d.rttMs = Math.round(d.rttMs);
    }
    const spread =
      valid.length > 1
        ? Math.max(...valid.map((d) => d.offsetMs)) - Math.min(...valid.map((d) => d.offsetMs))
        : null;

    return {
      measuredAt: Date.now(),
      samplesPerDevice: count,
      devices,
      medianOffsetMs: base,
      spreadMs: spread === null ? null : Math.round(spread),
    };
  }

  /**
   * Оценка рассинхрона по живой позиции из GET_STATE.
   *
   * `position` там целые секунды, но обновляется каждую секунду. Опрашиваем
   * все колонки с общим интервалом и ловим переход `val → val+1`: границу
   * секунды оцениваем как середину между последним подтверждением старого
   * значения и первым наблюдением нового. Для одной и той же секунды разница
   * этих границ между ведомой и мастером — оценка рассинхрона.
   *
   * `GetMetaData.media_player_state_json` для этого не подходит: в нативной
   * группе его `position.val`/`tsMs` могут остаться снимком старта трека.
   * Замер пассивный: звук не запускает и команды не шлёт.
   *
   * @param {{durationMs?: number, intervalMs?: number, masterId?: string}} [opts]
   */
  async measureSync({ durationMs = 10_000, intervalMs = 100, masterId = null } = {}) {
    const duration = Math.max(4000, Math.min(30000, Number(durationMs) || 10_000));
    const gap = Math.max(40, Math.min(1000, Number(intervalMs) || 100));
    const list = [...this.runtimes.values()].filter((r) => r.client?.connected);
    await Promise.allSettled(list.map((r) => r.diagProbe()));
    const playing = list.filter((r) => r.player?.playing);

    if (playing.length < 2) {
      return {
        ok: false,
        reason: 'need-two-playing',
        message: 'Для замера нужны минимум две играющие колонки',
        measuredAt: Date.now(),
        devices: this._diagRowsFor(list),
      };
    }

    const master =
      (masterId && list.find((r) => r.cfg.id === masterId)) ||
      list.find((r) => r.multiroom?.mode === 'MASTER') ||
      (this.nativeMr.masterId && list.find((r) => r.cfg.id === this.nativeMr.masterId)) ||
      playing[0];

    const byDevice = {};
    const lastSeen = {};
    for (const r of list) {
      byDevice[r.cfg.id] = [];
      lastSeen[r.cfg.id] = null;
    }
    const deadline = Date.now() + duration;

    while (Date.now() < deadline) {
      const cycleStart = Date.now();
      await Promise.allSettled(
        list.map(async (r) => {
          const t0 = Date.now();
          let state;
          try {
            state = await r.client.getState();
          } catch {
            return;
          }
          const t1 = Date.now();
          const val = state?.player?.position;
          if (!Number.isInteger(val)) return;
          r._mergeState(state);
          r.lastStateAt = t1;
          r.stateRttMs = t1 - t0;

          const mid = (t0 + t1) / 2;
          const trackId = state.player?.trackId ?? null;
          const prev = lastSeen[r.cfg.id];
          if (!prev) {
            lastSeen[r.cfg.id] = { val, mid, trackId };
            return;
          }
          // Смена трека/перемотка назад — сбрасываем без замера.
          if (prev.trackId !== trackId || val < prev.val) {
            lastSeen[r.cfg.id] = { val, mid, trackId };
            return;
          }
          if (val > prev.val) {
            byDevice[r.cfg.id].push({ val, ts: (prev.mid + mid) / 2 });
          }
          lastSeen[r.cfg.id] = { val, mid, trackId };
        }),
      );
      const wait = gap - (Date.now() - cycleStart);
      if (wait > 0) await new Promise((res) => setTimeout(res, wait));
    }

    const analysis = analyzePositionSamples(byDevice, { masterId: master.cfg.id });
    const resolutionMs = gap;
    let label = verdictLabel(analysis.verdict);
    if (analysis.ok && Number.isFinite(analysis.worstMs) && analysis.worstMs <= resolutionMs) {
      label = `в пределах точности замера (±${resolutionMs} мс)`;
    }
    return {
      ...analysis,
      measuredAt: Date.now(),
      durationMs: duration,
      resolutionMs,
      source: 'get_state',
      label,
      devices: this._diagRowsFor(list).map((row) => ({
        ...row,
        samples: byDevice[row.id]?.length || 0,
        offsetMs:
          analysis.offsets?.find((o) => o.id === row.id)?.offsetMs ??
          (row.id === analysis.masterId ? 0 : null),
      })),
    };
  }

  _diagRowsFor(list) {
    return list.map((r) => this._diagRow(r));
  }
}
