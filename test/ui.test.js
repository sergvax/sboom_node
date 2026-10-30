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

async function boot(snapshot) {
  const html = await fs.readFile(path.join(ROOT, 'public/index.html'), 'utf8');
  const app = await fs.readFile(path.join(ROOT, 'public/app.js'), 'utf8');

  const dom = new JSDOM(html, {
    url: 'http://localhost:8080/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  const events = [];
  window.fetch = async (url) => ({
    ok: true,
    status: 200,
    json: async () => (String(url).includes('/api/state') ? snapshot : { ok: true }),
  });
  window.EventSource = class {
    constructor() {
      events.push(this);
    }
    close() {}
  };

  window.eval(app);
  await new Promise((resolve) => setTimeout(resolve, 60));
  return { dom, window, events };
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
