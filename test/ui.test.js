import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(import.meta.dirname, '..');

function track(overrides = {}) {
  return {
    title: 'Mock Track',
    artists: ['Mock Artist'],
    album: 'Mock Album',
    trackId: '1001',
    cover: null,
    duration: 240,
    position: 10,
    positionAt: Date.now(),
    playing: true,
    shuffle: false,
    repeat: 'off',
    liked: false,
    source: 'MUSIC',
    station: null,
    provider: 'zvuk',
    playlist: null,
    buffering: false,
    ...overrides,
  };
}

function speaker(id, name, overrides = {}) {
  return {
    id,
    name,
    host: `192.168.1.${id}`,
    port: 20000,
    paired: true,
    status: 'connected',
    error: null,
    pairing: { active: false, message: null },
    volume: 30,
    muted: false,
    device: { ip: `192.168.1.${id}`, network: 'WIFI', timezone: 'Europe/Moscow' },
    track: track(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

async function boot(snapshot, handler = null) {
  const html = await fs.readFile(path.join(ROOT, 'public/index.html'), 'utf8');
  const app = await fs.readFile(path.join(ROOT, 'public/app.js'), 'utf8');

  const dom = new JSDOM(html, {
    url: 'http://localhost:8080/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  const events = [];
  const calls = [];
  window.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (handler) {
      const result = await handler(String(url), options);
      if (result) return result;
    }
    return {
      ok: true,
      status: 200,
      json: async () => (String(url).includes('/api/state') ? snapshot : { ok: true }),
    };
  };
  window.EventSource = class {
    constructor() {
      events.push(this);
    }
    close() {}
  };

  window.eval(app);
  await new Promise((resolve) => setTimeout(resolve, 60));
  return { dom, window, events, calls };
}

test('UI: три карточки, группа, живые обновления и прогресс', async () => {
  const snapshot = {
    serverTime: Date.now(),
    speakers: [speaker(10, 'Кухня'), speaker(11, 'Спальня'), speaker(12, 'Гостиная')],
  };
  const { dom, window, events } = await boot(snapshot);

  try {
    const doc = window.document;
    const cards = doc.querySelectorAll('.card');
    assert.equal(cards.length, 3);
    assert.deepEqual(
      [...doc.querySelectorAll('.card-name')].map((el) => el.textContent),
      ['Кухня', 'Спальня', 'Гостиная'],
    );
    assert.equal(doc.querySelector('.track-title').textContent, 'Mock Track');
    assert.equal(doc.querySelector('.track-artist').textContent, 'Mock Artist');
    assert.equal(doc.querySelector('.t-dur').textContent, '4:00');

    // Общая панель появилась, т.к. колонок больше одной.
    assert.equal(doc.querySelector('#groupPanel').hidden, false);
    assert.match(doc.querySelector('#groupSub').textContent, /3 из 3/);

    // Нет оверлеев — все сопряжены и в сети.
    assert.ok([...doc.querySelectorAll('.overlay')].every((o) => o.hidden));
    // Кнопка play показывает паузу (трек играет).
    assert.match(doc.querySelector('.play-btn').innerHTML, /<rect/);

    // SSE-обновление: смена трека и громкости.
    const updated = JSON.parse(JSON.stringify(snapshot));
    updated.speakers[0].track.title = 'New Song';
    updated.speakers[0].track.playing = false;
    updated.speakers[0].volume = 77;
    events[0].onmessage({ data: JSON.stringify(updated) });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const firstCard = doc.querySelectorAll('.card')[0];
    assert.equal(firstCard.querySelector('.track-title').textContent, 'New Song');
    assert.equal(firstCard.querySelector('.vol-val').textContent, '77');
    assert.match(firstCard.querySelector('.play-btn').innerHTML, /M8 5\.14/);
  } finally {
    dom.window.close();
  }
});

test('UI: мультирум — кнопки на карточках, чипы и статус группы', async () => {
  const snapshot = {
    serverTime: Date.now(),
    speakers: [speaker(10, 'Кухня'), speaker(11, 'Спальня'), speaker(12, 'Гостиная')],
  };
  const { dom, window, events } = await boot(snapshot);

  try {
    const doc = window.document;
    const buttons = [...doc.querySelectorAll('.mr-btn')];
    assert.equal(buttons.length, 3);
    assert.ok(buttons.every((b) => !b.disabled), 'мультирум доступен на всех карточках');
    assert.deepEqual(
      [...doc.querySelectorAll('.mr-label')].map((el) => el.textContent),
      ['Мультирум', 'Мультирум', 'Мультирум'],
    );
    assert.ok([...doc.querySelectorAll('.chip.multi')].every((c) => c.hidden));

    // Мультирум включён: Кухня — источник, Спальня — участник.
    const active = JSON.parse(JSON.stringify(snapshot));
    active.multiroom = {
      active: true,
      state: 'active',
      sourceId: 10,
      memberIds: [10, 11],
      message: null,
    };
    events[0].onmessage({ data: JSON.stringify(active) });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const cards = [...doc.querySelectorAll('.card')];
    assert.equal(cards[0].querySelector('.mr-label').textContent, 'Стоп');
    assert.equal(cards[1].querySelector('.mr-label').textContent, 'Выйти');
    assert.equal(cards[2].querySelector('.mr-label').textContent, 'Мультирум');
    assert.equal(cards[2].querySelector('.mr-btn').disabled, true);
    assert.ok(cards[0].querySelector('.mr-btn').classList.contains('active'));
    assert.equal(cards[0].querySelector('.mr-btn').disabled, false);

    assert.equal(cards[0].querySelector('.chip.multi').hidden, false);
    assert.equal(cards[0].querySelector('.chip.multi').textContent, 'источник');
    assert.equal(cards[1].querySelector('.chip.multi').textContent, 'мультирум');
    assert.equal(cards[2].querySelector('.chip.multi').hidden, true);

    assert.match(doc.querySelector('#groupSub').textContent, /мультирум: 2/);
    const groupBtn = doc.querySelector('[data-action="g-multiroom"]');
    assert.ok(groupBtn.classList.contains('active'));
    assert.equal(groupBtn.disabled, false);
    assert.match(groupBtn.innerHTML, /<rect/, 'иконка стоп у групповой кнопки');

    // Колонка без трека Звука не может быть источником.
    const noTrack = JSON.parse(JSON.stringify(snapshot));
    noTrack.speakers[0].track = null;
    events[0].onmessage({ data: JSON.stringify(noTrack) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(doc.querySelectorAll('.card')[0].querySelector('.mr-btn').disabled, true);
  } finally {
    dom.window.close();
  }
});

test('UI: поиск Звука, отправка на колонку и очередь', async () => {
  const snapshot = {
    serverTime: Date.now(),
    speakers: [speaker(10, 'Кухня'), speaker(11, 'Спальня')],
  };
  const requests = [];
  const handler = async (url, options = {}) => {
    const path = new URL(url, 'http://localhost').pathname;
    if (path === '/api/search') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          query: 'кино',
          source: 'rest+graphql',
          sections: {
            tracks: [
              { kind: 'track', id: '1', title: 'Группа крови', subtitle: 'Кино', duration: 250 },
              { kind: 'track', id: '2', title: 'Звезда', subtitle: 'Кино', duration: 200 },
            ],
            playlists: [
              { kind: 'playlist', id: '77', title: 'Лучшее: Кино', subtitle: '30 треков' },
            ],
            artists: [],
            releases: [],
          },
        }),
      };
    }
    if (/^\/api\/speakers\/\d+\/play$/.test(path)) {
      requests.push(JSON.parse(options.body || '{}'));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          confirmed: true,
          content: JSON.parse(options.body || '{}'),
          state: snapshot,
        }),
      };
    }
    if (path === '/api/speakers/10/queue') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [
            { trackId: '1001', title: 'Первый', artists: ['Артист'], current: true },
            { trackId: '1002', title: 'Второй', artists: ['Артист'], current: false },
          ],
          context: { playlistTitle: 'Мой плейлист', playlistType: 'user' },
        }),
      };
    }
    return null;
  };

  const { dom, window, calls } = await boot(snapshot, handler);

  try {
    const doc = window.document;
    const select = doc.querySelector('#targetSelect');
    assert.equal(select.disabled, false);
    assert.deepEqual([...select.options].map((o) => o.textContent), ['Кухня', 'Спальня']);
    assert.match(doc.querySelector('#targetHint').textContent, /сюда пойдёт/);
    assert.match(doc.querySelector('#playHintText').textContent, /Кухня/);

    // Поиск.
    doc.querySelector('#searchInput').value = 'кино';
    doc.querySelector('#searchForm').dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    const rows = [...doc.querySelectorAll('.zp-item')];
    assert.equal(rows.length, 3);
    assert.equal(rows[0].querySelector('.zp-name').textContent, 'Группа крови');
    assert.equal(rows[0].querySelector('.zp-play-label').textContent, 'Играть');
    assert.match(rows[0].title, /Кухня/);
    assert.equal(doc.querySelectorAll('.zp-cover.noart').length, 3);
    assert.equal(doc.querySelectorAll('.zp-cover.empty').length, 0);
    assert.ok(calls.some((c) => c.url.includes('/api/search?q=')));

    // Переключение колонки меняет подсказку и адресацию запуска.
    select.value = '11';
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(doc.querySelector('#playHintText').textContent, /Спальня/);
    assert.match(rows[0].title, /Спальня/);

    // Клик по треку отправляет его на выбранную колонку.
    rows[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(requests.at(-1), { kind: 'track', id: '1' });
    assert.match(calls.at(-1).url, /\/api\/speakers\/11\/play$/);

    // Очередь.
    doc.querySelector('[data-action="queue"]').click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const dialog = doc.querySelector('#queueDialog');
    assert.ok(dialog.hasAttribute('open') || dialog.open);
    const queueRows = [...doc.querySelectorAll('.queue-item')];
    assert.equal(queueRows.length, 2);
    assert.equal(queueRows[0].classList.contains('current'), true);
    assert.match(doc.querySelector('#queueContext').textContent, /Мой плейлист/);

    queueRows[1].querySelector('[data-queue-play]').click();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(requests.at(-1), { kind: 'track', id: '1002' });
  } finally {
    dom.window.close();
  }
});
test('UI: несопряжённая колонка показывает оверлей, во время pair — сообщение', async () => {
  const snapshot = {
    serverTime: Date.now(),
    speakers: [speaker(20, 'Новая', { paired: false, status: 'unpaired', track: null, volume: null })],
  };
  const { dom, window, events } = await boot(snapshot);

  try {
    const doc = window.document;
    const overlay = doc.querySelector('.overlay');
    assert.equal(overlay.hidden, false);
    assert.equal(overlay.querySelector('.overlay-title').textContent, 'Колонка не сопряжена');
    assert.equal(overlay.querySelector('.overlay-btn').hidden, false);

    const pairing = JSON.parse(JSON.stringify(snapshot));
    pairing.speakers[0].pairing = { active: true, message: 'Нажмите «+» на корпусе колонки' };
    events[0].onmessage({ data: JSON.stringify(pairing) });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(doc.querySelector('.overlay-title').textContent, 'Сопряжение');
    assert.equal(doc.querySelector('.overlay-text').textContent, 'Нажмите «+» на корпусе колонки');
    assert.equal(doc.querySelector('.overlay-btn').hidden, true);
    assert.equal(doc.querySelector('.spinner').hidden, false);
  } finally {
    dom.window.close();
  }
});
