/**
 * Константы протокола SberBoom (порт const.py интеграции sboom_ha).
 */

export const DEFAULT_PORT = 20000;
export const DEFAULT_USER_AGENT = 'WebSocket++/0.8.2';

export const OP_PIN_CONNECT = 4;
export const OP_GET_META_DATA = 10;
export const OP_GET_STATE = 12;
export const OP_FIND_REMOTE = 13;
export const OP_SET_VOLUME = 14;
export const OP_SET_TRACK_POS = 15;
export const OP_MEDIA_COMMAND = 16;
export const OP_GET_PLAYING_QUEUE = 17;
export const OP_KEEP_ALIVE = 18;
export const OP_SET_PLAYBACK_SPEED = 23;

export const MEDIA_CMD = {
  mute: 0,
  unmute: 1,
  next: 2,
  prev: 3,
  play: 4,
  pause: 5,
  like: 6,
  removeLike: 7,
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
export const PAIR_STATUS_WAITING = 1;
export const PAIR_STATUS_AUTHORIZED = 2;
export const PAIR_STATUS_BUSY = 3;
export const PAIR_STATUS_DISABLED = 5;
// ... и из подтверждения после нажатия «+» (request_data[6])
export const PAIR_CONFIRM_OK = 1;
export const PAIR_CONFIRM_REJECTED = 2;

export const PAIR_TIMEOUT_MS = 120_000;

export const RECONNECT_BACKOFF_SEC = [1, 2, 5, 10, 30, 60];
export const KEEPALIVE_INTERVAL_SEC = 25;
export const VOLUME_POLL_INTERVAL_SEC = 10;
export const METADATA_POLL_INTERVAL_SEC = 15;
export const STABLE_SESSION_SEC = 30;
export const POLL_FAILURES_BEFORE_RECONNECT = 2;

export const COVER_CDN = 'https://cdn-image.zvuk.com/pic';
export const COVER_SIZE = '600x600';
