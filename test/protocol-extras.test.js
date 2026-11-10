import test from 'node:test';
import assert from 'node:assert/strict';

import { SpeakerClient } from '../lib/speaker.js';
import { decode, field } from '../lib/tlv.js';
import { parseUpdatedMetaData } from '../lib/parsers.js';
import { startMockSpeaker } from '../mock/speaker.js';
import {
  DIRECTIVE_ENUM,
  MEDIA_CMD,
  OP_CANCEL_PIN_CONNECT,
  OP_CONFIRM_PIN_CONNECT,
  OP_PING,
} from '../lib/protocol.js';

function client() {
  return new SpeakerClient({ host: '127.0.0.1', token: 'secret-token', clientName: 'Test' });
}

test('новые опкоды и START_MULTIROOM', () => {
  assert.equal(OP_PING, 3);
  assert.equal(OP_CANCEL_PIN_CONNECT, 5);
  assert.equal(OP_CONFIRM_PIN_CONNECT, 6);
  assert.equal(MEDIA_CMD.startMultiroom, 8);
  assert.deepEqual(DIRECTIVE_ENUM, {
    SHOW_YOUTUBE: 0,
    DEEPLINK: 1,
    SMART_APP_DATA: 2,
    RUN_SMART_APP: 3,
  });
});

test('директива SHOW_YOUTUBE: конверт type=1, поле 4, JSON с smartAppInfo', () => {
  const c = client();
  const packet = c._serverActionEnvelope('id-1', 'SHOW_YOUTUBE', { videoId: 'abc' }, {
    systemName: 'youtube',
  });
  const env = decode(packet);
  assert.equal(env[1], 1); // DIRECTIVE
  assert.equal(env[2], 'id-1');
  assert.equal(env[3], 'secret-token');

  const body = JSON.parse(env[4][1]);
  assert.equal(body.name, 'SHOW_YOUTUBE');
  assert.deepEqual(body.payload, { videoId: 'abc' });
  assert.equal(body.type, 1);
  assert.equal(body.smartAppInfo.systemName, 'youtube');
  assert.equal(body.smartAppInfo.projectId, '');
});

test('StarCommand show_youtube: source внутри BaseCommand + payload JSON', () => {
  const c = client();
  const star = c.makeShowYoutubeStarCommand({ searchQuery: 'nirvana' });
  const decoded = decode(star);

  const show = decoded[111];
  assert.equal(typeof show, 'object');

  const base = show[1];
  const source = base[1];
  const sbercast = source[2];
  assert.equal(sbercast[1], 'Test'); // client_name
  assert.equal(sbercast[2], 1);      // medium WIFI
  assert.deepEqual(JSON.parse(show[2]), { searchQuery: 'nirvana' });
});

test('sendStarCommand: конверт type=3, поле 8 = CastStarCommandData.data', () => {
  const c = client();
  const star = c.makeShowYoutubeStarCommand({ videoId: 'xyz' });
  const seen = [];
  c._open = true;
  c.ws = { readyState: 1 };
  c._send = async (buf) => { seen.push(buf); };
  // Ответ не нужен — проверяем только отправленный конверт.
  c._pending = new Map();
  const p = c.sendStarCommand(star, 50).catch(() => {});
  return p.then(() => {
    const env = decode(seen[0]);
    assert.equal(env[1], 3); // STAR_COMMAND
    assert.equal(typeof env[8], 'object');
    assert.equal(typeof env[8][1], 'object');
    assert.ok(env[8][1][111]);
  });
});

test('pairWithPin: INPUT_PIN_CODE → ConfirmPinConnect → токен', async () => {
  const mock = await startMockSpeaker({ pinCode: '1234' });
  const c = new SpeakerClient({ host: '127.0.0.1', port: mock.port });
  await c.connect();
  try {
    const token = await c.pairWithPin('1234');
    assert.equal(token, mock.token);
    assert.equal(c.token, mock.token);
  } finally {
    await c.close();
    await mock.close();
  }
});

test('pairWithPin: неверный PIN → ошибка', async () => {
  const mock = await startMockSpeaker({ pinCode: '1234' });
  const c = new SpeakerClient({ host: '127.0.0.1', port: mock.port });
  await c.connect();
  try {
    await assert.rejects(c.pairWithPin('0000'), /Неверный PIN-код/);
  } finally {
    await c.close();
    await mock.close();
  }
});

test('push UpdateMetaData (response[5][18]) — состояние плеера и громкость', () => {
  const packet = Buffer.concat([
    field(1, 0, 2),
    field(2, 2, 'push-1'),
    field(
      5,
      2,
      field(
        18,
        2,
        field(
          1,
          2,
          Buffer.concat([
            field(10, 2, JSON.stringify({ volume: { percent: 42, muted: true }, player: { state: 'PLAYING' } })),
            field(11, 0, 42),
            field(12, 0, 1),
          ]),
        ),
      ),
    ),
  ]);
  const update = parseUpdatedMetaData(packet);
  assert.equal(update.volumePercent, 42);
  assert.equal(update.volumeMuted, true);
  assert.match(update.mediaPlayerState, /PLAYING/);
  assert.equal(parseUpdatedMetaData(field(1, 0, 2)), null);
});

test('SpeakerRuntime._handleEvent: push 18 обновляет громкость и уведомляет UI', async () => {
  const { SpeakerRuntime } = await import('../lib/manager.js');
  const manager = { notified: false, notify() { this.notified = true; }, snapshot() { return {}; } };
  const rt = new SpeakerRuntime(
    { id: 'r1', name: 'Test', host: '127.0.0.1', port: 20000, token: 't', clientId: 'c', clientName: 'Sboom' },
    manager,
  );

  const packet = Buffer.concat([
    field(1, 0, 2),
    field(5, 2, field(18, 2, field(1, 2, Buffer.concat([field(11, 0, 42), field(12, 0, 1)])))),
  ]);
  rt._handleEvent(packet, decode(packet));
  assert.equal(rt.volume, 42);
  assert.equal(rt.muted, true);
  assert.equal(manager.notified, true);
});
