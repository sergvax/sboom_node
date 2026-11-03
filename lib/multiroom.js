/**
 * Мультирум без облака: колонки играют один трек Звука, синхронно стартуют
 * (mute → deeplink → seek на секунду источника) и периодически выравниваются.
 *
 * Нативный мультирум Сбера требует SberCast/PTP-группу из облака, поэтому
 * локально он не поднимается — здесь синхронизация «программная».
 *
 * Ключевые решения после рефакторинга:
 *  - один источник истины для позиции: SpeakerRuntime.measure() с коротким
 *    кэшем (одна колонка не опрашивается 8 раз за замер фазы);
 *  - монитор работает по дедлайну, а не setInterval: выравнивание длиннее
 *    интервала не накладывается само на себя;
 *  - расхождение считается по фазе (переходы целых секунд), а не по одному
 *    замеру — это снимает ложные срабатывания ±0.5 c;
 *  - mute-состояние, которое мы сами поставили, всегда снимается: есть
 *    реестр _joinMuted и один общий cleanup;
 *  - next/prev ведёт источник, ведомые перелинкуются ровно один раз
 *    (перехват по msgId), а не через «подождём и посмотрим».
 */

import { MEDIA_CMD } from './protocol.js';

const SYNC_INTERVAL_MS = 4000;
const SYNC_TOLERANCE_MS = 1500; // порог грубой сверки (до точной фазы)
const SYNC_FINE_MS = 180;       // цель точной подстройки по фазе
const JOIN_TIMEOUT_MS = 12_000;
const PHASE_SAMPLES = 6;
const PHASE_INTERVAL_MS = 250;
const MISMATCH_CONFIRM_TICKS = 3;
const NEXT_DEADLINE_MS = 6000;
const MEASURE_CACHE_MS = 150;

/** Команды, которые в мультируме ведёт источник, а не отдельная колонка. */
export const MULTIROOM_PROPAGATE = new Set([
  'play',
  'pause',
  'playpause',
  'next',
  'prev',
  'seek',
  'shuffle',
  'repeat',
  'like',
  'unlike',
  'dislike',
]);

const sleep = (ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

/** deeplink для запуска конкретного трека Звука (проверено на прошивке 1.104). */
function deeplinkForTrack(trackId) {
  const id = String(trackId ?? '');
  if (!/^\d+$/.test(id)) return null;
  return `staros://music?tid=${id}&pt=track`;
}

/**
 * Фаза воспроизведения по моментам смены целой секунды.
 * Точка отсчёта — последний переход: xAtPos = когда плеер был на позиции pos
 * (мс от tRef). Регрессия по округлённым секундам смещена, если переход один
 * и он у края окна, поэтому считаем именно переходы.
 */
function fitPhase(points) {
  if (!points.length) return null;
  const transitions = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (b.p - a.p === 1 && b.x - a.x <= 700) {
      transitions.push({ x: a.x + (b.x - a.x) / 2, p: a.p + (b.p - a.p) / 2 });
    }
  }
  if (!transitions.length) {
    // Прошивка отдаёт позицию целыми секундами, и на коротком окне перехода
    // может не оказаться. Одного замера достаточно: скорость 1x, ошибка
    // ±0.5 c потом уточняется.
    const last = points[points.length - 1];
    return { pos: last.p, xAtPos: last.x, samples: points.length, coarse: true };
  }
  const last = transitions[transitions.length - 1];
  let sum = 0;
  for (const tr of transitions) sum += tr.x - (tr.p - last.p) * 1000;
  return { pos: last.p, xAtPos: sum / transitions.length, samples: points.length };
}

/** Момент (по часам хоста), когда плеер будет на позиции p. */
function timeAt(fit, p) {
  return fit.tRef + fit.xAtPos + (p - fit.pos) * 1000;
}

/** Позиция плеера в момент t. */
function posAt(fit, t) {
  return fit.pos + (t - fit.tRef - fit.xAtPos) / 1000;
}

export class MultiroomController {
  constructor(manager) {
    this.m = manager;
    this.active = false;
    this.busy = false;
    this.state = 'idle'; // idle | starting | active | stopping | error
    this.sourceId = null;
    this.memberIds = [];

    this.message = null;
    this._deadlineTimer = null;
    this._pausedTicks = 0;
    this._linking = new Set();
    this._srcTrackId = null;
    this._mismatch = new Map();
    this._joinMuted = new Map(); // id → была ли колонка в mute до присоединения
    this._latency = new Map();   // id → измеренная задержка seek, мс
    this._tickRunning = false;
    this._nextTickAt = 0;
    this._lastAlign = 0;
  }

  snapshot() {
    return {
      active: this.active,
      state: this.state,
      sourceId: this.sourceId,
      memberIds: [...this.memberIds],
      message: this.message,
      lastAlignAt: this._lastAlign || null,
    };
  }

  // ───────────────────────────── topology ─────────────────────────────

  /** Все участники группы, которые сейчас в сети. */
  _members() {
    return this.memberIds.map((id) => this.m.runtimes.get(id)).filter(Boolean);
  }

  /** Ведомые колонки, которые сейчас в сети. */
  _followers() {
    return this.memberIds
      .filter((id) => id !== this.sourceId)
      .map((id) => this.m.runtimes.get(id))
      .filter((r) => r && r.status === 'connected' && r.client?.connected);
  }

  /** Мультирум работает или ещё запускается (в этом состоянии можно двигать колонки). */
  _running() {
    return this.active || this.state === 'starting';
  }

  _set(patch) {
    Object.assign(this, patch);
    this.m.notify();
  }

  // ───────────────────────────── mute guard ─────────────────────────────

  /**
   * Заглушить ведомую на время присоединения.
   *
   * Deeplink запускает трек с нуля, и ранний pause прошивка часто теряет.
   * Mute переживает deeplink (проверено на SberBoom/Mini), поэтому звук
   * появляется только после seek на секунду источника.
   */
  async _muteForJoin(runtime) {
    if (this._joinMuted.has(runtime.cfg.id)) return;
    const wasMuted = Boolean(runtime.muted);
    this._joinMuted.set(runtime.cfg.id, wasMuted);
    if (wasMuted) return;
    runtime.muted = true;
    await runtime.client?.mute().catch(() => {});
  }

  /** Снять mute, если колонку заглушили мы, а не пользователь. */
  async _unmuteAfterJoin(runtime) {
    if (!this._joinMuted.has(runtime.cfg.id)) return;
    const wasMuted = this._joinMuted.get(runtime.cfg.id);
    this._joinMuted.delete(runtime.cfg.id);
    if (wasMuted) return;
    runtime.muted = false;
    await runtime.client?.unmute().catch(() => {});
  }

  async _unmuteAllForJoin() {
    const ids = [...this._joinMuted.keys()];
    await Promise.all(
      ids.map((id) => {
        const runtime = this.m.runtimes.get(id);
        return runtime ? this._unmuteAfterJoin(runtime) : null;
      }),
    );
  }

  /** Колонка выпала из группы: вернуть ей звук, если глушили мы. */
  async _releaseSpeaker(runtime) {
    if (!runtime) return;
    await this._unmuteAfterJoin(runtime);
    await runtime.client?.pause().catch(() => {});
  }

  // ───────────────────────────── start / stop ─────────────────────────────

  async start(sourceId) {
    if (this.busy) throw new Error('Мультирум уже запускается');
    if (this.active) throw new Error('Мультирум уже включён');

    const source = this.m.get(sourceId);
    if (!source?.client?.connected) throw new Error('Колонка-источник не в сети');

    // Свежий срез: трек мог смениться, а push ещё не пришёл.
    const fresh = await source.pollNow().catch(() => null);
    const srcTrack = source.track;
    const trackId = fresh?.trackId || srcTrack?.track_id;
    if (!trackId) {
      throw new Error('Мультирум доступен для музыки Звука — включите трек или волну.');
    }
    if (srcTrack?.media_source && srcTrack.media_source !== 'MUSIC') {
      throw new Error(
        'Мультирум доступен только для музыки Звука — радио и Bluetooth не переносятся.',
      );
    }
    const link = deeplinkForTrack(trackId);
    if (!link) throw new Error('Не удалось определить трек для мультирума');

    const targets = [...this.m.runtimes.values()].filter(
      (r) => r.cfg.id !== sourceId && r.status === 'connected' && r.client?.connected,
    );
    if (!targets.length) throw new Error('Нет других колонок в сети');

    this.busy = true;
    this._set({
      state: 'starting',
      message: `Запускаем и выравниваем на ${targets.length} ${
        targets.length === 1 ? 'колонке' : 'колонках'
      }…`,
      sourceId,
      memberIds: [sourceId],
    });

    const joined = [];
    const failed = [];
    let ready = [];
    let pending = [];

    try {
      // Ведомые глушим до deeplink: трек загрузится и заиграет с нуля,
      // но звука не будет, пока не выставим секунду источника.
      await Promise.all(
        targets.map(async (t) => {
          try {
            await this._muteForJoin(t);
            const { ok } = await t.client.playDeeplink(link);
            if (!ok) throw new Error('колонка отклонила запуск');
            joined.push(t);
          } catch (err) {
            await this._releaseSpeaker(t);
            failed.push(`${t.cfg.name}: ${err?.message || 'ошибка'}`);
          }
        }),
      );
      if (!joined.length) throw new Error('Не удалось запустить трек ни на одной колонке');

      // Ждём не просто trackId, а реально поехавшую позицию: seek,
      // отправленный во время буферизации, прошивка молча проглатывает.
      await Promise.all(
        joined.map(async (t) => {
          const view = await this._awaitPlaying(t, { trackId, timeout: JOIN_TIMEOUT_MS });
          if (view) ready.push(t);
          else pending.push(t);
        }),
      );
      if (!ready.length) throw new Error('Колонки не смогли загрузить трек');

      // Неуспевшие остаются в группе и в mute: монитор дотянет их позже.
      this.memberIds = [sourceId, ...joined.map((t) => t.cfg.id)];
      const srcPlaying = fresh ? Boolean(fresh.playing || fresh.buffering) : Boolean(srcTrack?.playing);

      if (srcPlaying) {
        // Источник не трогаем: он продолжает играть, ведомые догоняют его
        // seek'ом на играющем плеере — это единственный надёжный путь.
        await Promise.allSettled(ready.map((f) => this._alignFollowerLive(f, source)));
        const aligned = await this._seekAll(source, ready);
        const alignedIds = new Set(aligned.map((r) => r.cfg.id));
        for (const f of ready) {
          if (f.cfg.id !== sourceId && alignedIds.has(f.cfg.id)) {
            await this._unmuteAfterJoin(f);
          }
        }
        pending = pending.concat(ready.filter((f) => !alignedIds.has(f.cfg.id)));
      } else {
        await this._syncPaused();
        await Promise.all(ready.map((f) => this._unmuteAfterJoin(f)));
      }

      this.active = true;
      this.state = 'active';
      const notes = [];
      if (failed.length) notes.push(`Пропущены: ${failed.join('; ')}`);
      if (pending.length) {
        notes.push(`Подключается: ${pending.map((t) => t.cfg.name).join(', ')}`);
      }
      this.message = notes.length ? notes.join('; ') : null;
      this._startMonitor();
      console.log(
        new Date().toISOString().slice(11, 19),
        `[мультирум] источник ${source.cfg.name}, участников ${this.memberIds.length}`,
      );
      return this.snapshot();
    } catch (err) {
      await Promise.allSettled(targets.map((t) => t.client?.pause()));
      await this._unmuteAllForJoin();
      if (srcPlaying) await source.client?.play().catch(() => {});
      this.active = false;
      this.sourceId = null;
      this.memberIds = [];
      this.state = 'error';
      this.message = err?.message || 'Не удалось включить мультирум';
      throw err;
    } finally {
      this.busy = false;
      this.m.notify();
    }
  }

  async stop({ pause = true, reason = null } = {}) {
    if (!this.active && this.state !== 'error') return this.snapshot();
    this.busy = true;
    this.state = 'stopping';
    this.m.notify();
    this._stopMonitor();
    const members = this._members();

    // Снимаем свой mute до паузы: иначе «заглушенная» колонка останется
    // молчащей и после выхода из мультирума.
    await this._unmuteAllForJoin();
    if (pause) await Promise.allSettled(members.map((r) => r.client?.pause()));

    this.active = false;
    this.memberIds = [];
    this.sourceId = null;
    this.state = 'idle';
    this.message = reason;
    this._pausedTicks = 0;
    this._srcTrackId = null;
    this._mismatch.clear();
    this._latency.clear();
    this.busy = false;
    console.log(new Date().toISOString().slice(11, 19), `[мультирум] остановлен${reason ? `: ${reason}` : ''}`);
    this.m.notify();
    return this.snapshot();
  }

  /** Выход одной колонки из группы. */
  async leave(id) {
    if (!this.active) throw new Error('Мультирум не включён');
    if (id === this.sourceId) return this.stop({ pause: true });
    const runtime = this.m.runtimes.get(id);
    if (!runtime) throw new Error('Колонка не найдена');
    this.memberIds = this.memberIds.filter((x) => x !== id);
    await this._releaseSpeaker(runtime);
    this._mismatch.delete(id);
    this._latency.delete(id);
    if (!this._followers().length) {
      return this.stop({ pause: false, reason: 'В мультируме не осталось колонок' });
    }
    this.m.notify();
    return this.snapshot();
  }

  /** Колонку удалили из приложения. */
  async forget(id) {
    if (!this.active) return;
    if (id === this.sourceId) {
      await this.stop({ pause: true });
      return;
    }
    await this._releaseSpeaker(this.m.runtimes.get(id));
    this.memberIds = this.memberIds.filter((x) => x !== id);
    this._mismatch.delete(id);
    this._latency.delete(id);
    this.m.notify();
  }

  // ───────────────────────────── measurement ─────────────────────────────

  /**
   * Фаза источника (без ведомых). Пара попыток — замер иногда срывается.
   */
  async _sourcePhase(source) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const fits = await this._measurePhase([source], { samples: 10 });
      const fit = fits.get(source.cfg.id);
      if (fit) return fit;
      if (attempt === 0) await sleep(300);
    }
    return null;
  }

  /**
   * Фаза воспроизведения: опрашиваем колонки параллельно и ловим моменты
   * смены целой секунды. Точность ~20–40 мс против ±0.5 c у одного замера.
   */
  async _measurePhase(runtimes, { samples = PHASE_SAMPLES, interval = PHASE_INTERVAL_MS } = {}) {
    const tRef = Date.now();
    const series = new Map(runtimes.map((r) => [r.cfg.id, []]));
    for (let i = 0; i < samples; i++) {
      const views = await Promise.all(runtimes.map((r) => r.measure().catch(() => null)));
      views.forEach((v, idx) => {
        if (v && v.playing && v.position !== null) {
          series.get(runtimes[idx].cfg.id).push({ x: v.at - tRef, p: v.position });
        }
      });
      if (i < samples - 1) await sleep(interval);
    }
    const fits = new Map();
    for (const [id, points] of series) {
      const fit = fitPhase(points);
      if (fit) fits.set(id, { ...fit, tRef });
    }
    return fits;
  }

  /** На сколько миллисекунд ведомая отстаёт от источника (плюс = отстаёт). */
  _phaseOffsetMs(srcFit, fit, position) {
    return timeAt(fit, position) - timeAt(srcFit, position);
  }

  /**
   * Ждём, пока колонка реально заиграет: недостаточно `playing:true`,
   * позиция должна вырасти между двумя замерами. Иначе seek во время
   * буферизации прошивка молча выбрасывает.
   */
  async _awaitPlaying(runtime, { trackId = null, timeout = 15_000 } = {}) {
    const deadline = Date.now() + timeout;
    let stable = null;
    let lastPlay = 0;
    while (Date.now() < deadline) {
      if (!this._running()) return null;
      const v = await runtime.measure().catch(() => null);
      if (trackId !== null && v?.trackId !== String(trackId)) {
        stable = null;
      } else if (v?.playing && !v.pending && v.position !== null) {
        if (stable && v.position > stable.position) return v;
        if (!stable || v.position !== stable.position) stable = v;
      } else {
        stable = null;
        if (v && !v.playing && Date.now() - lastPlay >= 1500) {
          lastPlay = Date.now();
          await runtime.client?.play().catch(() => {});
        }
      }
      await sleep(350);
    }
    return null;
  }

  /** Ждём, пока пауза реально применится (иначе seek проигнорируется). */
  async _waitPaused(runtime, { timeout = 3000 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const v = await runtime.measure().catch(() => null);
      if (v && !v.playing) return true;
      await sleep(120);
    }
    return false;
  }

  /** Держим колонку на паузе, пока она не перестанет играть. */
  async _holdPaused(runtime, { timeout = 3000 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const view = await runtime.measure().catch(() => null);
      if (view && !view.playing && view.position !== null) return true;
      if (view?.playing) await runtime.client?.pause().catch(() => {});
      await sleep(120);
    }
    return false;
  }

  /**
   * Ждём, пока seek применится. Прошивка отдаёт целые секунды и может
   * показать соседнюю — допускаем ±1 c, точную фазу добирает общий seek.
   */
  async _waitPosition(runtime, target, { timeout = 5000, tolerance = 1 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const v = await runtime.measure().catch(() => null);
      if (v && v.position !== null && Math.abs(v.position - target) <= tolerance) return v;
      await sleep(80);
    }
    return null;
  }

  /** Поставить стоящую колонку на нужную секунду (с повторами). */
  async _seekPaused(runtime, target) {
    for (let attempt = 0; attempt < 6; attempt++) {
      if (!this._running()) return false;
      await runtime.client?.seek(target).catch(() => {});
      if (await this._waitPosition(runtime, target, { timeout: 1200 })) return true;
      await this._holdPaused(runtime, { timeout: 800 });
      await sleep(200);
    }
    return false;
  }

  /**
   * Точный seek: позиция задаётся целой секундой, поэтому «дробную» часть
   * выбираем моментом отправки — команда должна прийти, когда источник
   * окажется ровно на этой секунде.
   */
  async _timedSeek(runtime, srcFit, latencyMs) {
    if (!this._running()) return { target: null, sentAt: null, appliedAt: null, skipped: true };

    // seek применяется только на стоящем плеере (на играющем колонка его
    // игнорирует), причём после seek воспроизведение возобновляется само.
    await runtime.client?.pause().catch(() => {});
    await this._waitPaused(runtime);

    for (let attempt = 0; attempt < 4; attempt++) {
      if (!this._running()) return { target: null, sentAt: null, appliedAt: null, skipped: true };

      const view = await runtime.measure().catch(() => null);
      const duration = view?.duration ?? null;

      // Пересчитываем на каждой попытке: пока шла буферизация, источник
      // успел уйти вперёд.
      const now = Date.now() + 120;
      let target = Math.ceil(posAt(srcFit, now) + 1.6);
      let sendAt = timeAt(srcFit, target) - latencyMs;
      while (sendAt < now) {
        target += 1;
        sendAt = timeAt(srcFit, target) - latencyMs;
      }

      // Трек короче нужной секунды — догнать не получится. Просто продолжаем
      // играть: монитор перезапустит трек/выровняет на следующем цикле.
      if (duration && target > duration - 1) {
        await runtime.client?.play().catch(() => {});
        return { target, sentAt: null, appliedAt: null, skipped: true };
      }

      const wait = sendAt - Date.now();
      if (wait > 0) await sleep(wait);
      const sentAt = Date.now();
      console.log(new Date().toISOString().slice(11, 19), `[мультирум] ${runtime.cfg.name}: seek → ${target} c`);
      await runtime.client?.seek(target).catch(() => {});
      const hit = await this._waitPosition(runtime, target, { timeout: 1500 });
      if (hit) {
        await runtime.client?.play().catch(() => {});
        return { target, sentAt, appliedAt: hit.at };
      }

      // Колонка ещё не прогрузила трек и молча проглотила seek — повторяем
      // после короткой паузы, не выпуская её играть с нуля.
      await runtime.client?.pause().catch(() => {});
      await this._waitPaused(runtime, { timeout: 1200 });
      await sleep(300);
    }

    // Не получилось — хотя бы не оставляем колонку молчащей.
    await runtime.client?.play().catch(() => {});
    return { target: null, sentAt: null, appliedAt: null };
  }

  /** Догнать живой источник seek'ом на играющей ведомой. */
  async _alignFollowerLive(follower, source, { attempts = 3 } = {}) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (!this._running()) return false;
      const sv = await source.measure().catch(() => null);
      if (!sv || sv.position === null || !sv.playing) return false;

      // На чужом треке seek бессмысленен — им занимается _relink.
      let fv0 = await follower.measure().catch(() => null);
      if (!fv0 || (sv.trackId && fv0.trackId !== sv.trackId)) return false;

      // Seek на паузе прошивка применяет с задержкой и сама запускает
      // playback — надёжнее сначала дать колонке играть.
      if (!fv0.playing) {
        await follower.client?.play().catch(() => {});
        fv0 = await this._awaitPlaying(follower, { trackId: sv.trackId, timeout: 3000 });
        if (!fv0) continue;
      }

      const now = Date.now();
      const target = Math.round(sv.position + Math.max(0, (now - sv.at) / 1000));
      await follower.client?.seek(target).catch(() => {});
      await sleep(400);

      let fv = await follower.measure().catch(() => null);
      if (!fv?.playing) {
        await follower.client?.play().catch(() => {});
        fv = await this._awaitPlaying(follower, { trackId: sv.trackId, timeout: 4000 });
      }
      const sv2 = await source.measure().catch(() => null);
      if (!fv || !sv2 || fv.position === null || sv2.position === null) continue;

      const t = Date.now();
      const drift = (fv.position + (t - fv.at) / 1000) - (sv2.position + (t - sv2.at) / 1000);
      console.log(
        new Date().toISOString().slice(11, 19),
        `[мультирум] ${follower.cfg.name}: seek → ${target} c, расхождение ${Math.round(drift * 1000)} мс`,
      );
      if (Math.abs(drift) <= 1) return true;
    }
    return false;
  }

  /**
   * Один общий seek на источник и готовые ведомые — как ручная перемотка:
   * все прыгают одновременно и сохраняют относительную синхронизацию.
   */
  async _seekAll(source, followers) {
    const members = [source, ...followers.filter(Boolean)];
    if (!members.length) return [];
    const sv = await source.measure().catch(() => null);
    if (!sv || sv.position === null || !sv.playing) return [];

    const target = Math.round(sv.position + Math.max(0, (Date.now() - sv.at) / 1000));
    await Promise.allSettled(members.map((r) => r.client?.seek(target)));
    await sleep(500);

    const views = await Promise.all(members.map((r) => r.measure().catch(() => null)));
    const srcView = views[0];
    if (!srcView || srcView.position === null || !srcView.playing) return [];
    const now = Date.now();
    const srcPos = srcView.position + (now - srcView.at) / 1000;
    return members.filter((_, i) => {
      const v = views[i];
      if (!v || v.position === null || !v.playing) return false;
      const pos = v.position + (now - v.at) / 1000;
      return Math.abs(pos - srcPos) <= 1;
    });
  }

  /** Быстро догнать источник по текущей позиции. */
  async _followLive(follower) {
    const source = this.m.runtimes.get(this.sourceId);
    if (!source) return false;
    const sv = await source.measure().catch(() => null);
    if (!sv || sv.position === null) return false;
    if (sv.playing) return this._alignFollowerLive(follower, source);

    await this._holdPaused(follower, { timeout: 2000 });
    const ok = await this._seekPaused(follower, Math.round(sv.position));
    // Seek на стоящей колонке сам возобновляет playback.
    await follower.client?.pause().catch(() => {});
    return ok;
  }

  /** Источник на паузе: просто ставим ведомых в ту же секунду. */
  async _syncPaused() {
    const source = this.m.runtimes.get(this.sourceId);
    const src = await source?.measure().catch(() => null);
    if (!src || src.position === null) return;
    const target = Math.round(src.position);
    await Promise.allSettled(
      this._followers().map(async (f) => {
        await this._holdPaused(f, { timeout: 2000 });
        await this._seekPaused(f, target);
        // Seek на стоящей колонке сам возобновляет playback — гасим обратно.
        await f.client?.pause().catch(() => {});
      }),
    );
  }

  /**
   * Выравнивание ведомых под играющий источник. Источник не трогаем: он
   * остаётся точкой отсчёта. Ошибка после одного точного seek — десятки мс.
   */
  async _alignFollowers(
    followers,
    { rounds = 3, tolerance = SYNC_FINE_MS, initialSeek = true, srcFit: initialFit = null } = {},
  ) {
    const source = this.m.runtimes.get(this.sourceId);
    const list = followers.filter(Boolean);
    if (!source || !list.length || !this._running()) return;

    let srcFit = initialFit || (await this._sourcePhase(source));
    if (!srcFit) return;

    if (initialSeek) {
      await Promise.all(
        list.map(async (f) => {
          const known = this._latency.get(f.cfg.id) || 120;
          const res = await this._timedSeek(f, srcFit, known);
          if (res.appliedAt) {
            this._latency.set(f.cfg.id, res.appliedAt - res.sentAt);
            console.log(
              new Date().toISOString().slice(11, 19),
              `[мультирум] ${f.cfg.name}: задержка seek ${Math.round(res.appliedAt - res.sentAt)} мс`,
            );
          }
        }),
      );
      await sleep(400);
    }

    for (let round = 0; round < rounds; round++) {
      if (!this._running()) return;
      const fits = await this._measurePhase([source, ...list]);
      srcFit = fits.get(source.cfg.id) || srcFit;
      let again = false;
      for (const f of list) {
        const ff = fits.get(f.cfg.id);
        if (!ff) {
          again = true;
          console.log(new Date().toISOString().slice(11, 19), `[мультирум] ${f.cfg.name}: фаза не измерилась, ждём`);
          continue;
        }
        const delta = this._phaseOffsetMs(srcFit, ff, srcFit.pos);
        console.log(
          new Date().toISOString().slice(11, 19),
          `[мультирум] ${f.cfg.name}: расхождение ${Math.round(delta)} мс`,
        );
        if (Math.abs(delta) > tolerance) {
          // компенсируем задержку seek на измеренный промах
          const next = (this._latency.get(f.cfg.id) || 120) + delta;
          this._latency.set(f.cfg.id, next);
          const res = await this._timedSeek(f, srcFit, next);
          if (res.appliedAt) this._latency.set(f.cfg.id, res.appliedAt - res.sentAt);
          await sleep(400);
          again = true;
        }
      }
      if (!again) break;
      await sleep(300);
    }
    this._lastAlign = Date.now();
  }

  // ───────────────────────────── monitor ─────────────────────────────

  _startMonitor() {
    this._stopMonitor();
    this._pausedTicks = 0;
    this._srcTrackId = this.m.runtimes.get(this.sourceId)?.track?.track_id ?? null;
    this._mismatch = new Map();
    this._lastAlign = Date.now();
    this._nextTickAt = Date.now() + SYNC_INTERVAL_MS;
    const timer = setInterval(() => {
      if (Date.now() < this._nextTickAt) return;
      this._nextTickAt += SYNC_INTERVAL_MS;
      // Дедлайн не должен отставать от реальности после долгого выравнивания.
      if (this._nextTickAt < Date.now()) this._nextTickAt = Date.now() + SYNC_INTERVAL_MS;
      this._tick().catch(() => {});
    }, 500);
    timer.unref?.();
    this._deadlineTimer = timer;
  }

  _stopMonitor() {
    if (this._deadlineTimer) clearInterval(this._deadlineTimer);
    this._deadlineTimer = null;
  }

  async _tick() {
    if (!this.active || this.busy || this._tickRunning) return;
    this._tickRunning = true;
    try {
      await this._tickBody();
    } finally {
      this._tickRunning = false;
    }
  }

  async _tickBody() {
    const source = this.m.runtimes.get(this.sourceId);
    if (!source || source.status !== 'connected' || !source.client?.connected) {
      await this.stop({ pause: true, reason: 'Колонка-источник отключилась' });
      return;
    }

    const src = await source.measure().catch(() => null);
    if (!src) return;

    this._pausedTicks = src.playing ? 0 : this._pausedTicks + 1;
    // Источник сам сменил трек — ведомые должны перезапуститься сразу.
    const srcChanged = Boolean(src.trackId && this._srcTrackId && src.trackId !== this._srcTrackId);
    if (src.trackId) this._srcTrackId = src.trackId;

    const followers = this._followers();
    if (!followers.length) {
      await this.stop({ pause: false, reason: 'В мультируме не осталось колонок' });
      return;
    }

    // Точная фаза играющей группы: один замер на колонку вместо грубого
    // сравнения двух секунд.
    let phaseFits = null;
    if (src.playing) {
      const candidates = followers.filter((f) => !this._linking.has(f.cfg.id));
      if (candidates.length) {
        phaseFits = await this._measurePhase([source, ...candidates], { samples: 4 });
      }
    }

    const drifters = [];
    for (const f of followers) {
      if (!this.active) return;
      if (this._linking.has(f.cfg.id)) continue;
      const v = await f.measure().catch(() => null);
      if (!v) continue;

      // Источник сменил трек (next/prev/автоплей) — ведомая запускает его заново.
      // Разовая рассинхронизация trackId (буферизация, seek) не повод
      // перезапускать трек: ждём несколько тиков подряд.
      const mismatch = Boolean(src.trackId && v.trackId && v.trackId !== src.trackId);
      if (mismatch) {
        const n = (this._mismatch.get(f.cfg.id) || 0) + 1;
        this._mismatch.set(f.cfg.id, n);
        if (srcChanged || n >= MISMATCH_CONFIRM_TICKS) {
          this._mismatch.delete(f.cfg.id);
          this._relink(f, src).catch(() => {});
        }
        continue;
      }
      this._mismatch.delete(f.cfg.id);

      // Ведомая не играет, хотя источник играет: догоняем по позиции,
      // а не запускаем с нуля.
      if (src.playing && !v.playing) {
        await this._followLive(f);
        continue;
      }
      if (!src.playing && v.playing && this._pausedTicks >= 1) {
        await f.client?.pause().catch(() => {});
        continue;
      }

      // Сверка по фазе: источник и ведомая играли в один и тот же момент,
      // поэтому сравнение корректно даже при ±0.5 c округления позиции.
      if (src.playing && v.playing && phaseFits) {
        const srcFit = phaseFits.get(source.cfg.id);
        const fit = phaseFits.get(f.cfg.id);
        if (!srcFit || !fit) continue;
        const driftMs = this._phaseOffsetMs(srcFit, fit, srcFit.pos);
        if (Math.abs(driftMs) >= SYNC_TOLERANCE_MS) {
          console.log(
            new Date().toISOString().slice(11, 19),
            `[мультирум] ${f.cfg.name}: расхождение ${Math.round(driftMs)} мс — выравниваем`,
          );
          drifters.push(f);
        }
      }
    }

    // Всех уехавших догоняем по текущей позиции: быстро и без длинного
    // замера фазы.
    if (drifters.length && this.active) {
      await Promise.allSettled(drifters.map((f) => this._followLive(f)));
    }

    // Колонки, не успевшие присоединиться, остаются в mute. Догоняем их
    // и только после успешного выравнивания возвращаем звук.
    if (this.active && this._joinMuted.size) {
      const pendingJoin = this._followers().filter(
        (f) => this._joinMuted.has(f.cfg.id) && !this._linking.has(f.cfg.id),
      );
      await Promise.allSettled(
        pendingJoin.map(async (f) => {
          const v = await f.measure().catch(() => null);
          if (!v || (src.trackId && v.trackId !== src.trackId)) return;
          if (await this._followLive(f)) await this._unmuteAfterJoin(f);
        }),
      );
    }
    this.m.notify();
  }

  /** Запустить на ведомой тот же трек и подстроить позицию под источник. */
  async _relink(follower, src) {
    if (this._linking.has(follower.cfg.id)) return;
    this._linking.add(follower.cfg.id);
    try {
      const link = deeplinkForTrack(src.trackId);
      if (!link) return;

      // deeplink запускает трек с нуля: глушим, чтобы не было слышно
      // вступления, и снимаем mute только после выравнивания.
      await this._muteForJoin(follower);
      await follower.client?.playDeeplink(link);

      const view = await this._awaitPlaying(follower, { trackId: src.trackId, timeout: 10_000 });
      if (!view) return;

      if (await this._followLive(follower)) {
        await this._unmuteAfterJoin(follower);
        console.log(new Date().toISOString().slice(11, 19), `[мультирум] ${follower.cfg.name} догнала трек`);
      }
    } finally {
      this._linking.delete(follower.cfg.id);
    }
  }

  // ───────────────────────────── commands ─────────────────────────────

  async command(id, name, value) {
    const master = this.m.runtimes.get(this.sourceId);
    if (!master) throw new Error('Мультирум не активен');

    // Колонка вне группы (или ещё не подключена) — управляем ею напрямую:
    // мультирум не должен «перехватывать» команду чужой колонки.
    if (!this.memberIds.includes(id)) {
      return this.m.get(id).command(name, value);
    }

    const members = this._members();

    if (name === 'playpause') name = master.track?.playing ? 'pause' : 'play';

    // next/prev: ведём по очереди источника, ведомые догоняют новый трек.
    if (name === 'next' || name === 'prev') {
      const oldId = master.track?.track_id;
      await master.command(name, value);

      const deadline = Date.now() + NEXT_DEADLINE_MS;
      let view = null;
      while (Date.now() < deadline) {
        view = await master.pollNow().catch(() => null);
        if (view?.trackId && view.trackId !== oldId) break;
        await sleep(300);
      }
      const src = view || (await master.pollNow().catch(() => null));
      if (src?.trackId) {
        this._srcTrackId = src.trackId;
        await Promise.allSettled(
          members.filter((r) => r.cfg.id !== this.sourceId).map((f) => this._relink(f, src)),
        );
      }
      return;
    }

    await Promise.allSettled(members.map((r) => r.command(name, value)));
    if (name === 'seek') await sleep(300);
    this.m.notify();
  }
}

export { deeplinkForTrack, fitPhase, timeAt, posAt };
export const MULTIROOM_SYNC_INTERVAL_MS = SYNC_INTERVAL_MS;
