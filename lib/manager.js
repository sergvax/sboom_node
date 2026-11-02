/**
 * Менеджер колонок: по одному supervisor-циклу на устройство,
 * push-обновления трека, поллинг громкости, optimistic-команды.
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import { SpeakerClient } from './speaker.js';
import { parseState, parseTrack, trackFromState, coverUrl } from './parsers.js';
import { deeplinkFor, PLAY_KINDS } from './zvuk.js';
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
} from './protocol.js';

function log(...args) {
  console.log(new Date().toISOString().slice(11, 19), ...args);
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

class SpeakerRuntime {
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

    this._stopping = false;
    this._loopPromise = null;
    this._everConnected = false;
    this._volTimer = null;
    this._metaTimer = null;
    this._pollFailures = 0;
    this._wake = null;
    this._pairFailures = 0;
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
      updatedAt: Date.now(),
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
            if (this._stopping) finish();
          }, 250);
          watch.unref?.();
          client.once('closed', finish);
          if (this._stopping) finish();
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
    const player = json?.background_apps?.find(
      (a) => a?.app_info?.systemName === 'music' || a?.app_info?.systemName === 'bluetooth_media_control',
    )?.state?.player;
    const info = player?.info || {};
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
    return view;
  }

  /**
   * Замер для синхронизации: позиция + оценка момента, к которому она относится.
   * Не трогает состояние UI и не шлёт notify — можно опрашивать часто.
   * `at` = середина RTT, точность ~10 мс.
   */
  async measure() {
    const client = this.client;
    if (!client?.connected) return null;
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
    const player = json?.background_apps?.find(
      (a) => a?.app_info?.systemName === 'music' || a?.app_info?.systemName === 'bluetooth_media_control',
    )?.state?.player;
    if (!player) return null;
    return {
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
    if (changed) this._notify();
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

const MULTIROOM_PROPAGATE = new Set([
  'play',
  'pause',
  'playpause',
  'next',
  'prev',
  'seek',
  'shuffle',
  'repeat',
  'like',
  'unlike',
  'dislike',
]);

const SYNC_INTERVAL_MS = 4000;
const SYNC_TOLERANCE_MS = 1500; // грубая сверка по одному замеру (±0.5 c округления у каждой)
const SYNC_FINE_MS = 180; // цель точной подстройки по фазе
const JOIN_TIMEOUT_MS = 12_000;
const PHASE_SAMPLES = 8;
const PHASE_INTERVAL_MS = 250;

const sleep = (ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

/** deeplink для запуска конкретного трека Звука (проверено на прошивке 1.104). */
function deeplinkForTrack(trackId) {
  const id = String(trackId ?? '');
  if (!/^\d+$/.test(id)) return null;
  return `staros://music?tid=${id}&pt=track`;
}

/**
 * Мультирум без облака: колонки играют один трек, синхронно стартуют
 * (pause → seek → play) и периодически выравниваются по позиции.
 * Нативный мультирум Сбера требует SberCast/PTP-группу из облака,
 * поэтому локально не поднимается.
 */
class MultiroomController {
  constructor(manager) {
    this.m = manager;
    this.active = false;
    this.busy = false;
    this.state = 'idle'; // idle | starting | active | stopping | error
    this.sourceId = null;
    this.memberIds = [];
    this.message = null;
    this.timer = null;
    this._pausedTicks = 0;
    this._linking = new Set();
    this._srcTrackId = null;
    this._mismatch = new Map();
    this._ticking = false;
  }

  snapshot() {
    return {
      active: this.active,
      state: this.state,
      sourceId: this.sourceId,
      memberIds: [...this.memberIds],
      message: this.message,
    };
  }

  _members() {
    return this.memberIds.map((id) => this.m.runtimes.get(id)).filter(Boolean);
  }

  _set(patch) {
    Object.assign(this, patch);
    this.m.notify();
  }

  // ───────────────────────────── start / stop ─────────────────────────────

  async start(sourceId) {
    if (this.busy) throw new Error('Мультирум уже запускается');
    if (this.active) throw new Error('Мультирум уже включён');

    const source = this.m.get(sourceId);
    if (!source?.client?.connected) throw new Error('Колонка-источник не в сети');
    // Свежий срез: трек мог смениться, а push ещё не пришёл.
    await source.pollNow().catch(() => null);
    const srcTrack = source.track;
    if (!srcTrack?.track_id) {
      throw new Error('Мультирум доступен для музыки Звука — включите трек или волну.');
    }
    if (srcTrack.media_source && srcTrack.media_source !== 'MUSIC') {
      throw new Error('Мультирум доступен только для музыки Звука — радио и Bluetooth не переносятся.');
    }
    const link = deeplinkForTrack(srcTrack.track_id);
    if (!link) throw new Error('Не удалось определить трек для мультирума');

    const targets = [...this.m.runtimes.values()].filter(
      (r) => r.cfg.id !== sourceId && r.status === 'connected' && r.client?.connected,
    );
    if (!targets.length) throw new Error('Нет других колонок в сети');

    this.busy = true;
    this._set({
      state: 'starting',
      message: `Запускаем и выравниваем на ${targets.length} ${targets.length === 1 ? 'колонке' : 'колонках'}…`,
      sourceId,
      memberIds: [sourceId],
    });

    const joined = [];
    const failed = [];
    try {
      await Promise.all(
        targets.map(async (t) => {
          try {
            const { ok } = await t.client.playDeeplink(link);
            if (!ok) throw new Error('колонка отклонила запуск');
            joined.push(t);
          } catch (err) {
            failed.push(`${t.cfg.name}: ${humanError(err)}`);
          }
        }),
      );
      if (!joined.length) throw new Error('Не удалось запустить трек ни на одной колонке');

      // ждём, пока ведомые реально переключатся на этот трек
      let pending = [...joined];
      const deadline = Date.now() + JOIN_TIMEOUT_MS;
      while (pending.length && Date.now() < deadline) {
        const views = await Promise.all(pending.map((t) => t.pollNow().catch(() => null)));
        pending = pending.filter((_, i) => views[i]?.trackId !== source.track.track_id);
        if (pending.length) await sleep(600);
      }
      const ready = joined.filter((t) => !pending.includes(t));
      if (!ready.length) throw new Error('Колонки не переключились на трек');

      this.memberIds = [sourceId, ...ready.map((t) => t.cfg.id)];
      if (source.track.playing) await this._syncFollowers();
      else await this._syncPaused();

      this.active = true;
      this.state = 'active';
      this.message = failed.length ? `Пропущены: ${failed.join('; ')}` : null;
      this._startMonitor();
      log(`[мультирум] источник ${source.cfg.name}, участников ${this.memberIds.length}`);
      return this.snapshot();
    } catch (err) {
      await Promise.allSettled(targets.map((t) => t.client?.pause()));
      this.active = false;
      this.sourceId = null;
      this.memberIds = [];
      this.state = 'error';
      this.message = humanError(err);
      throw err;
    } finally {
      this.busy = false;
      this.m.notify();
    }
  }

  async stop({ pause = true, reason = null } = {}) {
    if (!this.active && this.state !== 'error') return this.snapshot();
    this.busy = true;
    this.state = 'stopping';
    this.m.notify();
    this._stopMonitor();
    const members = this._members();
    this.active = false;
    if (pause) await Promise.allSettled(members.map((r) => r.client?.pause()));
    this.memberIds = [];
    this.sourceId = null;
    this.state = 'idle';
    this.message = reason;
    this.busy = false;
    log(`[мультирум] остановлен${reason ? `: ${reason}` : ''}`);
    this.m.notify();
    return this.snapshot();
  }

  /** Выход одной колонки из группы: источник останавливает весь мультирум. */
  async leave(id) {
    if (!this.active) throw new Error('Мультирум не включён');
    if (id === this.sourceId) return this.stop({ pause: true });
    const runtime = this.m.runtimes.get(id);
    if (!runtime) throw new Error('Колонка не найдена');
    this.memberIds = this.memberIds.filter((x) => x !== id);
    await runtime.client?.pause().catch(() => {});
    this.m.notify();
    return this.snapshot();
  }

  /** Колонку удалили из приложения. */
  async forget(id) {
    if (!this.active) return;
    if (id === this.sourceId) {
      await this.stop({ pause: true });
      return;
    }
    this.memberIds = this.memberIds.filter((x) => x !== id);
    this.m.notify();
  }

  // ───────────────────────────── sync ─────────────────────────────

  /** Ведомые колонки, которые сейчас в сети. */
  _followers() {
    return this.memberIds
      .filter((id) => id !== this.sourceId)
      .map((id) => this.m.runtimes.get(id))
      .filter((r) => r && r.status === 'connected' && r.client?.connected);
  }

  /** Мультирум работает или ещё запускается (в этом состоянии можно двигать колонки). */
  _running() {
    return this.active || this.state === 'starting';
  }

  /**
   * Фаза по моментам смены целой секунды. Точка отсчёта — последний переход:
   * xAtPos = когда плеер был на позиции pos (мс от tRef).
   * Регрессия по округлённым секундам смещена, если переход один и он у края
   * окна, поэтому считаем именно переходы.
   */
  _fitPhase(points) {
    if (points.length < 3) return null;
    const transitions = [];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      if (b.p - a.p === 1 && b.x - a.x <= 700) {
        transitions.push({
          x: a.x + (b.x - a.x) / 2,
          p: a.p + (b.p - a.p) / 2,
        });
      }
    }
    if (!transitions.length) return null;
    const last = transitions[transitions.length - 1];
    let sum = 0;
    for (const tr of transitions) sum += tr.x - (tr.p - last.p) * 1000;
    return { pos: last.p, xAtPos: sum / transitions.length, samples: points.length };
  }

  /**
   * Фаза воспроизведения: опрашиваем колонки параллельно и ловим моменты
   * смены целой секунды. Точность ~20–40 мс против ±0.5 c у одного замера.
   */
  async _measurePhase(runtimes, { samples = PHASE_SAMPLES, interval = PHASE_INTERVAL_MS } = {}) {
    const tRef = Date.now();
    const series = new Map(runtimes.map((r) => [r.cfg.id, []]));
    for (let i = 0; i < samples; i++) {
      const views = await Promise.all(runtimes.map((r) => r.measure().catch(() => null)));
      views.forEach((v, idx) => {
        if (v && v.playing && v.position !== null) {
          series.get(runtimes[idx].cfg.id).push({ x: v.at - tRef, p: v.position });
        }
      });
      if (i < samples - 1) await sleep(interval);
    }
    const fits = new Map();
    for (const [id, points] of series) {
      const fit = this._fitPhase(points);
      if (fit) fits.set(id, { ...fit, tRef });
    }
    return fits;
  }

  /** Момент (по часам хоста), когда плеер будет на позиции p. */
  _timeAt(fit, p) {
    return fit.tRef + fit.xAtPos + (p - fit.pos) * 1000;
  }

  /** Позиция плеера в момент t. */
  _posAt(fit, t) {
    return fit.pos + (t - fit.tRef - fit.xAtPos) / 1000;
  }

  /** На сколько миллисекунд ведомая отстаёт от источника (плюс = отстаёт). */
  _phaseOffsetMs(srcFit, fit, position) {
    return this._timeAt(fit, position) - this._timeAt(srcFit, position);
  }

  /**
   * Точный seek: позиция задаётся целой секундой, поэтому «дробную» часть
   * выбираем моментом отправки — команда должна прийти, когда источник
   * окажется ровно на этой секунде.
   */
  async _timedSeek(runtime, srcFit, latencyMs) {
    if (!this._running()) return { target: null, sentAt: null, appliedAt: null, skipped: true };
    // seek применяется только на стоящем плеере (на играющем колонка его
    // игнорирует), причём после seek воспроизведение возобновляется само.
    await runtime.client.pause().catch(() => {});
    await this._waitPaused(runtime);

    const view = await runtime.measure().catch(() => null);
    const duration = view?.duration ?? null;

    const now = Date.now() + 120;
    let target = Math.ceil(this._posAt(srcFit, now) + 1.6);
    let sendAt = this._timeAt(srcFit, target) - latencyMs;
    while (sendAt < now) {
      target += 1;
      sendAt = this._timeAt(srcFit, target) - latencyMs;
    }

    // Трек короче нужной секунды — догнать не получится. Просто продолжаем
    // играть: монитор перезапустит трек/выровняет на следующем.
    if (duration && target > duration - 1) {
      await runtime.client.play().catch(() => {});
      return { target, sentAt: null, appliedAt: null, skipped: true };
    }

    const wait = sendAt - Date.now();
    if (wait > 0) await sleep(wait);
    const sentAt = Date.now();
    log(`[мультирум] ${runtime.cfg.name}: seek → ${target} c`);
    // Иногда seek, пришедший сразу после паузы, колонка игнорирует —
    // повторяем, пока позиция не станет ровно target.
    for (let attempt = 0; attempt < 3; attempt++) {
      await runtime.client.seek(target).catch(() => {});
      const hit = await this._waitPosition(runtime, target, { timeout: 1500 });
      if (hit) {
        await runtime.client.play().catch(() => {});
        return { target, sentAt: attempt === 0 ? sentAt : Date.now(), appliedAt: hit.at };
      }
    }
    // Не получилось — хотя бы не оставляем колонку молчащей.
    await runtime.client.play().catch(() => {});
    return { target, sentAt, appliedAt: null };
  }

  /** Ждём, пока пауза реально применится (иначе seek проигнорируется). */
  async _waitPaused(runtime, { timeout = 3000 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const v = await runtime.measure().catch(() => null);
      if (v && !v.playing) return true;
      await sleep(120);
    }
    return false;
  }

  /** Ждём, пока позиция станет ровно target (seek применился). */
  async _waitPosition(runtime, target, { timeout = 5000 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const v = await runtime.measure().catch(() => null);
      if (v && v.position === target) return v;
      await sleep(80);
    }
    return null;
  }

  /** Фаза источника (без ведомых). Пара попыток — замер иногда срывается. */
  async _sourcePhase(source) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const fits = await this._measurePhase([source], { samples: 10 });
      const fit = fits.get(source.cfg.id);
      if (fit) return fit;
      if (attempt === 0) await sleep(300);
    }
    return null;
  }

  /**
   * Выравнивание ведомых под играющий источник. Источник не трогаем:
   * он остаётся точкой отсчёта. Ошибка после одного точного seek — десятки мс.
   */
  async _alignFollowers(followers, { rounds = 3, tolerance = SYNC_FINE_MS, initialSeek = true } = {}) {
    const source = this.m.runtimes.get(this.sourceId);
    const list = followers.filter(Boolean);
    if (!source || !list.length || !this._running()) return;

    let srcFit = await this._sourcePhase(source);
    if (!srcFit) return;

    const latency = new Map();
    if (initialSeek) {
      await Promise.all(
        list.map(async (f) => {
          latency.set(f.cfg.id, 120);
          const v = await f.measure().catch(() => null);
          if (v && !v.playing) await f.client.play().catch(() => {});
          const res = await this._timedSeek(f, srcFit, latency.get(f.cfg.id));
          if (res.appliedAt) {
            latency.set(f.cfg.id, res.appliedAt - res.sentAt);
            log(`[мультирум] ${f.cfg.name}: задержка seek ${Math.round(res.appliedAt - res.sentAt)} мс`);
          }
        }),
      );
      await sleep(400);
    }

    for (let round = 0; round < rounds; round++) {
      if (!this._running()) return;
      const fits = await this._measurePhase([source, ...list]);
      srcFit = fits.get(source.cfg.id) || srcFit;
      let again = false;
      for (const f of list) {
        const ff = fits.get(f.cfg.id);
        if (!ff) {
          again = true;
          log(`[мультирум] ${f.cfg.name}: фаза не измерилась, ждём`);
          continue;
        }
        const delta = this._phaseOffsetMs(srcFit, ff, srcFit.pos);
        log(`[мультирум] ${f.cfg.name}: расхождение ${Math.round(delta)} мс`);
        if (Math.abs(delta) > tolerance) {
          // компенсируем задержку seek на измеренный промах
          const next = (latency.get(f.cfg.id) || 120) + delta;
          latency.set(f.cfg.id, next);
          const res = await this._timedSeek(f, srcFit, next);
          if (res.appliedAt) latency.set(f.cfg.id, res.appliedAt - res.sentAt);
          await sleep(400);
          again = true;
        }
      }
      if (!again) break;
      await sleep(300);
    }
    this._lastAlign = Date.now();
  }

  /** Ждём, пока колонка реально заиграет: позиция должна расти. */
  async _waitSettled(runtime, { timeout = 15_000 } = {}) {
    const deadline = Date.now() + timeout;
    let prev = await runtime.measure().catch(() => null);
    while (Date.now() < deadline) {
      await sleep(600);
      const cur = await runtime.measure().catch(() => null);
      if (
        cur &&
        cur.playing &&
        !cur.pending &&
        cur.position !== null &&
        prev?.position !== null &&
        prev?.position !== undefined &&
        cur.position > prev.position
      ) {
        return cur;
      }
      prev = cur;
    }
    return prev;
  }

  /**
   * Выравнивание ведомых под играющий источник.
   * Сначала ждём устойчивого воспроизведения: seek, отправленный во время
   * буферизации, колонка молча отбрасывает и начинает трек с нуля.
   */
  async _syncFollowers({ rounds = 3 } = {}) {
    const followers = this._followers();
    if (!followers.length) return;
    await Promise.all(followers.map((f) => this._waitSettled(f)));
    await this._alignFollowers(followers, { rounds });
  }

  /** Источник на паузе: просто ставим ведомых в ту же секунду. */
  async _syncPaused() {
    const source = this.m.runtimes.get(this.sourceId);
    const src = await source?.measure().catch(() => null);
    if (!src || src.position === null) return;
    await Promise.allSettled(
      this._followers().map(async (f) => {
        await f.client.pause().catch(() => {});
        await this._waitPaused(f, { timeout: 2000 });
        await f.client.seek(src.position).catch(() => {});
        await sleep(400);
        // Seek на стоящей колонке сам возобновляет playback — гасим обратно.
        await f.client.pause().catch(() => {});
      }),
    );
  }

  _startMonitor() {
    this._stopMonitor();
    this._pausedTicks = 0;
    this._srcTrackId = this.m.runtimes.get(this.sourceId)?.track?.track_id ?? null;
    this._mismatch = new Map();
    this._lastAlign = Date.now();
    this.timer = setInterval(() => this._tick().catch(() => {}), SYNC_INTERVAL_MS);
    this.timer.unref?.();
  }

  _stopMonitor() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async _tick() {
    if (!this.active || this.busy || this._ticking) return;
    this._ticking = true;
    try {
      await this._tickBody();
    } finally {
      this._ticking = false;
    }
  }

  async _tickBody() {
    const source = this.m.runtimes.get(this.sourceId);
    if (!source || source.status !== 'connected' || !source.client?.connected) {
      await this.stop({ pause: true, reason: 'Колонка-источник отключилась' });
      return;
    }
    const src = await source.measure().catch(() => null);
    if (!src) return;

    this._pausedTicks = src.playing ? 0 : this._pausedTicks + 1;
    // Источник сам сменил трек — ведомые должны перезапуститься сразу.
    const srcChanged = Boolean(src.trackId && this._srcTrackId && src.trackId !== this._srcTrackId);
    if (src.trackId) this._srcTrackId = src.trackId;

    const followers = this._followers();
    if (!followers.length) {
      await this.stop({ pause: false, reason: 'В мультируме не осталось колонок' });
      return;
    }

    const drifters = [];
    for (const f of followers) {
      if (!this.active) return;
      if (this._linking.has(f.cfg.id)) continue;
      const v = await f.measure().catch(() => null);
      if (!v) continue;

      // Источник сменил трек (next/prev/автоплей) — ведомая запускает его заново.
      // Разовая рассинхронизация trackId (буферизация, seek) не повод
      // перезапускать трек: ждём несколько тиков подряд.
      const mismatch = Boolean(src.trackId && v.trackId && v.trackId !== src.trackId);
      if (mismatch) {
        const n = (this._mismatch.get(f.cfg.id) || 0) + 1;
        this._mismatch.set(f.cfg.id, n);
        if (srcChanged || n >= 3) {
          this._mismatch.delete(f.cfg.id);
          this._relink(f, src).catch(() => {});
        }
        continue;
      }
      this._mismatch.delete(f.cfg.id);

      // Зеркалим play/pause (пауза — только если источник стоит уже тик).
      if (src.playing && !v.playing) {
        await f.client.play().catch(() => {});
        continue;
      }
      if (!src.playing && v.playing && this._pausedTicks >= 1) {
        await f.client.pause().catch(() => {});
        continue;
      }

      // Грубая сверка по одному замеру: точность ±1 c, поэтому порог 1.5 c.
      if (src.playing && v.playing && src.position !== null && v.position !== null) {
        const now = Date.now();
        const sp = src.position + (now - src.at) / 1000;
        const fp = v.position + (now - v.at) / 1000;
        const driftMs = (fp - sp) * 1000;
        if (Math.abs(driftMs) >= SYNC_TOLERANCE_MS) {
          log(`[мультирум] ${f.cfg.name}: расхождение ${Math.round(driftMs)} мс — выравниваем`);
          drifters.push(f);
        }
      }
    }
    // Всех уехавших выравниваем одним заходом: дешевле, чем по одному.
    if (drifters.length && this.active) {
      await this._alignFollowers(drifters, { rounds: 2 });
    }
    // Периодическая точная сверка фазы: seek грубоват (±0.2–0.5 c),
    // поэтому раз в ~45 c подтягиваем только явно уехавшие колонки.
    if (this.active && Date.now() - this._lastAlign > 45_000) {
      await this._alignFollowers(followers, { rounds: 1, tolerance: 600, initialSeek: false });
    }
    this.m.notify();
  }

  /** Запустить на ведомой тот же трек и подстроить позицию под источник. */
  async _relink(follower, src) {
    if (this._linking.has(follower.cfg.id)) return;
    this._linking.add(follower.cfg.id);
    try {
      const link = deeplinkForTrack(src.trackId);
      if (!link) return;
      await follower.client.playDeeplink(link);

      const deadline = Date.now() + 10_000;
      let view = null;
      while (Date.now() < deadline) {
        view = await follower.measure().catch(() => null);
        if (view?.trackId === src.trackId) break;
        await sleep(500);
      }
      if (view?.trackId !== src.trackId) return;

      // Дать треку наполниться, затем выставить позицию по часам источника.
      await this._waitSettled(follower, { timeout: 12_000 });
      await this._alignFollowers([follower], { rounds: 2 });
      log(`[мультирум] ${follower.cfg.name} догнала трек`);
    } finally {
      this._linking.delete(follower.cfg.id);
    }
  }


  // ───────────────────────────── commands ─────────────────────────────

  async command(id, name, value) {
    const master = this.m.runtimes.get(this.sourceId);
    if (!master) throw new Error('Мультирум не активен');
    const members = this._members();

    if (name === 'playpause') name = master.track?.playing ? 'pause' : 'play';

    // next/prev: ведём по очереди источника, ведомые догоняют новый трек.
    if (name === 'next' || name === 'prev') {
      const oldId = master.track?.track_id;
      await master.command(name, value);
      const deadline = Date.now() + 6000;
      let view = null;
      while (Date.now() < deadline) {
        view = await master.pollNow().catch(() => null);
        if (view?.trackId && view.trackId !== oldId) break;
        await sleep(300);
      }
      const src = view || (await master.pollNow().catch(() => null));
      if (src?.trackId) {
        await Promise.allSettled(
          members.filter((r) => r.cfg.id !== this.sourceId).map((f) => this._relink(f, src)),
        );
      }
      return;
    }

    await Promise.allSettled(members.map((r) => r.command(name, value)));
    if (name === 'seek') await sleep(300);
    this.m.notify();
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
    const id = sourceId || [...this.runtimes.values()].find((r) => r.track?.playing)?.cfg.id;
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
