/** Простое JSON-хранилище конфигурации (без БД). */
import fs from 'node:fs/promises';
import path from 'node:path';

export class Store {
  constructor(file) {
    this.file = file;
    this.data = { speakers: [] };
  }

  async load() {
    try {
      const txt = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(txt);
      if (parsed && Array.isArray(parsed.speakers)) this.data = parsed;
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`[store] не удалось прочитать ${this.file}:`, err.message);
      await this.save().catch(() => {});
    }
    return this.data;
  }

  async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmp, this.file);
    // Токены — чувствительные данные: файл доступен только владельцу.
    await fs.chmod(this.file, 0o600).catch(() => {});
  }
}
