import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parsePairedBt,
  parseQueue,
  parseScannedBt,
  parseState,
  parseTrack,
  trackFromState,
  mediaPlayerFromState,
  coverUrl,
} from '../lib/parsers.js';
import { parseHostInput } from '../lib/manager.js';
import { field } from '../lib/tlv.js';
import { OP_GET_PAIRED_BT, OP_GET_PLAYING_QUEUE, OP_GET_SCANNED_BT } from '../lib/protocol.js';

const pushTrack = Buffer.concat([
  Buffer.from([0, 0]),
  Buffer.from(
    '{"artists":[{"id":"1","name":"Test Artist"}],' +
      '"childMode":false,"duration":0,"explicit":true,"like":false,' +
      '"mediaSource":"MUSIC","playbackSpeedRate":1.0,' +
      '"playing":true,"playingPending":false,' +
      '"playlistId":"100","playlistLike":false,' +
      '"playlistTitle":"Test Playlist","playlistType":"endless",' +
      '"position":{"tsMs":1700000000000,"val":184},' +
      '"provider":"zvuk",' +
      '"releases":[{"id":"200","name":"Test Album"}],' +
      '"repeatType":"none","shuffle":false,' +
      '"stateChangedTimestamp":1699999990000,' +
      '"title":"Test Track","trackId":"1001"}',
  ),
  Buffer.from([0, 0]),
]);

test('parseTrack: push-формат', () => {
  const t = parseTrack(pushTrack);
  assert.ok(t);
  assert.equal(t.track_id, '1001');
  assert.equal(t.title, 'Test Track');
  assert.deepEqual(t.artists, ['Test Artist']);
  assert.equal(t.album, 'Test Album');
  assert.equal(t.release_id, '200');
  assert.equal(t.provider, 'zvuk');
  assert.equal(t.playing, true);
  assert.equal(t.position, 184);
  assert.equal(t.position_ts_ms, 1700000000000);
  assert.equal(t.shuffle, false);
  assert.equal(t.repeat, 'none');
  assert.equal(t.playlist_title, 'Test Playlist');
  assert.equal(t.playlist_type, 'endless');
  assert.equal(t.playback_speed, 1);
  assert.equal(t.explicit, true);
});

test('parseTrack: state-формат (info/player)', () => {
  const raw = Buffer.from(
    '{"info":{"player":{' +
      '"artists":[{"id":"2","name":"Test Artist 2"}],' +
      '"playing":true,"position":120,"duration":328,"provider":"zvuk",' +
      '"releases":[{"id":"300","title":"Test Album 2"}],' +
      '"title":"Test Track 2","trackId":"2002"}}}',
  );
  const t = parseTrack(raw);
  assert.ok(t);
  assert.equal(t.title, 'Test Track 2');
  assert.deepEqual(t.artists, ['Test Artist 2']);
  assert.equal(t.album, 'Test Album 2');
  assert.equal(t.duration, 328);
  assert.equal(t.position, 120);
  assert.equal(t.playing, true);
});

test('parseTrack: мусор и пустой JSON → null', () => {
  assert.equal(parseTrack(Buffer.from('random binary garbage')), null);
  assert.equal(parseTrack(Buffer.alloc(0)), null);
  assert.equal(parseTrack(Buffer.from('{"foo":"bar"}')), null);
});

test('coverUrl строится только для zvuk и по release_id', () => {
  assert.equal(
    coverUrl({ provider: 'zvuk', release_id: '200' }),
    'https://cdn-image.zvuk.com/pic?type=release&id=200&size=600x600',
  );
  assert.equal(
    coverUrl({ provider: 'zvuk', release_id: null, artist_ids: ['7'] }),
    'https://cdn-image.zvuk.com/pic?type=artist&id=7&size=600x600',
  );
  assert.equal(coverUrl({ provider: 'bluetooth', release_id: '200' }), null);
});

test('parseState: volume/muted + подсистемы устройства', () => {
  const stateJson = JSON.stringify({
    alarm: { alarms: [], alarmsCounter: 0, playing: null, timers: [] },
    assistant: { auto_volume: false, character: 'afina' },
    background_apps: [
      {
        app_info: { systemName: 'music' },
        state: {
          player: { playing: true, position: 12, duration: 200, info: { title: 'Test', trackId: '42' } },
        },
      },
    ],
    capabilities_state: { led_display: { brightness: 100, turned_on: true } },
    multiroom: {
      enabled: true,
      mode: 'MASTER',
      stereoPair: { active: false, channelFromConfig: '', pairDeviceFromConfig: '' },
    },
    network: { connection_type: 'WIFI', ip: '192.168.1.42' },
    time: { timezone_id: 'Europe/Moscow' },
    volume: { muted: false, percent: 3 },
  });
  const raw = Buffer.concat([Buffer.from([0, 0]), Buffer.from(stateJson), Buffer.from([0, 0xff])]);
  const st = parseState(raw);
  assert.ok(st);
  assert.equal(st.volume, 3);
  assert.equal(st.muted, false);
  assert.equal(st.device.network_ip, '192.168.1.42');
  assert.equal(st.device.led_brightness, 100);
  assert.equal(st.device.timezone_id, 'Europe/Moscow');
  assert.equal(st.multiroom.mode, 'MASTER');
  assert.equal(st.multiroom.enabled, true);
  assert.equal(st.multiroom.stereoPair.active, false);
  assert.equal(st.player.playing, true);
  assert.equal(st.player.source, 'music');
});

test('parseState: битый JSON → fallback на regex volume', () => {
  const raw = Buffer.from('xxxx{"volume":{"muted":true,"percent":17},"broken": tru');
  const st = parseState(raw);
  assert.ok(st);
  assert.equal(st.volume, 17);
  assert.equal(st.muted, true);
});

test('trackFromState: радио в GET_STATE без trackId', () => {
  const track = trackFromState({
    background_apps: [
      {
        app_info: { systemName: 'music' },
        state: {
          player: {
            playing: true,
            mode: 'radio',
            duration: 0,
            position: 12,
            info: { title: '', stationName: 'Наше радио' },
          },
        },
      },
    ],
  });
  assert.ok(track);
  assert.equal(track.station_name, 'Наше радио');
  assert.equal(track.media_source, 'RADIO');
  assert.equal(track.playing, true);
});

test('mediaPlayerFromState: SberPortal кладёт музыку в current_app', () => {
  const data = {
    current_app: {
      app_info: { systemName: 'music' },
      state: {
        player: {
          playing: true,
          position: 47,
          duration: 209,
          info: { title: 'Song', trackId: 180359844 },
        },
      },
    },
    background_apps: [
      { app_info: { systemName: 'voice_auth' }, state: {} },
      { app_info: { systemName: 'weather_quiet' }, state: {} },
    ],
  };
  const media = mediaPlayerFromState(data);
  assert.ok(media);
  assert.equal(media.systemName, 'music');
  assert.equal(media.info.trackId, 180359844);

  const track = trackFromState(data);
  assert.ok(track);
  assert.equal(track.track_id, '180359844');
  assert.equal(track.position, 47);
  assert.equal(track.playing, true);
});

test('mediaPlayerFromState: играющая фоновая музыка важнее стоящей current_app', () => {
  const data = {
    current_app: {
      app_info: { systemName: 'music' },
      state: { player: { playing: false, info: { title: 'Paused', trackId: 1 } } },
    },
    background_apps: [
      {
        app_info: { systemName: 'music' },
        state: { player: { playing: true, info: { title: 'Playing', trackId: 2 } } },
      },
    ],
  };
  const media = mediaPlayerFromState(data);
  assert.ok(media);
  assert.equal(media.info.trackId, 2);
});

test('trackFromState: контекст плейлиста из info', () => {  const track = trackFromState({
    background_apps: [
      {
        app_info: { systemName: 'music' },
        state: {
          player: {
            playing: true,
            position: 5,
            duration: 200,
            info: {
              title: 'Song',
              trackId: 123,
              playlistId: 456,
              playlistTitle: 'Лучшее',
              playlistType: 'user',
              artists: [{ id: 7, name: 'Artist' }],
              releases: [{ id: 88, name: 'Album' }],
            },
          },
        },
      },
    ],
  });
  assert.ok(track);
  assert.equal(track.playlist_id, '456');
  assert.equal(track.playlist_title, 'Лучшее');
  assert.equal(track.playlist_type, 'user');
  assert.equal(track.release_id, '88');
  assert.deepEqual(track.artist_ids, ['7']);
});

test('parseQueue: JSON-строка op=17 и отсев мусора', () => {
  const payload = JSON.stringify([
    { explicit: true, trackId: 1001 },
    { explicit: false, trackId: '1002' },
    { explicit: false, trackId: 1001 },
    { trackId: 'not-a-number' },
    null,
  ]);
  const raw = field(5, 2, field(OP_GET_PLAYING_QUEUE, 2, field(5, 2, payload)));
  const queue = parseQueue(raw);
  assert.deepEqual(queue, [
    { trackId: '1001', explicit: true },
    { trackId: '1002', explicit: false },
  ]);
});

test('parseQueue: пустой ответ → []', () => {
  assert.deepEqual(parseQueue(Buffer.alloc(0)), []);
  assert.deepEqual(parseQueue(field(OP_GET_PLAYING_QUEUE, 2, Buffer.alloc(0))), []);
});

test('parsePairedBt: op=19 — MAC, имя и признак подключения', () => {
  const device = (mac, name, connected) =>
    Buffer.concat([field(1, 2, mac), field(2, 2, name), field(3, 0, connected ? 1 : 0)]);
  const inner = Buffer.concat([
    field(1, 2, device('AA:BB:CC:DD:EE:FF', 'Phone', true)),
    field(1, 2, device('11:22:33:44:55:66', 'Headphones', false)),
  ]);
  const raw = field(5, 2, field(OP_GET_PAIRED_BT, 2, inner));
  assert.deepEqual(parsePairedBt(raw), [
    { mac: 'AA:BB:CC:DD:EE:FF', name: 'Phone', connected: true },
    { mac: '11:22:33:44:55:66', name: 'Headphones', connected: false },
  ]);
});

test('parseScannedBt: op=21 — MAC, имя и RSSI', () => {
  const device = (mac, name, rssi) =>
    Buffer.concat([field(1, 2, mac), field(2, 2, name), field(3, 0, rssi)]);
  const inner = Buffer.concat([
    field(2, 2, device('77:88:99:AA:BB:CC', 'Nearby', 42)),
    field(2, 2, device('DD:EE:FF:00:11:22', '', 80)),
  ]);
  const raw = field(5, 2, field(OP_GET_SCANNED_BT, 2, inner));
  assert.deepEqual(parseScannedBt(raw), [
    { mac: '77:88:99:AA:BB:CC', name: 'Nearby', rssi: 42 },
    { mac: 'DD:EE:FF:00:11:22', name: '', rssi: 80 },
  ]);
});

test('BT-парсеры: пустой и мусорный ответ → []', () => {
  assert.deepEqual(parsePairedBt(Buffer.alloc(0)), []);
  assert.deepEqual(parseScannedBt(Buffer.from('not a tlv')), []);
  assert.deepEqual(parsePairedBt(field(5, 2, Buffer.alloc(0))), []);
});

test('parseHostInput: нормализация IP, порта и URL', () => {
  assert.deepEqual(parseHostInput('192.168.1.42'), { host: '192.168.1.42', port: 20000 });
  assert.deepEqual(parseHostInput('wss://192.168.1.42:21000/'), { host: '192.168.1.42', port: 21000 });
  assert.deepEqual(parseHostInput('sboom.local', 20100), { host: 'sboom.local', port: 20100 });
  assert.throws(() => parseHostInput(''));
  assert.throws(() => parseHostInput('192.168.1.42:99999'));
});
