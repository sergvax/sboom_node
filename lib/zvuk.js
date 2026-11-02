/**
 * Клиент каталога Sber Звук для Node.js.
 *
 * Использует тот же публичный (недокументированный) API, что и веб-плеер:
 * анонимный токен из `/api/tiny/profile`, cookie-jar для anti-bot 307,
 * REST-поиск `/api/tiny/search` и GraphQL `/api/v1/graphql`.
 *
 * Задача клиента — не «заменить приложение Звука», а быстро получить ID
 * трека/плейлиста/альбома/исполнителя и собрать staros:// deeplink для
 * колонки. Если каталог недоступен, приложение продолжает работать по
 * ссылке или числовому ID — см. `resolveInput()`.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BASE = 'https://zvuk.com';
const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const SESSION_VERSION = 1;
const MAX_REDIRECTS = 10;

export const PLAY_KINDS = new Set(['track', 'playlist', 'artist', 'release', 'podcast']);

const KIND_LABEL = {
  track: 'Трек',
  playlist: 'Плейлист',
  artist: 'Исполнитель',
  release: 'Альбом',
  podcast: 'Подкаст',
};

const KIND_URL = {
  track: 'track',
  playlist: 'playlist',
  artist: 'artist',
  release: 'release',
  album: 'release',
  podcast: 'podcast',
  episode: 'podcast',
  book: 'podcast',
};

/** Ошибка каталога с HTTP-статусом, который можно отдать клиенту. */
export class ZvukError extends Error {
  constructor(message, { status = 502, code = null } = {}) {
    super(message);
    this.name = 'ZvukError';
    this.status = status;
    this.code = code;
  }
}

const delay = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

function asId(value) {
  if (value === undefined || value === null) return null;
  const s = String(value);
  return /^\d+$/.test(s) ? s : null;
}

function joinNames(items, key = 'title') {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => (item && typeof item === 'object' ? item[key] ?? item.name : item))
    .filter((name) => typeof name === 'string' && name.trim())
    .map((name) => name.trim());
}

/** Относительный /static/... → абсолютный URL, {size} → 600x600. */
export function normalizeCover(src) {
  if (!src || typeof src !== 'string') return null;
  let url = src.startsWith('/') ? `${DEFAULT_BASE}${src}` : src;
  url = url.replace('{size}', '600x600');
  return /^https?:\/\//i.test(url) ? url : null;
}

/**
 * Разбирает ссылку zvuk.com или числовой ID.
 * @param {string} raw
 * @returns {{kind: string|null, id: string}|null}
 */
export function parseZvukInput(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^\d{1,20}$/.test(s)) return { kind: null, id: s };

  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (!/^(www\.)?zvuk\.com$/i.test(url.hostname)) return null;

  const match = /^\/(track|playlist|artist|release|album|podcast|episode|book)\/(\d+)/i.exec(
    url.pathname,
  );
  if (!match) return null;
  return { kind: KIND_URL[match[1].toLowerCase()] || null, id: match[2] };
}

/** staros:// deeplink для запуска контента на колонке. */
export function deeplinkFor(kind, id) {
  const contentId = asId(id);
  const contentType = KIND_URL[String(kind || '').toLowerCase()] || null;
  if (!contentId || !contentType) return null;
  const param = contentType === 'track' || contentType === 'podcast' ? 'tid' : 'pid';
  return `staros://music?${param}=${contentId}&pt=${contentType}`;
}

function normalizeRestItem(kind, raw) {
  const id = asId(raw?.id);
  if (!id) return null;
  const item = {
    kind,
    id,
    title: raw?.title || raw?.name || null,
    subtitle: raw?.aname || null,
    cover: normalizeCover(raw?.image?.src || raw?.image),
    duration: Number(raw?.duration) > 0 ? Math.round(Number(raw.duration)) : null,
    explicit: Boolean(raw?.explicit),
    tracksNumber: null,
  };
  if (kind === 'playlist') {
    item.tracksNumber = Number.isFinite(Number(raw?.tracks_number))
      ? Number(raw.tracks_number)
      : null;
    item.subtitle = item.tracksNumber
      ? `${item.tracksNumber} ${pluralTracks(item.tracksNumber)}`
      : 'Плейлист';
  } else if (kind === 'artist') {
    item.subtitle = 'Исполнитель';
  } else if (kind === 'release') {
    item.subtitle = item.subtitle || 'Альбом';
  }
  return item;
}

function pluralTracks(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'трек';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'трека';
  return 'треков';
}

function normalizeRestSearch(search, limit) {
  const sections = { tracks: [], playlists: [], artists: [], releases: [] };
  const map = {
    tracks: 'track',
    playlists: 'playlist',
    artists: 'artist',
    releases: 'release',
  };
  for (const [key, kind] of Object.entries(map)) {
    const items = Array.isArray(search?.[key]?.items) ? search[key].items : [];
    sections[key] = items
      .slice(0, limit)
      .map((item) => normalizeRestItem(kind, item))
      .filter(Boolean);
  }
  const bestType = KIND_URL[String(search?.best_item?.doc_type || '').toLowerCase()] || null;
  const bestId = asId(search?.best_item?.id);
  return { sections, best: bestType && bestId ? { kind: bestType, id: bestId } : null };
}

const SEARCH_GRAPHQL = `
  query search($query: String, $limit: Int = 6) {
    search(query: $query) {
      tracks(limit: $limit) {
        items {
          id
          title
          duration
          explicit
          artists { id title }
          release { id title image { src } }
        }
      }
      playlists(limit: $limit) {
        items { id title image { src } }
      }
      artists(limit: $limit) {
        items { id title image { src } }
      }
      releases(limit: $limit) {
        items { id title image { src } artists { id title } }
      }
    }
  }
`;

function normalizeGraphqlSearch(data, limit) {
  const search = data?.search || {};
  const tracks = (search.tracks?.items || []).slice(0, limit).map((raw) => {
    const id = asId(raw?.id);
    if (!id) return null;
    const artists = joinNames(raw?.artists);
    return {
      kind: 'track',
      id,
      title: raw?.title || null,
      subtitle: artists.join(', ') || null,
      cover: normalizeCover(raw?.release?.image?.src),
      duration: Number(raw?.duration) > 0 ? Math.round(Number(raw.duration)) : null,
      explicit: Boolean(raw?.explicit),
      tracksNumber: null,
      album: raw?.release?.title || null,
    };
  });
  const playlists = (search.playlists?.items || []).slice(0, limit).map((raw) => {
    const id = asId(raw?.id);
    if (!id) return null;
    return {
      kind: 'playlist',
      id,
      title: raw?.title || null,
      subtitle: 'Плейлист',
      cover: normalizeCover(raw?.image?.src),
      duration: null,
      explicit: false,
      tracksNumber: null,
    };
  });
  const artists = (search.artists?.items || []).slice(0, limit).map((raw) => {
    const id = asId(raw?.id);
    if (!id) return null;
    return {
      kind: 'artist',
      id,
      title: raw?.title || null,
      subtitle: 'Исполнитель',
      cover: normalizeCover(raw?.image?.src),
      duration: null,
      explicit: false,
      tracksNumber: null,
    };
  });
  const releases = (search.releases?.items || []).slice(0, limit).map((raw) => {
    const id = asId(raw?.id);
    if (!id) return null;
    const names = joinNames(raw?.artists);
    return {
      kind: 'release',
      id,
      title: raw?.title || null,
      subtitle: names.join(', ') || 'Альбом',
      cover: normalizeCover(raw?.image?.src),
      duration: null,
      explicit: false,
      tracksNumber: null,
    };
  });
  return {
    sections: {
      tracks: tracks.filter(Boolean),
      playlists: playlists.filter(Boolean),
      artists: artists.filter(Boolean),
      releases: releases.filter(Boolean),
    },
    best: null,
  };
}

function mergeSearch(rest, graphql, limit) {
  const source = rest && graphql ? 'rest+graphql' : rest ? 'rest' : 'graphql';
  const base = rest?.sections || {};
  const extra = graphql?.sections || {};
  const sections = {};
  for (const key of ['tracks', 'playlists', 'artists', 'releases']) {
    const primary = Array.isArray(base[key]) ? base[key] : [];
    const fallback = Array.isArray(extra[key]) ? extra[key] : [];
    const order = primary.length ? primary : fallback;
    const byId = new Map();
    for (const item of fallback) byId.set(item.id, item);
    const merged = order.slice(0, limit).map((item) => {
      const other = byId.get(item.id);
      if (!other) return item;
      return {
        ...other,
        ...item,
        cover: item.cover || other.cover || null,
        subtitle: item.subtitle || other.subtitle || null,
        duration: item.duration ?? other.duration ?? null,
        tracksNumber: item.tracksNumber ?? other.tracksNumber ?? null,
      };
    });
    sections[key] = merged;
  }
  return { sections, best: rest?.best || graphql?.best || null, source };
}

class CookieJar {
  constructor(cookies = {}) {
    this.cookies = new Map(
      Object.entries(cookies || {}).filter(([name, value]) => name && typeof value === 'string'),
    );
  }

  header() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  absorb(headers) {
    let list = [];
    if (typeof headers?.getSetCookie === 'function') list = headers.getSetCookie();
    if (!list.length) {
      const combined = headers?.get?.('set-cookie');
      if (combined) list = combined.split(/,(?=\s*[A-Za-z0-9_\-]+=)/);
    }
    let changed = false;
    for (const raw of list) {
      if (!raw) continue;
      const pair = String(raw).split(';')[0];
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!name) continue;
      if (this.cookies.get(name) !== value) {
        this.cookies.set(name, value);
        changed = true;
      }
    }
    return changed;
  }

  toJSON() {
    return Object.fromEntries(this.cookies);
  }
}

export class ZvukClient {
  /**
   * @param {object} [opts]
   * @param {string} [opts.dataDir] каталог для data/zvuk-session.json
   * @param {string} [opts.sessionFile] полный путь к файлу сессии
   * @param {string} [opts.baseUrl]
   * @param {number} [opts.timeoutMs]
   * @param {Function} [opts.fetchImpl]
   */
  constructor({
    dataDir = path.join(__dirname, '..', 'data'),
    sessionFile = null,
    baseUrl = DEFAULT_BASE,
    timeoutMs = 9000,
    userAgent = DEFAULT_UA,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.userAgent = userAgent;
    this.fetchImpl = fetchImpl;
    this.sessionFile = sessionFile || path.join(dataDir, 'zvuk-session.json');

    this.token = null;
    this.jar = new CookieJar();
    this._sessionLoaded = false;
    this._loadPromise = null;
    this._tokenPromise = null;
    this._searchCache = new Map();
    this._trackCache = new Map();
    this._entityCache = new Map();
    this._searchTtlMs = 10 * 60 * 1000;
    this._metaTtlMs = 6 * 60 * 60 * 1000;
  }

  // ───────────────────────────── сессия ─────────────────────────────

  async _ensureSession() {
    if (this._sessionLoaded) return;
    if (!this._loadPromise) {
      this._loadPromise = (async () => {
        try {
          const raw = await fs.readFile(this.sessionFile, 'utf8');
          const data = JSON.parse(raw);
          if (data && typeof data === 'object') {
            if (typeof data.token === 'string' && data.token) this.token = data.token;
            if (data.cookies && typeof data.cookies === 'object') {
              this.jar = new CookieJar(data.cookies);
            }
          }
        } catch {
          /* сессии ещё нет или файл повреждён — получим заново */
        } finally {
          this._sessionLoaded = true;
        }
      })();
    }
    await this._loadPromise;
  }

  async _saveSession() {
    const payload = JSON.stringify(
      {
        version: SESSION_VERSION,
        token: this.token,
        cookies: this.jar.toJSON(),
        savedAt: Date.now(),
      },
      null,
      2,
    );
    const dir = path.dirname(this.sessionFile);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.sessionFile}.tmp`;
    await fs.writeFile(tmp, payload, { mode: 0o600 });
    await fs.rename(tmp, this.sessionFile);
    await fs.chmod(this.sessionFile, 0o600).catch(() => {});
  }

  async getToken({ force = false } = {}) {
    if (force) this.token = null;
    if (this.token) return this.token;
    if (this._tokenPromise) return this._tokenPromise;

    this._tokenPromise = (async () => {
      await this._ensureSession();
      if (this.token && !force) return this.token;

      const res = await this._fetchWithRedirects(`${this.baseUrl}/api/tiny/profile`, {
        headers: this._headers(),
      });
      if (!res.ok) {
        throw new ZvukError(`Не удалось получить токен Звука (HTTP ${res.status})`, {
          status: 502,
          code: 'token',
        });
      }
      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      const token = data?.result?.token;
      if (!token || typeof token !== 'string') {
        throw new ZvukError('Звук не выдал анонимный токен', { status: 502, code: 'token' });
      }
      this.token = token;
      await this._saveSession().catch(() => {});
      return token;
    })().finally(() => {
      this._tokenPromise = null;
    });

    return this._tokenPromise;
  }

  // ───────────────────────────── HTTP ─────────────────────────────

  _headers(extra = {}) {
    return {
      'User-Agent': this.userAgent,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.7',
      Referer: `${this.baseUrl}/`,
      ...extra,
    };
  }

  async _fetchWithRedirects(url, { method = 'GET', headers = {}, body = null } = {}) {
    let target = url;
    const visited = new Set();

    for (let i = 0; i < MAX_REDIRECTS; i++) {
      if (visited.has(target)) return new Response(null, { status: 307 });
      visited.add(target);

      const merged = this._headers(headers);
      const cookie = this.jar.header();
      if (cookie) merged.Cookie = cookie;

      let res;
      try {
        res = await this.fetchImpl(target, {
          method,
          headers: merged,
          body,
          redirect: 'manual',
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        const reason = err?.name === 'TimeoutError' ? 'таймаут' : err?.message || 'сеть';
        throw new ZvukError(`Каталог Звука недоступен (${reason})`, {
          status: 502,
          code: 'network',
        });
      }

      const changed = this.jar.absorb(res.headers);
      if (changed) await this._saveSession().catch(() => {});

      const location = res.headers.get?.('location');
      if (res.status >= 300 && res.status < 400 && location) {
        const next = new URL(location, target).href;
        if (next === target || visited.has(next)) return res;
        target = next;
        continue;
      }
      return res;
    }
    throw new ZvukError('Слишком много перенаправлений от Звука', {
      status: 502,
      code: 'redirect',
    });
  }

  async _fetchApi(url, { method = 'GET', headers = {}, body = null, auth = false, retries = 1 } = {}) {
    let token = auth ? await this.getToken() : null;
    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const extra = { ...headers };
        if (token) extra['X-Auth-Token'] = token;
        const res = await this._fetchWithRedirects(url, { method, headers: extra, body });

        if (auth && (res.status === 401 || res.status === 307) && attempt < retries) {
          token = await this.getToken({ force: true });
          continue;
        }
        if ([400, 408, 425, 429, 500, 502, 503, 504].includes(res.status) && attempt < retries) {
          await res.arrayBuffer().catch(() => {});
          await delay(res.status === 429 ? 900 : 300);
          continue;
        }
        return res;
      } catch (err) {
        lastError = err;
        if (attempt < retries) {
          await delay(300);
          continue;
        }
      }
    }
    throw lastError || new ZvukError('Каталог Звука недоступен', { status: 502 });
  }

  async _graphql(query, variables = {}) {
    const res = await this._fetchApi(`${this.baseUrl}/api/v1/graphql`, {
      method: 'POST',
      auth: true,
      retries: 1,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      throw new ZvukError(`Звук ответил HTTP ${res.status}`, {
        status: 502,
        code: 'graphql',
      });
    }
    if (data?.errors?.length) {
      throw new ZvukError(data.errors[0]?.message || 'Ошибка GraphQL Звука', {
        status: 502,
        code: 'graphql',
      });
    }
    return data?.data || null;
  }

  // ───────────────────────────── поиск ─────────────────────────────

  async _searchRest(query, limit) {
    const url = new URL('/api/tiny/search', this.baseUrl);
    url.searchParams.set('query', query);
    url.searchParams.set('type', 'track,playlist,artist,release');
    url.searchParams.set('limit', String(limit));

    const res = await this._fetchApi(url.href, { auth: true, retries: 1 });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      throw new ZvukError(`Поиск Звука ответил HTTP ${res.status}`, {
        status: 502,
        code: 'search',
      });
    }
    const search = data?.result?.search;
    if (!search) {
      throw new ZvukError('Поиск Звука вернул пустой ответ', { status: 502, code: 'search' });
    }
    return normalizeRestSearch(search, limit);
  }

  async _searchGraphql(query, limit) {
    const data = await this._graphql(SEARCH_GRAPHQL, { query, limit });
    return normalizeGraphqlSearch(data, limit);
  }

  /**
   * Поиск по каталогу. REST — основной канал, GraphQL — параллельный
   * запасной (даёт обложки и переживает часть сбоев REST).
   *
   * @param {string} query
   * @param {{limit?: number}} [opts]
   */
  async search(query, { limit = 6 } = {}) {
    const q = String(query ?? '').trim();
    if (!q) throw new ZvukError('Введите поисковый запрос', { status: 400 });
    if (q.length > 120) throw new ZvukError('Слишком длинный поисковый запрос', { status: 400 });

    const perSection = Math.max(1, Math.min(12, Number(limit) || 6));
    const key = `${q.toLowerCase()}::${perSection}`;
    const cached = this._searchCache.get(key);
    if (cached && cached.expires > Date.now()) {
      return { ...cached.value, cached: true };
    }

    let rest = null;
    let graphql = null;
    let restError = null;
    let graphqlError = null;
    const [restResult, graphqlResult] = await Promise.allSettled([
      this._searchRest(q, perSection),
      this._searchGraphql(q, perSection),
    ]);
    if (restResult.status === 'fulfilled') rest = restResult.value;
    else restError = restResult.reason;
    if (graphqlResult.status === 'fulfilled') graphql = graphqlResult.value;
    else graphqlError = graphqlResult.reason;

    if (!rest && !graphql) {
      if (cached?.value) {
        return { ...cached.value, cached: true, stale: true };
      }
      const err = restError || graphqlError;
      throw new ZvukError(
        'Поиск Звука временно недоступен. Вставьте ссылку zvuk.com или числовой ID.',
        {
          status: 502,
          code: 'search_unavailable',
          cause: err,
        },
      );
    }

    const merged = mergeSearch(rest, graphql, perSection);
    const value = {
      query: q,
      sections: merged.sections,
      best: merged.best,
      source: merged.source,
      cached: false,
      stale: false,
    };
    this._searchCache.set(key, { expires: Date.now() + this._searchTtlMs, value });
    return value;
  }

  // ─────────────────────── метаданные каталога ───────────────────────

  _cacheGet(map, key, ttl) {
    const entry = map.get(key);
    if (!entry) return null;
    return { value: entry.value, fresh: entry.at + ttl > Date.now() };
  }

  /** Названия, исполнители, обложки треков по ID (для очереди и поиска). */
  async getTracks(ids) {
    const list = [...new Set((Array.isArray(ids) ? ids : [ids]).map(asId).filter(Boolean))];
    if (!list.length) return [];

    const result = new Map();
    const missing = [];
    for (const id of list) {
      const hit = this._cacheGet(this._trackCache, id, this._metaTtlMs);
      if (hit?.fresh) result.set(id, hit.value);
      else missing.push(id);
    }

    if (missing.length) {
      const query = `
        query getTracks($ids: [ID!]!) {
          getTracks(ids: $ids) {
            id
            title
            duration
            explicit
            artists { id title image { src } }
            release { id title image { src } artists { id title } }
          }
        }
      `;
      let data;
      try {
        data = await this._graphql(query, { ids: missing });
      } catch (err) {
        // Отдаём устаревшие метаданные, если они есть, иначе ошибку.
        for (const id of missing) {
          const hit = this._cacheGet(this._trackCache, id, this._metaTtlMs);
          if (hit) result.set(id, hit.value);
        }
        if (result.size) return list.map((id) => result.get(id)).filter(Boolean);
        throw err;
      }

      const items = Array.isArray(data?.getTracks) ? data.getTracks : [];
      for (const raw of items) {
        const id = asId(raw?.id);
        if (!id) continue;
        const artists = joinNames(raw?.artists);
        const value = {
          id,
          title: raw?.title || null,
          artists,
          artistIds: (raw?.artists || []).map((a) => asId(a?.id)).filter(Boolean),
          album: raw?.release?.title || null,
          releaseId: asId(raw?.release?.id),
          cover: normalizeCover(raw?.release?.image?.src || raw?.artists?.[0]?.image?.src),
          duration: Number(raw?.duration) > 0 ? Math.round(Number(raw.duration)) : null,
          explicit: Boolean(raw?.explicit),
        };
        result.set(id, value);
        this._trackCache.set(id, { at: Date.now(), value });
      }
    }

    return list.map((id) => result.get(id)).filter(Boolean);
  }

  async _getEntities(kind, ids) {
    const query = {
      playlist: `query getPlaylists($ids: [ID!]!) {
        getPlaylists(ids: $ids) { id title image { src } tracks { id } duration }
      }`,
      artist: `query getArtists($ids: [ID!]!) {
        getArtists(ids: $ids) { id title image { src } }
      }`,
      release: `query getReleases($ids: [ID!]!) {
        getReleases(ids: $ids) { id title image { src } artists { id title } }
      }`,
    }[kind];
    if (!query) throw new ZvukError(`Неизвестный тип контента: ${kind}`, { status: 400 });

    const list = [...new Set((Array.isArray(ids) ? ids : [ids]).map(asId).filter(Boolean))];
    if (!list.length) return [];

    const result = new Map();
    const missing = [];
    for (const id of list) {
      const key = `${kind}:${id}`;
      const hit = this._cacheGet(this._entityCache, key, this._metaTtlMs);
      if (hit?.fresh) result.set(id, hit.value);
      else missing.push(id);
    }
    if (!missing.length) return list.map((id) => result.get(id)).filter(Boolean);

    const data = await this._graphql(query, { ids: missing });
    const field = kind === 'playlist' ? 'getPlaylists' : kind === 'artist' ? 'getArtists' : 'getReleases';
    const items = Array.isArray(data?.[field]) ? data[field] : [];
    for (const raw of items) {
      const id = asId(raw?.id);
      if (!id) continue;
      const value = {
        kind,
        id,
        title: raw?.title || null,
        cover: normalizeCover(raw?.image?.src),
      };
      if (kind === 'playlist') {
        value.tracksNumber = Array.isArray(raw?.tracks) ? raw.tracks.length : null;
        value.duration = Number(raw?.duration) > 0 ? Math.round(Number(raw.duration)) : null;
        value.subtitle = value.tracksNumber
          ? `${value.tracksNumber} ${pluralTracks(value.tracksNumber)}`
          : 'Плейлист';
      } else if (kind === 'artist') {
        value.subtitle = 'Исполнитель';
      } else {
        value.subtitle = joinNames(raw?.artists).join(', ') || 'Альбом';
      }
      result.set(id, value);
      this._entityCache.set(`${kind}:${id}`, { at: Date.now(), value });
    }
    return list.map((id) => result.get(id)).filter(Boolean);
  }

  getPlaylists(ids) {
    return this._getEntities('playlist', ids);
  }

  getArtists(ids) {
    return this._getEntities('artist', ids);
  }

  getReleases(ids) {
    return this._getEntities('release', ids);
  }

  // ─────────────────────────── resolve / link ───────────────────────────

  /**
   * Числовой ID без типа: проверяем трек → плейлист → исполнителя → альбом.
   * Работает, даже если поиск Звука сломан.
   */
  async resolveId(rawId) {
    const id = asId(rawId);
    if (!id) throw new ZvukError('ID должен состоять из цифр', { status: 400 });

    const jobs = [
      ['track', this.getTracks([id])],
      ['playlist', this.getPlaylists([id])],
      ['artist', this.getArtists([id])],
      ['release', this.getReleases([id])],
    ];
    const settled = await Promise.allSettled(jobs.map(([, p]) => p));
    let firstError = null;
    const matches = [];

    for (let i = 0; i < jobs.length; i++) {
      const [kind] = jobs[i];
      const result = settled[i];
      if (result.status === 'rejected') {
        firstError ||= result.reason;
        continue;
      }
      const item = result.value?.[0];
      if (!item) continue;
      matches.push({
        ...item,
        kind,
        id,
        deeplink: deeplinkFor(kind, id),
        label: KIND_LABEL[kind] || kind,
      });
    }

    if (matches.length === 1) return matches[0];

    // Пространства ID в Звуке пересекаются: один и тот же номер может быть
    // и треком, и плейлистом. Молча запускать первый попавшийся нельзя.
    if (matches.length > 1) {
      const variants = matches
        .map((item) => `${item.label.toLowerCase()} «${item.title || item.id}»`)
        .join(', ');
      const err = new ZvukError(
        `ID ${id} неоднозначен: это ${variants}. Вставьте полную ссылку zvuk.com.`,
        { status: 409, code: 'ambiguous' },
      );
      err.candidates = matches.map((item) => ({
        kind: item.kind,
        id: item.id,
        title: item.title,
        label: item.label,
      }));
      throw err;
    }

    if (firstError && settled.every((s) => s.status === 'rejected')) throw firstError;
    throw new ZvukError(`ID ${id} не найден в каталоге Звука`, { status: 404 });
  }

  /**
   * Ссылка zvuk.com или числовой ID → готовый deeplink.
   * @param {string} input
   */
  async resolveInput(input) {
    const parsed = parseZvukInput(input);
    if (!parsed) {
      throw new ZvukError(
        'Вставьте ссылку вида https://zvuk.com/track/123 или числовой ID',
        { status: 400 },
      );
    }
    if (parsed.kind) {
      const link = deeplinkFor(parsed.kind, parsed.id);
      if (!link) throw new ZvukError('Эту ссылку нельзя отправить на колонку', { status: 400 });
      return {
        kind: parsed.kind,
        id: parsed.id,
        title: null,
        subtitle: null,
        cover: null,
        deeplink: link,
        label: KIND_LABEL[parsed.kind] || parsed.kind,
      };
    }
    return this.resolveId(parsed.id);
  }
}

/** Человеческая подпись типа контента. */
export function kindLabel(kind) {
  return KIND_LABEL[kind] || 'Контент';
}
