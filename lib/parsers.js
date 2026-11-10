/**
 * Парсеры payload'ов колонки (порт _parsers.py).
 *
 * GET_STATE и метаданные трека приходят как JSON внутри бинарной TLV-обёртки,
 * поэтому сначала ищем сбалансированный JSON-объект в сырых байтах.
 */
import { decode, decodeRepeated } from './tlv.js';
import { OP_GET_PAIRED_BT, OP_GET_PLAYING_QUEUE, OP_GET_SCANNED_BT } from './protocol.js';

/**
 * Сбалансированный JSON-объект, начиная с `{` на позиции start (учёт строк).
 * @param {string} s @param {number} start @returns {string|null}
 */
function extractJsonObject(s, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

const MEDIA_APPS = ['bluetooth_media_control', 'music'];

/**
 * Плеер медиа-приложения из GET_STATE.
 *
 * Прошивки кладут музыку по-разному: на SberBoom/Mini — в `background_apps`,
 * на SberPortal — в `current_app`. Ищем в обоих местах и предпочитаем
 * реально играющее приложение.
 *
 * @param {any} data разобранный GET_STATE
 * @returns {{systemName: string, player: any, info: any}|null}
 */
export function mediaPlayerFromState(data) {
  if (!data || typeof data !== 'object') return null;

  const candidates = [];
  const add = (app) => {
    if (!app || typeof app !== 'object') return;
    const systemName = (app.app_info || {}).systemName;
    if (!MEDIA_APPS.includes(systemName)) return;
    const player = (app.state || {}).player;
    if (!player || typeof player !== 'object') return;
    const info = player.info;
    if (!info || typeof info !== 'object') return;
    if (!(info.title || info.trackId || info.stationName)) return;
    candidates.push({ systemName, player, info });
  };

  // current_app первым: если музыка на переднем плане, она и есть актуальная.
  add(data.current_app);
  if (Array.isArray(data.background_apps)) {
    for (const app of data.background_apps) add(app);
  }

  return candidates.find((c) => c.player.playing) || candidates[0] || null;
}

/**
 * artists/releases: массив [{name}] (state/music) ИЛИ строка (BT-формат).
 * @param {any} value @returns {string[]}
 */
function names(value) {
  if (typeof value === 'string') return value ? [value] : [];
  if (Array.isArray(value)) {
    return value.filter((x) => x && typeof x === 'object' && x.name).map((x) => x.name);
  }
  return [];
}

/**
 * `multiroom` из GET_STATE: включён ли сервис, роль колонки и стереопара.
 * @param {any} data разобранный GET_STATE
 */
function parseMultiroomState(data) {
  const mr = data?.multiroom;
  if (!mr || typeof mr !== 'object') return null;
  const stereo = mr.stereoPair && typeof mr.stereoPair === 'object' ? mr.stereoPair : null;
  return {
    enabled: Boolean(mr.enabled),
    mode: typeof mr.mode === 'string' ? mr.mode : null,
    stereoPair: stereo
      ? {
          active: Boolean(stereo.active),
          channel: stereo.channelFromConfig || null,
          pairDevice: stereo.pairDeviceFromConfig || null,
        }
      : null,
  };
}

/**
 * Текущий медиаплеер из GET_STATE: играет ли, позиция, длительность.
 * Не заменяет `track` (его ведёт метадата), а даёт живые поля для UI
 * и для проверок нативного мультирума.
 * @param {any} data разобранный GET_STATE
 */
function parsePlayerState(data) {
  const media = mediaPlayerFromState(data);
  if (!media) return null;
  const p = media.player || {};
  return {
    source: media.systemName,
    playing: Boolean(p.playing),
    position: typeof p.position === 'number' ? Math.round(p.position) : null,
    duration: p.duration ? Math.round(Number(p.duration)) : null,
    trackId:
      media.info?.trackId !== undefined && media.info?.trackId !== null
        ? String(media.info.trackId)
        : null,
    title: media.info?.title || null,
  };
}

/**
 * Парсит GET_STATE → { volume, muted, device, multiroom, player }.
 * Возвращает null, если ни JSON, ни volume-regex не нашлись.
 * @param {Buffer} raw
 */
export function parseState(raw) {
  const s = raw.toString('utf8');
  const idx = s.indexOf('{');
  const obj = idx >= 0 ? extractJsonObject(s, idx) : null;

  if (obj !== null) {
    let data = null;
    try {
      const parsed = JSON.parse(obj);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
    } catch {
      data = null;
    }
    if (data) {
      const state = {
        volume: null,
        muted: null,
        device: parseDeviceState(data),
        multiroom: parseMultiroomState(data),
        player: parsePlayerState(data),
        raw: obj,
      };
      const volume = data.volume;
      if (volume && typeof volume === 'object') {
        if (volume.percent !== undefined && volume.percent !== null) {
          state.volume = Math.round(Number(volume.percent));
        }
        if (volume.muted !== undefined) state.muted = Boolean(volume.muted);
      }
      return state;
    }
  }

  // Fallback: битый JSON — regex по volume.
  const m = /"volume":\s*\{\s*"muted":\s*(true|false)\s*,\s*"percent":\s*(\d+)/.exec(s);
  if (m) {
    return {
      volume: Number(m[2]),
      muted: m[1] === 'true',
      device: null,
      multiroom: null,
      player: null,
      raw: idx >= 0 ? s.slice(idx) : null,
    };
  }
  return null;
}

/**
 * Push `UpdateMetaData` (ответ `request_data[18]`):
 * `{ meta_data = 1: UpdatedMetaData }`. Достаём только то, что нужно UI:
 * JSON состояния плеера (поле 10) и громкость (поля 11/12).
 *
 * @param {Buffer} raw
 * @returns {{mediaPlayerState: string|null, volumePercent: number|null, volumeMuted: boolean|null}|null}
 */
export function parseUpdatedMetaData(raw) {
  let parsed;
  try {
    parsed = decode(raw);
  } catch {
    return null;
  }
  const update = parsed?.[5]?.[18];
  if (!update || typeof update !== 'object') return null;
  const meta = update[1];
  if (!meta || typeof meta !== 'object') return null;

  const state = typeof meta[10] === 'string' ? meta[10] : null;
  const volume =
    typeof meta[11] === 'number' && Number.isFinite(meta[11]) ? Math.round(meta[11]) : null;
  let muted = null;
  if (typeof meta[12] === 'boolean') muted = meta[12];
  else if (meta[12] === 0 || meta[12] === 1) muted = meta[12] === 1;
  if (!state && volume === null && muted === null) return null;
  return { mediaPlayerState: state, volumePercent: volume, volumeMuted: muted };
}

/**
 * Очередь воспроизведения (op=17): массив `{explicit, trackId}` без названий.
 * Прошивка кладёт JSON-строку в `request_data[17][5]`.
 *
 * @param {Buffer} raw
 * @returns {{trackId: string, explicit: boolean}[]}
 */
export function parseQueue(raw) {
  let payload = null;
  try {
    const parsed = decode(raw);
    const entry =
      parsed?.[5]?.[OP_GET_PLAYING_QUEUE] || parsed?.[OP_GET_PLAYING_QUEUE] || null;
    if (entry && typeof entry === 'object') {
      payload = entry[5] ?? entry['5'] ?? null;
    }
  } catch {
    payload = null;
  }

  let items = payload;
  if (typeof items === 'string') {
    try {
      items = JSON.parse(items);
    } catch {
      items = null;
    }
  }

  // Запасной путь: JSON-массив мог прийти и без разбора TLV.
  if (!Array.isArray(items)) {
    const text = raw.toString('utf8');
    const start = text.indexOf('[{');
    if (start >= 0) {
      const end = text.indexOf('}]', start);
      if (end > start) {
        try {
          items = JSON.parse(text.slice(start, end + 2));
        } catch {
          items = null;
        }
      }
    }
  }

  if (!Array.isArray(items)) return [];
  const seen = new Set();
  const queue = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const trackId = item.trackId !== undefined && item.trackId !== null ? String(item.trackId) : null;
    if (!trackId || !/^\d+$/.test(trackId) || seen.has(trackId)) continue;
    seen.add(trackId);
    queue.push({ trackId, explicit: Boolean(item.explicit) });
    if (queue.length >= 20) break;
  }
  return queue;
}

/**
 * Общий парсер BT-списков (op=19 спаренные / op=21 найденные).
 *
 * Навигация: envelope[5] → [opTag] → repeated device-сообщения:
 * {1: mac, 2: name, 3: connected|rssi}. Любой сбой → пустой список.
 * Порт `_parse_bt_devices` из _parsers.py.
 *
 * @param {Buffer} raw
 * @param {{opTag: number, devicesField: number, withRssi?: boolean}} opts
 * @returns {{mac: string, name: string, connected?: boolean, rssi?: number|null}[]}
 */
function parseBtDevices(raw, { opTag, devicesField, withRssi = false }) {
  let env;
  try {
    env = decodeRepeated(raw);
  } catch {
    return [];
  }
  const body = env[5];
  if (!Array.isArray(body) || !body.length) return [];

  const opRepeated = decodeRepeated(body[0]);
  const opField = opRepeated[opTag];
  if (!Array.isArray(opField) || !opField.length) return [];

  const devs = decodeRepeated(opField[0])[devicesField];
  if (!Array.isArray(devs)) return [];

  const out = [];
  for (const devRaw of devs) {
    if (!Buffer.isBuffer(devRaw)) continue;
    let d;
    try {
      d = decode(devRaw);
    } catch {
      continue;
    }
    const mac = d[1];
    if (typeof mac !== 'string' || !mac) continue;
    const name = typeof d[2] === 'string' ? d[2] : '';
    const device = { mac, name };
    if (withRssi) {
      device.rssi = typeof d[3] === 'number' ? d[3] : null;
    } else {
      device.connected = Boolean(d[3]);
    }
    out.push(device);
  }
  return out;
}

/** op=19 GetPairedBluetoothDevices → список спаренных BT-устройств. */
export function parsePairedBt(raw) {
  return parseBtDevices(raw, { opTag: OP_GET_PAIRED_BT, devicesField: 1 });
}

/** op=21 GetScannedBluetoothDevices → список найденных BT-устройств (с RSSI). */
export function parseScannedBt(raw) {
  return parseBtDevices(raw, {
    opTag: OP_GET_SCANNED_BT,
    devicesField: 2,
    withRssi: true,
  });
}

/** Подсистемы устройства из GET_STATE (только то, что нужно UI). */
function parseDeviceState(data) {
  const ds = {};
  const led = (data.capabilities_state || {}).led_display || {};
  ds.led_brightness = led.brightness ?? null;
  ds.led_on = led.turned_on ?? null;

  const alarm = data.alarm;
  if (alarm && typeof alarm === 'object') {
    ds.alarms_count = alarm.alarmsCounter ?? (Array.isArray(alarm.alarms) ? alarm.alarms.length : 0);
    ds.timers_count = Array.isArray(alarm.timers) ? alarm.timers.length : 0;
    if ('playing' in alarm) ds.alarm_ringing = Boolean(alarm.playing);
  }

  const net = data.network;
  if (net && typeof net === 'object') {
    ds.network_type = net.connection_type;
    ds.network_ip = net.ip;
  }

  const tm = data.time;
  if (tm && typeof tm === 'object') ds.timezone_id = tm.timezone_id;

  const apps = data.background_apps;
  if (Array.isArray(apps)) {
    ds.app_stack = apps
      .map((a) => a && a.app_info && a.app_info.systemName)
      .filter(Boolean);
  }

  const assistant = data.assistant;
  if (assistant && typeof assistant === 'object') ds.assistant_character = assistant.character;

  return ds;
}

/** Скан вперёд от pos к ближайшей незакрытой `{`. */
function scanOpenBraceBackward(s, pos) {
  let depth = 0;
  for (let i = pos; i >= 0; i--) {
    const ch = s[i];
    if (ch === '}') depth++;
    else if (ch === '{') {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

/** Ищет JSON-объект, содержащий `"trackId":"NNN"`. */
function findTrackJson(s) {
  const m = /"trackId":"\d+"/.exec(s);
  if (!m) return null;
  const start = scanOpenBraceBackward(s, m.index - 1);
  if (start < 0) return null;
  const obj = extractJsonObject(s, start);
  if (obj === null) return null;
  let data;
  try {
    data = JSON.parse(obj);
  } catch {
    return null;
  }
  if (!data || data.trackId === undefined) return null;
  return { data, start };
}

/** State-формат: окружающий player{} перед позицией start. */
function findOuterPlayer(s, start) {
  const re = /"player"\s*:\s*\{/g;
  let lastEnd = -1;
  let m;
  while ((m = re.exec(s)) !== null && m.index < start) lastEnd = m.index + m[0].length - 1;
  if (lastEnd < 0) return {};
  const obj = extractJsonObject(s, lastEnd);
  if (!obj) return {};
  try {
    return JSON.parse(obj) || {};
  } catch {
    return {};
  }
}

/**
 * Парсит трек из payload. Поддерживает push-формат (flat) и state-обёртку
 * (info{} внутри player{}).
 * @param {Buffer} raw
 */
export function parseTrack(raw) {
  const s = raw.toString('utf8');
  const found = findTrackJson(s);
  if (!found) return null;
  const { data, start } = found;

  let outer = {};
  if (!('playing' in data)) outer = findOuterPlayer(s, start);

  const t = {
    title: data.title ?? null,
    artists: Array.isArray(data.artists)
      ? data.artists.filter((a) => a && a.name).map((a) => a.name)
      : [],
    artist_ids: Array.isArray(data.artists)
      ? data.artists.filter((a) => a && a.id !== undefined && a.id !== null).map((a) => String(a.id))
      : [],
    album: null,
    release_id: null,
    track_id: data.trackId ? String(data.trackId) : null,
    playlist_title: data.playlistTitle || outer.playlistTitle || null,
    playlist_type: data.playlistType || outer.playlistType || null,
    playlist_id: null,
    media_source: data.mediaSource || outer.mediaSource || null,
    provider: data.provider || outer.provider || null,
    station_name: null,
    duration: null,
    position: null,
    position_ts_ms: null,
    playing: false,
    shuffle: false,
    repeat: null,
    explicit: Boolean(data.explicit),
    liked: Boolean(data.like),
    buffering: false,
    has_lyrics: null,
    playback_speed: null,
  };

  const pid = data.playlistId ?? outer.playlistId;
  t.playlist_id = pid !== undefined && pid !== null ? String(pid) : null;

  if (Array.isArray(data.releases) && data.releases.length) {
    const r0 = data.releases[0] || {};
    t.album = r0.name || r0.title || null;
    if (r0.id !== undefined && r0.id !== null) t.release_id = String(r0.id);
  }

  const dur = data.duration || outer.duration || 0;
  t.duration = dur ? Math.round(Number(dur)) : null;

  for (const src of [data, outer]) {
    if (src && 'playlistLike' in src) t.playlist_liked = Boolean(src.playlistLike);
    if (src && 'childMode' in src) t.child_mode = Boolean(src.childMode);
    if (src && 'playingPending' in src) t.buffering = Boolean(src.playingPending);
  }
  if ('hasLyrics' in data) t.has_lyrics = Boolean(data.hasLyrics);

  // position: push → {tsMs, val}; state → int секунды в outer.
  const pos = data.position;
  if (pos && typeof pos === 'object') {
    if (pos.val !== undefined && pos.val !== null) t.position = Math.round(Number(pos.val));
    if (pos.tsMs !== undefined && pos.tsMs !== null) t.position_ts_ms = Number(pos.tsMs);
  } else if (typeof pos === 'number') {
    t.position = Math.round(pos);
  } else if (outer.position !== undefined && typeof outer.position === 'number') {
    t.position = Math.round(outer.position);
    if (typeof outer.stateChangedTimestamp === 'number') {
      t.position_ts_ms = Math.round(outer.stateChangedTimestamp);
    }
  }

  const statusSrc = 'playing' in data ? data : outer;
  t.playing = Boolean(statusSrc.playing);
  t.shuffle = Boolean(statusSrc.shuffle);
  t.repeat = statusSrc.repeatType ?? null;

  const speed = data.playbackSpeedRate ?? outer.playbackSpeedRate;
  if (speed !== null && speed !== undefined) {
    const f = Number(speed);
    t.playback_speed = Number.isFinite(f) ? f : null;
  }

  return t;
}

/** URL обложки из публичного CDN Звука. */
export function coverUrl(track) {
  if (!track || track.provider !== 'zvuk') return null;
  if (track.release_id) {
    return `https://cdn-image.zvuk.com/pic?type=release&id=${track.release_id}&size=600x600`;
  }
  if (track.artist_ids && track.artist_ids.length) {
    return `https://cdn-image.zvuk.com/pic?type=artist&id=${track.artist_ids[0]}&size=600x600`;
  }
  return null;
}

/** Now-playing из GET_STATE, когда get_metadata пуст (радио/BT: нет trackId). */
export function trackFromState(data) {
  const candidate = mediaPlayerFromState(data);
  if (!candidate) return null;

  const { systemName: name, player, info } = candidate;
  const releases = Array.isArray(info.releases) ? info.releases : [];
  const artists = Array.isArray(info.artists) ? info.artists : [];
  const t = {
    title: info.title || null,
    artists: names(info.artists),
    album: names(info.releases)[0] || null,
    artist_ids: artists
      .filter((a) => a && a.id !== undefined && a.id !== null)
      .map((a) => String(a.id)),
    release_id:
      releases[0] && releases[0].id !== undefined && releases[0].id !== null
        ? String(releases[0].id)
        : null,
    track_id: info.trackId ? String(info.trackId) : null,
    playlist_title: info.playlistTitle || null,
    playlist_type: info.playlistType || null,
    playlist_id:
      info.playlistId !== undefined && info.playlistId !== null
        ? String(info.playlistId)
        : null,
    media_source: null,
    provider: info.provider || null,
    station_name: info.stationName || null,
    duration: player.duration ? Math.round(Number(player.duration)) : null,
    position: typeof player.position === 'number' ? Math.round(player.position) : null,
    position_ts_ms: null,
    playing: Boolean(player.playing),
    shuffle: Boolean(player.shuffle),
    repeat: player.repeatType ?? null,
    explicit: Boolean(info.explicit),
    liked: Boolean(info.like),
    buffering: Boolean(player.playingPending),
    has_lyrics: 'hasLyrics' in info ? Boolean(info.hasLyrics) : null,
    playback_speed: player.playbackSpeedRate ?? null,
  };
  if (name === 'bluetooth_media_control' || t.provider === 'bluetooth') {
    t.media_source = 'BLUETOOTH';
  } else if (player.mode === 'radio' || t.station_name) {
    t.media_source = 'RADIO';
  } else {
    t.media_source = info.mediaSource || null;
  }
  return t;
}
