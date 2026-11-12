/**
 * Чистые функции диагностики нативного мультирума.
 *
 * Здесь нет сети: только анализ уже собранных замеров. Это позволяет
 * тестировать логику без колонок и переиспользовать её в менеджере.
 */

/** @param {number[]} values @returns {number|null} */
export function median(values) {
  const list = (values || []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!list.length) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

/**
 * Перевод отметки позиции в локальное время контроллера.
 *
 * `timestamp` и `position.tsMs` приходят с одних часов устройства, поэтому
 * их разность (`age`) не зависит от расхождения часов между колонками.
 * `mid` — середина RTT запроса GetMetaData в локальном времени.
 * Устаревшие отметки (пауза, endless-радио) отбрасываются.
 *
 * @param {{val:number, tsMs:number}|null|undefined} position
 * @param {{timestamp:number, mid:number, maxAgeMs?:number}} opts
 * @returns {{val:number, ts:number, rawTs:number, age:number}|null}
 */
export function normalizePositionSample(position, { timestamp, mid, maxAgeMs = 5000 } = {}) {
  if (!position || !Number.isFinite(position.val) || !Number.isFinite(position.tsMs)) {
    return null;
  }
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  const age = timestamp - position.tsMs;
  if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) return null;
  return { val: position.val, ts: mid - age, rawTs: position.tsMs, age };
}

/**
 * Оценка рассинхрона по отметкам позиции.
 *
 * Каждая колонка отдаёт `{val, tsMs}`: значение позиции в секундах и
 * timestamp, когда это значение было установлено. `tsMs` — часы устройства,
 * поэтому перед сравнением менеджер переводит его в локальное время
 * контроллера (`ts`). Для одного и того же `val` разница `ts` между ведомой
 * и мастером — это насколько позже/раньше ведомая отсчитала ту же секунду.
 *
 * @param {Record<string, Array<{val:number, ts:number, rawTs?:number, trackId?:string|null}>>} byDevice
 * @param {{masterId?: string, minCommon?: number}} [opts]
 * @returns {{
 *   ok: boolean,
 *   reason?: string,
 *   masterId?: string,
 *   offsets?: Array<{id:string, offsetMs:number, samples:number, vals:number[]}>,
 *   verdict?: 'sync'|'noticeable'|'echo'|'unknown',
 * }}
 */
export function analyzePositionSamples(byDevice, { masterId = null, minCommon = 2 } = {}) {
  const ids = Object.keys(byDevice || {});
  if (ids.length < 2) {
    return { ok: false, reason: 'not-enough-devices' };
  }

  /** @type {Map<string, Map<number, number[]>>} */
  const perDevice = new Map();
  for (const id of ids) {
    const map = new Map();
    for (const s of byDevice[id] || []) {
      if (!s || !Number.isFinite(s.val) || !Number.isFinite(s.ts)) continue;
      const key = Math.round(s.val);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(s.ts);
    }
    perDevice.set(id, map);
  }

  const master =
    (masterId && perDevice.has(masterId) ? masterId : null) ||
    ids
      .slice()
      .sort((a, b) => (perDevice.get(b)?.size || 0) - (perDevice.get(a)?.size || 0))[0];
  const masterMap = perDevice.get(master);
  if (!masterMap || masterMap.size < 1) {
    return { ok: false, reason: 'no-position-data', masterId: master };
  }

  const offsets = [];
  for (const id of ids) {
    if (id === master) continue;
    const map = perDevice.get(id);
    if (!map) continue;
    const diffs = [];
    const vals = [];
    for (const [val, stamps] of masterMap) {
      const other = map.get(val);
      if (!other) continue;
      const a = median(stamps);
      const b = median(other);
      if (a === null || b === null) continue;
      diffs.push(b - a);
      vals.push(val);
    }
    if (diffs.length < minCommon) continue;
    offsets.push({
      id,
      offsetMs: Math.round(median(diffs)),
      samples: diffs.length,
      vals: vals.sort((a, b) => a - b),
    });
  }

  if (!offsets.length) {
    return { ok: false, reason: 'not-enough-common-positions', masterId: master };
  }

  const worst = Math.max(...offsets.map((o) => Math.abs(o.offsetMs)), 0);
  return {
    ok: true,
    masterId: master,
    offsets,
    worstMs: worst,
    verdict: verdictForOffset(worst),
  };
}

/**
 * @param {number|null|undefined} ms
 * @returns {'sync'|'noticeable'|'echo'|'unknown'}
 */
export function verdictForOffset(ms) {
  if (!Number.isFinite(ms)) return 'unknown';
  const abs = Math.abs(Number(ms));
  if (abs <= 10) return 'sync';
  if (abs <= 30) return 'noticeable';
  return 'echo';
}

/** Человеческая подпись вердикта. */
export function verdictLabel(verdict) {
  switch (verdict) {
    case 'sync':
      return 'синхронно (≤ 10 мс)';
    case 'noticeable':
      return 'заметно на слух (10–30 мс)';
    case 'echo':
      return 'слышимое эхо (> 30 мс)';
    default:
      return 'недостаточно данных';
  }
}

/** Предпочтение модели: полноразмерная колонка стабильнее портала. */
const PRODUCT_SCORE = [
  [/sberboom(?!-mini)/i, 40],
  [/sberboom-mini/i, 30],
  [/sberboom/i, 25],
  [/stargate|portal/i, 15],
];

/**
 * Рекомендуемый мастер: играющая колонка с лучшим RTT и свежей метадатой.
 * RTT — не аудиозадержка, но хороший прокси качества Wi-Fi-канала.
 *
 * @param {Array<object>} rows результат `manager.diagnostics()`
 * @returns {{id:string, name:string, score:number, reason:string}|null}
 */
export function pickRecommendedMaster(rows) {
  const candidates = (rows || []).filter((r) => r.status === 'connected');
  if (!candidates.length) return null;

  const scored = candidates.map((r) => {
    const product = String(r.product || '');
    const model = PRODUCT_SCORE.find(([re]) => re.test(product))?.[1] || 0;
    const rtt = Number.isFinite(r.rttMs) ? r.rttMs : 500;
    const udp = Number.isFinite(r.udpProtocolVersion) ? r.udpProtocolVersion : 0;
    const freshness = Number.isFinite(r.stateAgeMs) ? Math.min(r.stateAgeMs, 5000) : 5000;
    const score = model + Math.max(0, 60 - rtt) + udp * 2 - freshness / 1000;
    return { row: r, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const rttText = Number.isFinite(best.row.rttMs) ? `${Math.round(best.row.rttMs)} мс` : '—';
  const state = best.row.playing ? 'играет' : 'не играет — включите трек на ней';
  return {
    id: best.row.id,
    name: best.row.name,
    score: Math.round(best.score),
    playing: Boolean(best.row.playing),
    reason: `${state}, RTT ${rttText}, UDP v${best.row.udpProtocolVersion ?? '—'}`,
  };
}
