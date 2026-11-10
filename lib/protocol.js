/**
 * Константы протокола SberBoom (порт const.py интеграции sboom_ha).
 */

export const DEFAULT_PORT = 20000;
export const DEFAULT_USER_AGENT = 'WebSocket++/0.8.2';

export const OP_PING = 3;
export const OP_PIN_CONNECT = 4;
export const OP_CANCEL_PIN_CONNECT = 5;
export const OP_CONFIRM_PIN_CONNECT = 6;
export const OP_GAMEPAD_SESSION = 7;
export const OP_SMART_APP_STATE = 8;
export const OP_VOICE_TRANSPORT = 9;
export const OP_GET_META_DATA = 10;
export const OP_IRD_REQUEST = 11;
export const OP_GET_STATE = 12;
export const OP_FIND_REMOTE = 13;
export const OP_SET_VOLUME = 14;
export const OP_SET_TRACK_POS = 15;
export const OP_MEDIA_COMMAND = 16;
export const OP_GET_PLAYING_QUEUE = 17;
export const OP_KEEP_ALIVE = 18;
/**
 * Push-событие `UpdateMetaData` в ответе: `request_data[18]`.
 * Тот же номер, что и `keep_alive` в запросе, но в `CastRequestResponseData`
 * поле 18 — это `update_meta_data`.
 */
export const RESP_UPDATE_META_DATA = 18;
export const OP_GET_PAIRED_BT = 19;
export const OP_BT_DEVICE_COMMAND = 20;
export const OP_GET_SCANNED_BT = 21;
export const OP_BT_DISCOVERABLE = 22;
export const OP_SET_PLAYBACK_SPEED = 23;

/** Команды Bluetooth-устройству (op=20, поле 2). */
export const BT_CMD = {
  connect: 0,
  disconnect: 1,
  remove: 2,
};

/** Тип конверта SberCastMessage (поле 1). */
export const MESSAGE_TYPE_DIRECTIVE = 1;
export const MESSAGE_TYPE_REQUEST = 2;
export const MESSAGE_TYPE_STAR_COMMAND = 3;

/** Поля конверта SberCastMessage, кроме уже вынесенных. */
export const ENVELOPE_FIELD_TYPE = 1;
export const ENVELOPE_FIELD_TOKEN = 3;
export const ENVELOPE_FIELD_DIRECTIVE_DATA = 4;
export const ENVELOPE_FIELD_STAR_COMMAND_DATA = 8;

/**
 * Имена директив (CastDirectiveEnum). В конверте type=1 поле 4 лежит JSON
 * `{name, payload, smartAppInfo, type}`, где `name` — строка ниже, а `type` —
 * флаг 0/1 (есть ли smartAppInfo), а НЕ этот enum.
 */
export const DIRECTIVE_SHOW_YOUTUBE = 'SHOW_YOUTUBE';
export const DIRECTIVE_DEEPLINK = 'DEEPLINK';
export const DIRECTIVE_SMART_APP_DATA = 'SMART_APP_DATA';
export const DIRECTIVE_RUN_SMART_APP = 'RUN_SMART_APP';

/**
 * Порядок `CastDirectiveEnum` (внутренний StringEnum, name → index).
 * Не путать с JSON-полем `type` (там 0/1 — признак smartAppInfo).
 */
export const DIRECTIVE_ENUM = {
  [DIRECTIVE_SHOW_YOUTUBE]: 0,
  [DIRECTIVE_DEEPLINK]: 1,
  [DIRECTIVE_SMART_APP_DATA]: 2,
  [DIRECTIVE_RUN_SMART_APP]: 3,
};

/** Поле oneof `StarCommand.command` для show_youtube. */
export const STAR_COMMAND_SHOW_YOUTUBE = 111;
/** Источник `Source.sbercast.medium = WIFI`. */
export const STAR_COMMAND_MEDIUM_WIFI = 1;

/**
 * `PlayerResponseStatus` из ответов MediaCommand / SetVolume / Seek.
 * 0 — команда принята, 1 — источник не поддерживает действие
 * (например, `START_MULTIROOM` без активного аудиоисточника).
 */
export const PLAYER_STATUS_OK = 0;
export const PLAYER_STATUS_NOT_SUPPORTED = 1;

/** Значения `multiroom.mode` в GET_STATE. */
export const MULTIROOM_MODE = {
  none: 'NONE',
  master: 'MASTER',
  slave: 'SLAVE',
};

export const MEDIA_CMD = {
  mute: 0,
  unmute: 1,
  next: 2,
  prev: 3,
  play: 4,
  pause: 5,
  like: 6,
  removeLike: 7,
  startMultiroom: 8,
  shuffleOn: 9,
  shuffleOff: 10,
  repeatNone: 11,
  repeatPlaylist: 12,
  repeatTrack: 13,
  dislike: 14,
  removeDislike: 15,
};

/** off / all / one → опкод медиа-команды */
export const REPEAT_CMD = {
  off: MEDIA_CMD.repeatNone,
  all: MEDIA_CMD.repeatPlaylist,
  one: MEDIA_CMD.repeatTrack,
};

/** none/playlist/track/one → канон off/all/one */
export const REPEAT_TO_CANONICAL = {
  none: 'off',
  off: 'off',
  playlist: 'all',
  all: 'all',
  track: 'one',
  one: 'one',
};

export const TOKEN_TYPE_PIN_AUTH = 1;

export const ENVELOPE_FIELD_MSG_ID = 2;
export const ENVELOPE_FIELD_REQUEST_DATA = 5;

// Pair-handshake: статусы из первого ответа (request_data[4])
export const PAIR_STATUS_ERROR = 0;
export const PAIR_STATUS_WAITING = 1;
export const PAIR_STATUS_AUTHORIZED = 2;
export const PAIR_STATUS_BUSY = 3;
export const PAIR_STATUS_TOO_MANY_REQUESTS = 4;
export const PAIR_STATUS_DISABLED = 5;
// ... и из подтверждения после нажатия «+» / ввода PIN (request_data[6])
export const PAIR_CONFIRM_OK = 1;
export const PAIR_CONFIRM_WRONG_PIN = 2;
export const PAIR_CONFIRM_ATTEMPTS_LIMIT = 3;
export const PAIR_CONFIRM_BAD_SESSION = 4;
export const PAIR_CONFIRM_DISABLED = 5;
/** Обратная совместимость: раньше любой отказ трактовался как статус 2. */
export const PAIR_CONFIRM_REJECTED = PAIR_CONFIRM_WRONG_PIN;

export const PAIR_TIMEOUT_MS = 120_000;

export const RECONNECT_BACKOFF_SEC = [1, 2, 5, 10, 30, 60];
export const KEEPALIVE_INTERVAL_SEC = 25;
export const VOLUME_POLL_INTERVAL_SEC = 10;
export const METADATA_POLL_INTERVAL_SEC = 15;
export const STABLE_SESSION_SEC = 30;
export const POLL_FAILURES_BEFORE_RECONNECT = 2;

/** Кэш measure() для синхронизации мультирума (мс): убирает повторные
 *  запросы внутри одного замера фазы, но не мешает поймать смену секунды. */
export const MEASURE_CACHE_MS = 150;

export const COVER_CDN = 'https://cdn-image.zvuk.com/pic';
export const COVER_SIZE = '600x600';
