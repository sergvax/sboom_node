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

test('UI: повтор трека отличается от повтора плейлиста цифрой на иконке', async () => {
  const snapshot = {
    serverTime: Date.now(),
    speakers: [
      speaker(10, 'Кухня', { track: track({ repeat: 'one' }) }),
      speaker(11, 'Спальня', { track: track({ repeat: 'all' }) }),
      speaker(12, 'Гостиная', { track: track({ repeat: 'off' }) }),
    ],
  };
  const { dom, window } = await boot(snapshot);

  try {
    const doc = window.document;
    const icons = [...doc.querySelectorAll('[data-action="repeat"] [data-icon]')];
    assert.equal(icons.length, 3);
    assert.match(icons[0].innerHTML, /12\.8 8\.4v7\.2/, 'у повтора трека есть «1»');
    assert.doesNotMatch(icons[1].innerHTML, /12\.8 8\.4v7\.2/, 'у плейлиста цифры нет');
    assert.doesNotMatch(icons[2].innerHTML, /12\.8 8\.4v7\.2/);
    assert.equal(
      doc.querySelectorAll('[data-action="repeat"]')[0].title,
      'Повтор трека',
    );
    assert.equal(
      doc.querySelectorAll('[data-action="repeat"]')[1].title,
      'Повтор плейлиста',
    );
  } finally {
    dom.window.close();
  }
});

test('UI: мультирум — только нативный режим, кнопки, чипы и API', async () => {
  const snapshot = {
    serverTime: Date.now(),
    speakers: [speaker(10, 'Кухня'), speaker(11, 'Спальня'), speaker(12, 'Гостиная')],
  };
  const { dom, window, events, calls } = await boot(snapshot);

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
    assert.equal(
      doc.querySelector('[data-action="g-native"]'),
      null,
      'отдельной кнопки программного/нативного режима больше нет',
    );

    // Клик по карточке запускает именно НАТИВНЫЙ эндпоинт, без вопросов.
    let confirmCalls = 0;
    window.confirm = () => {
      confirmCalls += 1;
      return true;
    };
    doc.querySelectorAll('.card')[0].querySelector('.mr-btn').click();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(confirmCalls, 0, 'запуск мультирума не спрашивает подтверждения');
    assert.ok(
      calls.some((c) => c.url === '/api/multiroom/native/start'),
      'карточка вызывает native/start',
    );
    assert.ok(
      !calls.some((c) => c.url === '/api/multiroom/start'),
      'программный мультирум из UI не запускается',
    );

    // Нативный мультирум включён: Кухня — мастер, Спальня — ведомая.
    const active = JSON.parse(JSON.stringify(snapshot));
    active.nativeMultiroom = {
      state: 'active',
      masterId: 10,
      memberIds: [10, 11],
      error: null,
      message: null,
    };
    active.speakers[0].multiroom = { enabled: true, mode: 'MASTER', stereoPair: null };
    active.speakers[1].multiroom = { enabled: true, mode: 'SLAVE', stereoPair: null };
    events[0].onmessage({ data: JSON.stringify(active) });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const cards = [...doc.querySelectorAll('.card')];
    assert.equal(cards[0].querySelector('.mr-label').textContent, 'Стоп');
    assert.equal(cards[1].querySelector('.mr-label').textContent, 'Стоп');
    assert.equal(cards[2].querySelector('.mr-label').textContent, 'Мультирум');
    assert.equal(cards[2].querySelector('.mr-btn').disabled, true);
    assert.ok(cards[0].querySelector('.mr-btn').classList.contains('active'));
    assert.equal(cards[0].querySelector('.mr-btn').disabled, false);

    assert.equal(cards[0].querySelector('.chip.multi').hidden, false);
    assert.equal(cards[0].querySelector('.chip.multi').textContent, 'мультирум');
    assert.equal(cards[1].querySelector('.chip.multi').textContent, 'мультирум');
    assert.equal(cards[2].querySelector('.chip.multi').hidden, true);

    assert.match(doc.querySelector('#groupSub').textContent, /нативный мультирум: 2/);
    const groupBtn = doc.querySelector('[data-action="g-multiroom"]');
    assert.ok(groupBtn.classList.contains('active'));
    assert.equal(groupBtn.disabled, false);
    assert.match(groupBtn.innerHTML, /<rect/, 'иконка стоп у групповой кнопки');

    // Остановка: сервер отвечает сразу, UI сам показывает остаток роспуска.
    const stopping = JSON.parse(JSON.stringify(active));
    stopping.nativeMultiroom = {
      state: 'stopping',
      masterId: 10,
      memberIds: [10, 11],
      dissolveAt: Date.now() + 6000,
    };
    events[0].onmessage({ data: JSON.stringify(stopping) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(
      doc.querySelector('#groupSub').textContent,
      /распускается, осталось ~6 с/,
      'в панели виден обратный отсчёт роспуска',
    );
    assert.equal(doc.querySelector('[data-action="g-multiroom"]').disabled, true);

    // Колонка без активного источника не может стать мастером.
    const noTrack = JSON.parse(JSON.stringify(snapshot));
    noTrack.speakers[0].track = null;
    events[0].onmessage({ data: JSON.stringify(noTrack) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(doc.querySelectorAll('.card')[0].querySelector('.mr-btn').disabled, true);
  } finally {
    dom.window.close();
  }
});

test('UI: поиск из карточки колонки, история и возврат к карточке', async () => {
  const snapshot = {
    serverTime: Date.now(),
    speakers: [speaker(10, 'Кухня'), speaker(11, 'Спальня')],
  };
  const requests = [];
  const historyCalls = [];
  const handler = async (url, options = {}) => {
    const path = new URL(url, 'http://localhost').pathname;
    if (path === '/api/history') {
      const method = options.method || 'GET';
      historyCalls.push(method);
      if (method === 'DELETE') {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [
            {
              kind: 'track',
              id: '9',
              title: 'Частый трек',
              subtitle: 'Кино',
              duration: 180,
              count: 4,
            },
            { kind: 'playlist', id: '42', title: 'Недавний плейлист', subtitle: '20 треков', count: 1 },
            { kind: 'track', id: '10', title: 'Ещё один недавний', count: 1 },
          ],
        }),
      };
    }
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
      requests.push({ url: String(url), body: JSON.parse(options.body || '{}') });
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

  const { dom, window } = await boot(snapshot, handler);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const isOpen = (el) => Boolean(el.open || el.hasAttribute('open'));

  try {
    const doc = window.document;
    const cards = [...doc.querySelectorAll('.card')];
    assert.equal(doc.querySelector('#zvukPanel'), null, 'глобальная панель убрана');
    assert.equal(cards.length, 2);

    // Поиск открывается прямо с карточки и явно привязан к её колонке.
    const searchBtn = cards[0].querySelector('[data-action="search"]');
    assert.ok(searchBtn, 'на карточке есть кнопка «Найти»');
    assert.equal(searchBtn.disabled, false);
    searchBtn.click();
    await wait(60);

    const dialog = doc.querySelector('#searchDialog');
    assert.ok(isOpen(dialog));
    assert.match(doc.querySelector('#searchTitle').textContent, /Кухня/);
    assert.match(doc.querySelector('#searchTarget').textContent, /Кухня/);
    assert.ok(historyCalls.includes('GET'));

    // Пустой запрос показывает историю: сначала частое, затем недавнее.
    let rows = [...doc.querySelectorAll('#searchResults .zp-item')];
    assert.equal(rows.length, 3);
    assert.equal(rows[0].dataset.origin, 'history');
    assert.equal(rows[0].dataset.id, '9');
    assert.match(rows[0].querySelector('.zp-meta').textContent, /×4/);
    assert.deepEqual(
      [...doc.querySelectorAll('.zp-section-head h3')].map((el) => el.textContent),
      ['Часто запускаете', 'Недавние'],
    );

    // Поиск по названию.
    doc.querySelector('#searchInput').value = 'кино';
    doc.querySelector('#searchForm').dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true }),
    );
    await wait(60);

    rows = [...doc.querySelectorAll('#searchResults .zp-item')];
    assert.equal(rows.length, 3);
    assert.equal(rows[0].querySelector('.zp-name').textContent, 'Группа крови');
    assert.equal(rows[0].querySelector('.zp-play-label').textContent, 'Играть');
    assert.match(rows[0].title, /Кухня/);
    assert.equal(doc.querySelectorAll('.zp-cover.noart').length, 3);
    assert.equal(doc.querySelectorAll('.zp-cover.empty').length, 0);

    // Запуск уходит на колонку из карточки, с метаданными и origin=search.
    rows[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(60);

    assert.equal(requests.at(-1).url, '/api/speakers/10/play');
    assert.deepEqual(requests.at(-1).body, {
      kind: 'track',
      id: '1',
      origin: 'search',
      meta: {
        kind: 'track',
        id: '1',
        title: 'Группа крови',
        subtitle: 'Кино',
        cover: null,
        duration: 250,
      },
    });
    assert.equal(isOpen(dialog), false);
    assert.ok(cards[0].classList.contains('flash'), 'после запуска подсвечивается карточка');

    // Повторное открытие и явная очистка возвращают к карточке.
    searchBtn.click();
    await wait(40);
    const reopenInput = doc.querySelector('#searchInput');
    reopenInput.value = 'кино';
    reopenInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.equal(doc.querySelector('#searchClear').hidden, false);
    doc.querySelector('#searchClear').click();
    await wait(20);
    assert.equal(isOpen(dialog), false);

    // Очистка истории.
    searchBtn.click();
    await wait(60);
    const clearHistory = doc.querySelector('[data-history-clear]');
    assert.ok(clearHistory, 'в истории есть кнопка очистки');
    clearHistory.click();
    await wait(40);
    assert.ok(historyCalls.includes('DELETE'));
    assert.ok(doc.querySelector('.search-intro'), 'после очистки показывается приглашение к поиску');

    // Ссылка/ID работают без каталога и не попадают в историю.
    doc.querySelector('#linkDetails').open = true;
    doc.querySelector('#linkInput').value = 'https://zvuk.com/track/5';
    doc.querySelector('#linkForm').dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true }),
    );
    await wait(40);
    assert.deepEqual(requests.at(-1).body, { url: 'https://zvuk.com/track/5' });
    assert.equal(isOpen(dialog), false);

    // Очередь по-прежнему открывается с карточки.
    cards[0].querySelector('[data-action="queue"]').click();
    await wait(60);
    const queueDialog = doc.querySelector('#queueDialog');
    assert.ok(isOpen(queueDialog));
    const queueRows = [...doc.querySelectorAll('.queue-item')];
    assert.equal(queueRows.length, 2);
    assert.equal(queueRows[0].classList.contains('current'), true);
    assert.match(doc.querySelector('#queueContext').textContent, /Мой плейлист/);

    queueRows[1].querySelector('[data-queue-play]').click();
    await wait(40);
    assert.deepEqual(requests.at(-1).body, { kind: 'track', id: '1002' });
  } finally {
    dom.window.close();
  }
});
test('UI: Bluetooth-диалог — список, скан, режим сопряжения и команды', async () => {
  const snapshot = {
    serverTime: Date.now(),
    speakers: [speaker(10, 'Кухня')],
  };
  const requests = [];
  const btState = {
    devices: [
      { mac: 'AA:BB:CC:DD:EE:FF', name: 'Телефон', connected: true },
      { mac: '11:22:33:44:55:66', name: 'Наушники', connected: false },
    ],
    scanned: [],
    scanning: false,
    discoverable: false,
    error: null,
  };

  const handler = async (path, options) => {
    if (path === '/api/speakers/10/bluetooth') {
      return { ok: true, status: 200, json: async () => ({ bt: btState }) };
    }
    if (path === '/api/speakers/10/bluetooth/scan') {
      requests.push({ path, method: options.method });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          bt: {
            ...btState,
            scanned: [
              { mac: '77:88:99:AA:BB:CC', name: 'Рядом', rssi: 42 },
            ],
          },
        }),
      };
    }
    if (path === '/api/speakers/10/bluetooth/discoverable') {
      requests.push({ path, method: options.method });
      return {
        ok: true,
        status: 200,
        json: async () => ({ bt: { ...btState, discoverable: true } }),
      };
    }
    if (path === '/api/speakers/10/bluetooth/command') {
      const body = JSON.parse(options.body || '{}');
      requests.push({ path, method: options.method, body });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          bt: {
            ...btState,
            devices: btState.devices.map((d) =>
              d.mac === body.mac ? { ...d, connected: body.command === 'connect' } : d,
            ),
          },
        }),
      };
    }
    return null;
  };

  const { dom, window } = await boot(snapshot, handler);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const isOpen = (el) => Boolean(el.open || el.hasAttribute('open'));

  try {
    const doc = window.document;
    const btBtn = doc.querySelector('[data-action="bluetooth"]');
    assert.ok(btBtn, 'на карточке есть кнопка Bluetooth');
    assert.equal(btBtn.disabled, false);

    btBtn.click();
    await wait(60);

    const dialog = doc.querySelector('#btDialog');
    assert.ok(isOpen(dialog));
    assert.match(doc.querySelector('#btTitle').textContent, /Кухня/);

    let rows = [...doc.querySelectorAll('#btList .bt-item')];
    assert.equal(rows.length, 2);
    assert.equal(rows[0].querySelector('.bt-name').textContent, 'Телефон');
    assert.ok(rows[0].querySelector('.bt-state.on'), 'подключённое устройство помечено');
    assert.equal(rows[0].querySelector('[data-bt-action]').textContent, 'Отключить');

    // Скан рядом.
    doc.querySelector('#btScan').click();
    await wait(60);
    assert.equal(requests.at(-1).path, '/api/speakers/10/bluetooth/scan');
    rows = [...doc.querySelectorAll('#btScanList .bt-item')];
    assert.equal(rows.length, 1);
    assert.match(rows[0].querySelector('.bt-meta').textContent, /42 dBm/);

    // Режим сопряжения.
    doc.querySelector('#btDiscoverable').click();
    await wait(60);
    assert.equal(requests.at(-1).path, '/api/speakers/10/bluetooth/discoverable');
    assert.match(doc.querySelector('#btHint').textContent, /Режим сопряжения включён/);

    // Отключение устройства.
    doc.querySelector('#btList [data-bt-action="disconnect"]').click();
    await wait(60);
    const cmd = requests.at(-1);
    assert.equal(cmd.path, '/api/speakers/10/bluetooth/command');
    assert.deepEqual(cmd.body, { mac: 'AA:BB:CC:DD:EE:FF', command: 'disconnect' });
    rows = [...doc.querySelectorAll('#btList .bt-item')];
    assert.equal(rows[0].querySelector('[data-bt-action]').textContent, 'Подключить');
    assert.equal(rows[0].querySelector('.bt-state.on'), null);
  } finally {
    dom.window.close();
  }
});

test('UI: диагностика мультирума — таблица, рекомендация мастера и замеры', async () => {
  const snapshot = {
    serverTime: Date.now(),
    speakers: [speaker(10, 'Кухня'), speaker(11, 'Гостиная')],
  };
  const diag = {
    generatedAt: Date.now(),
    nativeMultiroom: { state: 'active', masterId: 10, memberIds: [10, 11] },
    group: { mode: 'native', masters: ['Кухня'], slaves: ['Гостиная'], members: ['Кухня', 'Гостиная'] },
    recommendedMaster: { id: 10, name: 'Кухня', score: 120, reason: 'играет, RTT 8 мс, UDP v7' },
    speakers: [
      {
        id: 10,
        name: 'Кухня',
        status: 'connected',
        mode: 'MASTER',
        playing: true,
        position: 42,
        rttMs: 8,
        stateAgeMs: 90,
        clockOffsetMs: 3,
        udpProtocolVersion: 7,
        product: 'sberboom',
        mrGroup: ['Кухня', 'Гостиная'],
      },
      {
        id: 11,
        name: 'Гостиная',
        status: 'connected',
        mode: 'SLAVE',
        playing: true,
        position: 42,
        rttMs: 12,
        stateAgeMs: 140,
        clockOffsetMs: -2,
        udpProtocolVersion: 7,
        product: 'stargate',
        mrGroup: ['Кухня', 'Гостиная'],
      },
    ],
  };

  const handler = async (url) => {
    if (String(url).startsWith('/api/diagnostics?fresh=1')) {
      return { ok: true, status: 200, json: async () => diag };
    }
    return null;
  };
  const { dom, window, calls } = await boot(snapshot, handler);

  try {
    const doc = window.document;
    doc.querySelector('[data-action="g-diagnostics"]').click();
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.ok(calls.some((c) => c.url.startsWith('/api/diagnostics?fresh=1')));
    assert.equal(doc.querySelector('#diagDialog').open, true);
    assert.match(doc.querySelector('#diagSub').textContent, /нативная группа: Кухня, Гостиная/);
    assert.match(doc.querySelector('#diagReco').textContent, /Лучший мастер: Кухня/);

    const rows = doc.querySelectorAll('.diag-grid tbody tr');
    assert.equal(rows.length, 2);
    assert.match(rows[0].textContent, /Кухня/);
    assert.match(rows[0].textContent, /мастер/);
    assert.match(rows[0].textContent, /v7/);
    assert.match(rows[1].textContent, /ведомая/);
    assert.ok(rows[0].classList.contains('master'));
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
