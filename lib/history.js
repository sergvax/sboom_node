/**
 * История запусков из поиска Звука.
 *
 * Хранит только то, что пользователь сам нашёл и запустил, — без радио,
 * автозапусков и треков из очереди. Этого достаточно, чтобы предлагать
 * недавние и часто запускаемые треки, не превращаясь в полноценный
 * «историю прослушиваний» аккаунта.
 *
 * Формат файла: { version, items: [{ kind, id, title, subtitle, cover,
 * duration, count, firstAt, lastAt }] }.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const VERSION = 1;
const DEFAULT_MAX_ITEMS = 200;
const ALLOWED_KINDS = new Set(['track', 'playlist', 'artist', 'release', 'podcast']);

function cleanText(value, maxLength = 300) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  return text.slice(0, maxLength);
}

function cleanCover(value) {
  const text = cleanText(value, 800);
  if (!text) return null;
  return /^https?:\/\//i.test(text) ? text : null;
}

function cleanDuration(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

function asId(value) {
  const text = String(value ?? '').trim();
  return /^\d{1,20}$/.test(text) ? text : null;
}

export class SearchHistory {
  /**
   * @param {object} opts
   * @param {string} opts.file полный путь к JSON-файлу
   * @param {number} [opts.maxItems]
   */
  constructor({ file, maxItems = DEFAULT_MAX_ITEMS } = {}) {
    if (!file) throw new Error('SearchHistory: не указан file');
    this.file = file;
    this.maxItems = Math.max(10, Math.min(1000, Number(maxItems) || DEFAULT_MAX_ITEMS));
    this._loaded = null;
    this._items = [];
    this._queue = Promise.resolve();
  }

  async _ensureLoaded() {
    if (!this._loaded) {
      this._loaded = (async () => {
        try {
          const raw = await fs.readFile(this.file, 'utf8');
          const data = JSON.parse(raw);
          const items = Array.isArray(data?.items) ? data.items : [];
          this._items = items
            .map((item) => this._normalize(item))
            .filter(Boolean)
            .slice(0, this.maxItems);
        } catch {
          this._items = [];
        }
      })();
    }
    return this._loaded;
  }

  _normalize(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const kind = String(raw.kind || '').toLowerCase();
    const id = asId(raw.id);
    if (!ALLOWED_KINDS.has(kind) || !id) return null;
    const count = Math.max(1, Math.floor(Number(raw.count) || 1));
    const firstAt = Number(raw.firstAt) || Date.now();
    const lastAt = Number(raw.lastAt) || firstAt;
    return {
      kind,
      id,
      title: cleanText(raw.title),
      subtitle: cleanText(raw.subtitle),
      cover: cleanCover(raw.cover),
      duration: cleanDuration(raw.duration),
      count,
      firstAt,
      lastAt,
    };
  }

  async _save() {
    const payload = JSON.stringify({ version: VERSION, items: this._items }, null, 2);
    const dir = path.dirname(this.file);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, payload, { mode: 0o600 });
    await fs.rename(tmp, this.file);
    await fs.chmod(this.file, 0o600).catch(() => {});
  }

  /** Сериализует записи, чтобы параллельные запуски не теряли счётчики. */
  _serial(work) {
    const run = this._queue.then(work, work);
    this._queue = run.catch(() => {});
    return run;
  }

  /**
   * Записать запуск. Для существующего элемента увеличивает count и
   * обновляет lastAt, для нового — создаёт запись.
   *
   * @param {{kind: string, id: string|number, title?: string, subtitle?: string,
   *          cover?: string, duration?: number|string}} item
   */
  async record(item) {
    return this._serial(async () => {
      await this._ensureLoaded();
      const normalized = this._normalize({ ...item, count: 1, firstAt: Date.now(), lastAt: Date.now() });
      if (!normalized) return null;

      const now = Date.now();
      const existing = this._items.find(
        (entry) => entry.kind === normalized.kind && entry.id === normalized.id,
      );
      if (existing) {
        existing.count += 1;
        existing.lastAt = now;
        existing.title = normalized.title || existing.title;
        existing.subtitle = normalized.subtitle || existing.subtitle;
        existing.cover = normalized.cover || existing.cover;
        existing.duration = normalized.duration ?? existing.duration;
      } else {
        this._items.push({ ...normalized, firstAt: now, lastAt: now });
      }

      this._items.sort((a, b) => b.lastAt - a.lastAt);
      if (this._items.length > this.maxItems) {
        // Сначала выбрасываем давно не запускавшееся с малым счётчиком.
        this._items.sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
        this._items = this._items.slice(0, this.maxItems);
        this._items.sort((a, b) => b.lastAt - a.lastAt);
      }
      await this._save();
      const saved = this._items.find(
        (entry) => entry.kind === normalized.kind && entry.id === normalized.id,
      );
      return this._public(saved);
    });
  }

  /**
   * Список истории, сначала недавние.
   * @param {{limit?: number}} [opts]
   */
  async list({ limit = 30 } = {}) {
    await this._ensureLoaded();
    const count = Math.max(1, Math.min(this.maxItems, Number(limit) || 30));
    return this._items
      .slice()
      .sort((a, b) => b.lastAt - a.lastAt)
      .slice(0, count)
      .map((item) => this._public(item));
  }

  async clear() {
    return this._serial(async () => {
      await this._ensureLoaded();
      this._items = [];
      await this._save();
    });
  }

  _public(item) {
    if (!item) return null;
    return {
      kind: item.kind,
      id: item.id,
      title: item.title,
      subtitle: item.subtitle,
      cover: item.cover,
      duration: item.duration,
      count: item.count,
      firstAt: item.firstAt,
      lastAt: item.lastAt,
    };
  }
}
