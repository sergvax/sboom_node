import test from 'node:test';
import assert from 'node:assert/strict';

import { fitPhase, timeAt, posAt, deeplinkForTrack } from '../lib/multiroom.js';

/** Синтетическая колонка: играет с `startPos`, смещена на `offsetMs` относительно источника. */
function makeSpeaker({ startPos = 0, offsetMs = 0, duration = 300, name = 'sp' }) {
  const t0 = Date.now();
  return {
    cfg: { id: name, name },
    measure: async () => ({
      at: Date.now(),
      position: Math.floor((Date.now() - t0) / 1000) + startPos,
      duration,
      playing: true,
      pending: false,
      trackId: '1',
    }),
  };
}

test('fitPhase: идеальная синхронность даёт нулевое расхождение', () => {
  const tRef = 0;
  const src = [{ x: 0, p: 5 }, { x: 250, p: 5 }, { x: 500, p: 6 }, { x: 750, p: 6 }];
  const follower = [{ x: 30, p: 5 }, { x: 280, p: 5 }, { x: 530, p: 6 }, { x: 780, p: 6 }];

  const sf = { ...fitPhase(src), tRef };
  const ff = { ...fitPhase(follower), tRef };
  assert.ok(sf && ff);
  assert.equal(Math.abs(timeAt(ff, sf.pos) - timeAt(sf, sf.pos)), 30);
  // Смещение ровно 30 мс на всю длину окна.
  assert.equal(Math.round(posAt(sf, 6) - posAt(ff, 6)), 0);
});

test('fitPhase: ловит отстающую и убегающую вперёд колонку', () => {
  const tRef = 0;
  const src = [{ x: 0, p: 10 }, { x: 250, p: 10 }, { x: 500, p: 11 }, { x: 750, p: 11 }];
  const lag = [{ x: 400, p: 10 }, { x: 650, p: 10 }, { x: 900, p: 11 }, { x: 1150, p: 11 }];
  const ahead = [{ x: -300, p: 10 }, { x: -50, p: 10 }, { x: 200, p: 11 }, { x: 450, p: 11 }];

  const sf = { ...fitPhase(src), tRef };
  const lf = { ...fitPhase(lag), tRef };
  const af = { ...fitPhase(ahead), tRef };

  assert.equal(Math.round(timeAt(lf, sf.pos) - timeAt(sf, sf.pos)), 400);
  assert.equal(Math.round(timeAt(af, sf.pos) - timeAt(sf, sf.pos)), -300);
});

test('fitPhase: один замер — грубая, но не вымышленная фаза', () => {
  const fit = { ...fitPhase([{ x: 100, p: 7 }]), tRef: 0 };
  assert.ok(fit);
  assert.equal(fit.coarse, true);
  // Позиция растёт со временем с скоростью 1x; в момент замера она была 7.
  assert.equal(fit.pos, 7);
  assert.equal(timeAt(fit, 8) - timeAt(fit, 7), 1000);
});

test('fitPhase: колонка на паузе → нет фазы', () => {
  assert.equal(fitPhase([]), null);
});

test('timeAt/posAt — взаимныеInverse: позиция возвращается из времени', () => {
  const fit = { ...fitPhase([{ x: 1000, p: 4 }, { x: 2000, p: 5 }]), tRef: 0 };
  assert.equal(posAt(fit, timeAt(fit, 7)), 7);
});

test('deeplinkForTrack: только числовой ID', () => {
  assert.equal(deeplinkForTrack('123'), 'staros://music?tid=123&pt=track');
  assert.equal(deeplinkForTrack(123), 'staros://music?tid=123&pt=track');
  assert.equal(deeplinkForTrack('abc'), null);
  assert.equal(deeplinkForTrack(null), null);
});
