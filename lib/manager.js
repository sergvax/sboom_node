/**
 * Менеджер колонок: по одному supervisor-циклу на устройство,
 * push-обновления трека, поллинг громкости, optimistic-команды.
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import { SpeakerClient } from './speaker.js';
import { parseState, parseTrack, trackFromState, coverUrl } from './parsers.js';
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
      title: info.title || null,
      buffering: Boolean(player?.playingPending),
    };

    // Другой трек (радио/BT/deeplink) — подтягиваем его в state для UI.
    if (json && view.trackId && view.trackId !== this.track?.track_id) {
      const fresh = trackFromState(json);
      if (fresh) this._adoptTrack(fresh);
    }
    return view;
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
const SYNC_TOLERANCE_SEC = 2; // позиция в state целочисленная — меньше 2 c не правим
const JOIN_TIMEOUT_MS = 12_000;

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
      message: `Запускаем на ${targets.length} ${targets.length === 1 ? 'колонке' : 'колонках'}…`,
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
      await this._alignAll({ play: Boolean(source.track.playing) });

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

  /** Общий старт: пауза → seek в одну позицию → одновременный play. */
  async _alignAll({ play, lead = 2.2 }) {
    const members = this._members();
    if (!members.length) return;
    const source = this.m.runtimes.get(this.sourceId);
    const srcView = await source?.pollNow().catch(() => null);
    const base = srcView?.position ?? source?.track?.position ?? 0;
    const target = Math.max(0, Math.round(base + (play ? lead : 0)));

    await Promise.allSettled(members.map((r) => r.client?.pause()));
    await sleep(250);
    await Promise.allSettled(members.map((r) => r.client?.seek(target)));
    await sleep(600);
    if (play) await Promise.allSettled(members.map((r) => r.client?.play()));
  }

  _startMonitor() {
    this._stopMonitor();
    this._pausedTicks = 0;
    this.timer = setInterval(() => this._tick().catch(() => {}), SYNC_INTERVAL_MS);
    this.timer.unref?.();
  }

  _stopMonitor() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async _tick() {
    if (!this.active || this.busy) return;

    const source = this.m.runtimes.get(this.sourceId);
    if (!source || source.status !== 'connected' || !source.client?.connected) {
      await this.stop({ pause: true, reason: 'Колонка-источник отключилась' });
      return;
    }
    const src = await source.pollNow().catch(() => null);
    if (!src) return;

    this._pausedTicks = src.playing ? 0 : this._pausedTicks + 1;

    const followers = this.memberIds
      .filter((id) => id !== this.sourceId)
      .map((id) => this.m.runtimes.get(id))
      .filter((r) => r && r.status === 'connected' && r.client?.connected);

    if (!followers.length) {
      await this.stop({ pause: false, reason: 'В мультируме не осталось колонок' });
      return;
    }

    for (const f of followers) {
      if (this._linking.has(f.cfg.id)) continue;
      const v = await f.pollNow().catch(() => null);
      if (!v) continue;

      // Источник переключил трек — догоняем его через deeplink.
      if (src.trackId && v.trackId !== src.trackId) {
        this._relink(f, src).catch(() => {});
        continue;
      }
      // Зеркалим play/pause (пауза — только если источник стоит уже тик).
      if (src.playing && !v.playing) {
        await f.client.play().catch(() => {});
        continue;
      }
      if (!src.playing && v.playing && this._pausedTicks >= 1) {
        await f.client.pause().catch(() => {});
        continue;
      }
      // Дрейф позиции: state отдаёт целые секунды, правим от 2 c.
      if (src.playing && v.playing && src.position !== null && v.position !== null) {
        const drift = v.position - src.position;
        if (Math.abs(drift) >= SYNC_TOLERANCE_SEC) {
          await f.client.seek(Math.max(0, src.position + 1)).catch(() => {});
          log(`[мультирум] выравнивание ${f.cfg.name}: ${drift > 0 ? '+' : ''}${drift} c`);
        }
      }
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

      const deadline = Date.now() + 8000;
      let view = null;
      while (Date.now() < deadline) {
        view = await follower.pollNow().catch(() => null);
        if (view?.trackId === src.trackId) break;
        await sleep(500);
      }

      const now = await this.m.runtimes.get(this.sourceId)?.pollNow().catch(() => null);
      const base = now?.position ?? src.position ?? 0;
      const target = Math.max(0, Math.round(base + 1));
      await follower.client.pause().catch(() => {});
      await follower.client.seek(target).catch(() => {});
      if (now?.playing ?? src.playing) await follower.client.play().catch(() => {});
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
  constructor({ store }) {
    super();
    this.store = store;
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
