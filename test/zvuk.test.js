import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  ZvukClient,
  ZvukError,
  deeplinkFor,
  parseZvukInput,
} from '../lib/zvuk.js';

const json = (body, { status = 200, headers = {} } = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

function fakeZvukFetch({ token = 'token-1', failSearch = false } = {}) {
  const calls = { profile: 0, rest: 0, graphql: 0, searchStatuses: [] };
  let currentToken = token;
  let authFailures = 0;

  const fetchImpl = async (url, options = {}) => {
    const href = String(url);
    if (href.endsWith('/api/tiny/profile')) {
      calls.profile += 1;
      return json(
        { result: { token: currentToken } },
        { headers: { 'set-cookie': ['spid=cookie-1; Path=/', 'spsc=sec-1; Path=/'] } },
      );
    }

    if (href.includes('/api/tiny/search')) {
      calls.rest += 1;
      calls.searchStatuses.push(options.headers?.['X-Auth-Token'] ? 200 : 401);
      if (failSearch) return json({ error: 'nope' }, { status: 500 });
      if (authFailures > 0) {
        authFailures -= 1;
        return new Response('', { status: 401 });
      }
      return json({
        result: {
          search: {
            best_item: { doc_type: 'track', id: 1 },
            tracks: {
              items: [
                { id: 1, title: 'Track A', aname: 'Artist A', duration: 120 },
                { id: 2, title: 'Track B', aname: 'Artist B', duration: 90 },
              ],
            },
            playlists: {
              items: [{ id: 77, title: 'Playlist A', tracks_number: 3, duration: 300 }],
            },
            artists: { items: [{ id: 555, title: 'Artist A' }] },
            releases: { items: [{ id: 99, title: 'Album A', aname: 'Artist A' }] },
          },
        },
      });
    }

    if (href.endsWith('/api/v1/graphql')) {
      calls.graphql += 1;
      const body = JSON.parse(options.body || '{}');
      const query = body.query || '';

      if (failSearch) {
        return json({ errors: [{ message: 'catalog down' }] }, { status: 500 });
      }

      if (authFailures > 0) {
        authFailures -= 1;
        return new Response('', { status: 401 });
      }

      if (query.includes('search(')) {
        return json({
          data: {
            search: {
              tracks: {
                items: [
                  {
                    id: '1',
                    title: 'Track A',
                    duration: 120,
                    explicit: false,
                    artists: [{ id: '555', title: 'Artist A' }],
                    release: { id: '99', title: 'Album A', image: { src: 'https://cdn/x/{size}' } },
                  },
                ],
              },
              playlists: { items: [{ id: '77', title: 'Playlist A', image: { src: '/static/p.png' } }] },
              artists: { items: [{ id: '555', title: 'Artist A', image: { src: '/static/a.png' } }] },
              releases: { items: [{ id: '99', title: 'Album A', image: { src: '/static/r.png' }, artists: [{ id: '555', title: 'Artist A' }] }] },
            },
          },
        });
      }
      if (query.includes('getTracks(')) {
        const ids = (body.variables?.ids || []).map(String);
        const all = [
          {
            id: '1',
            title: 'Track A',
            duration: 120,
            explicit: false,
            artists: [{ id: '555', title: 'Artist A', image: { src: '/static/a.png' } }],
            release: { id: '99', title: 'Album A', image: { src: '/static/r.png' } },
          },
        ];
        return json({ data: { getTracks: all.filter((item) => ids.includes(item.id)) } });
      }
      if (query.includes('getPlaylists(')) {
        const ids = (body.variables?.ids || []).map(String);
        const all = [
          {
            id: '77',
            title: 'Playlist A',
            image: { src: '/static/p.png' },
            tracks: [{ id: '1' }, { id: '2' }, { id: '3' }],
          },
          {
            id: '1',
            title: 'Collision',
            image: { src: '/static/p2.png' },
            tracks: [{ id: '9' }],
          },
        ];
        return json({ data: { getPlaylists: all.filter((item) => ids.includes(item.id)) } });
      }
      if (query.includes('getArtists(')) {
        return json({ data: { getArtists: [] } });
      }
      if (query.includes('getReleases(')) {
        return json({ data: { getReleases: [] } });
      }
      return json({ data: {} });
    }

    throw new Error(`unexpected url ${href}`);
  };

  return {
    calls,
    fetchImpl,
    failAuthOnce() {
      authFailures = 2;
    },
    setToken(value) {
      currentToken = value;
    },
  };
}

test('Zvuk: разбор ссылок, ID и deeplink', () => {
  assert.deepEqual(parseZvukInput('https://zvuk.com/track/123'), { kind: 'track', id: '123' });
  assert.deepEqual(parseZvukInput('zvuk.com/playlist/456?x=1'), { kind: 'playlist', id: '456' });
  assert.deepEqual(parseZvukInput('https://www.zvuk.com/album/9'), { kind: 'release', id: '9' });
  assert.deepEqual(parseZvukInput('https://zvuk.com/artist/7'), { kind: 'artist', id: '7' });
  assert.deepEqual(parseZvukInput('987654'), { kind: null, id: '987654' });
  assert.equal(parseZvukInput('spotify:track:123'), null);
  assert.equal(parseZvukInput('https://example.com/track/1'), null);
  assert.equal(parseZvukInput('кино'), null);

  assert.equal(deeplinkFor('track', '1'), 'staros://music?tid=1&pt=track');
  assert.equal(deeplinkFor('playlist', '2'), 'staros://music?pid=2&pt=playlist');
  assert.equal(deeplinkFor('artist', '3'), 'staros://music?pid=3&pt=artist');
  assert.equal(deeplinkFor('release', '4'), 'staros://music?pid=4&pt=release');
  assert.equal(deeplinkFor('podcast', '5'), 'staros://music?tid=5&pt=podcast');
  assert.equal(deeplinkFor('track', 'x'), null);
});

test('Zvuk: поиск объединяет REST и GraphQL, обложки и метаданные', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zvuk-test-'));
  const { calls, fetchImpl } = fakeZvukFetch();
  const client = new ZvukClient({ dataDir: dir, fetchImpl });

  try {
    const result = await client.search('кино', { limit: 3 });
    assert.equal(calls.profile, 1);
    assert.equal(calls.rest, 1);
    assert.equal(calls.graphql, 1);
    assert.equal(result.sections.tracks.length, 2);
    assert.equal(result.sections.tracks[0].title, 'Track A');
    assert.equal(result.sections.tracks[0].cover, 'https://cdn/x/600x600');
    assert.equal(result.sections.playlists[0].tracksNumber, 3);
    assert.equal(result.sections.playlists[0].cover, 'https://zvuk.com/static/p.png');
    assert.equal(result.sections.releases[0].id, '99');
    assert.equal(result.sections.artists[0].subtitle, 'Исполнитель');

    const tracks = await client.getTracks(['1', '1', '2']);
    assert.equal(tracks.length, 1);
    assert.equal(tracks[0].title, 'Track A');
    assert.deepEqual(tracks[0].artists, ['Artist A']);
    assert.equal(tracks[0].releaseId, '99');
    assert.equal(tracks[0].cover, 'https://zvuk.com/static/r.png');

    const playlist = await client.resolveId('77');
    assert.equal(playlist.kind, 'playlist');
    assert.equal(playlist.title, 'Playlist A');
    assert.equal(playlist.deeplink, 'staros://music?pid=77&pt=playlist');

    const byUrl = await client.resolveInput('https://zvuk.com/track/321');
    assert.equal(byUrl.kind, 'track');
    assert.equal(byUrl.deeplink, 'staros://music?tid=321&pt=track');

    // Один номер есть и в треках, и в плейлистах — просим полную ссылку.
    await assert.rejects(
      () => client.resolveInput('1'),
      (err) => {
        assert.ok(err instanceof ZvukError);
        assert.equal(err.status, 409);
        assert.match(err.message, /неоднозначен/i);
        assert.equal(err.candidates.length, 2);
        return true;
      },
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Zvuk: сессия переживает перезапуск, 401 обновляет токен', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zvuk-test-'));
  const fake = fakeZvukFetch({ token: 'token-1' });
  const first = new ZvukClient({ dataDir: dir, fetchImpl: fake.fetchImpl });

  try {
    await first.search('кино', { limit: 2 });
    assert.equal(fake.calls.profile, 1);

    const session = JSON.parse(await fs.readFile(path.join(dir, 'zvuk-session.json'), 'utf8'));
    assert.equal(session.token, 'token-1');
    assert.equal(session.cookies.spid, 'cookie-1');
    assert.equal((await fs.stat(path.join(dir, 'zvuk-session.json'))).mode & 0o777, 0o600);

    const second = new ZvukClient({ dataDir: dir, fetchImpl: fake.fetchImpl });
    await second.search('gspd', { limit: 2 });
    assert.equal(fake.calls.profile, 1, 'токен взят с диска, profile не запрашивался');

    fake.setToken('token-2');
    fake.failAuthOnce();
    await second.search('баста', { limit: 2 });
    assert.ok(fake.calls.profile >= 2, 'после 401 токен обновился');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Zvuk: при недоступности каталога ошибка не ломает приложение', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zvuk-test-'));
  const { fetchImpl } = fakeZvukFetch({ failSearch: true });
  const client = new ZvukClient({ dataDir: dir, fetchImpl });

  try {
    await assert.rejects(
      () => client.search('кино'),
      (err) => {
        assert.ok(err instanceof ZvukError);
        assert.match(err.message, /вставьте ссылку/i);
        assert.equal(err.status, 502);
        return true;
      },
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
