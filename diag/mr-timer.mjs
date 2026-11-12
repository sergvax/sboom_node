/**
 * Замер таймера роспуска нативного мультирума на живых колонках.
 *
 *   node diag/mr-timer.mjs                 # 3 варианта по 2 повтора
 *   node diag/mr-timer.mjs pause_master    # один вариант
 *
 * Фиксирует: момент, когда колонки реально встали на паузу, момент,
 * когда все роли стали NONE, и независимость ведомой колонки (play на ней).
 */
import fs from 'node:fs';
import { SpeakerClient } from '../lib/speaker.js';
import { field } from '../lib/tlv.js';
import { OP_MEDIA_COMMAND } from '../lib/protocol.js';

const cfg = JSON.parse(fs.readFileSync('data/speakers.json', 'utf8'));
const EMPTY = Buffer.alloc(0);
const DEEPLINK = 'sboom://track/143692509';
const OTHER = 'sboom://track/48039222';
const MASTER = 'SberPortal';
const SLAVES = ['SberBoom', 'SberBoom Mini 2'];

const clients = new Map();
async function connectAll() {
  for (const sp of cfg.speakers) {
    const c = new SpeakerClient({ host: sp.host, port: sp.port, token: sp.token, clientId: sp.clientId, clientName: sp.clientName });
    await c.connect();
    clients.set(sp.name, c);
  }
}

async function snap() {
  const out = {};
  for (const [name, c] of clients) {
    try {
      const st = await c.getState();
      out[name] = { mode: st.multiroom?.mode ?? 'NONE', playing: Boolean(st.player?.playing), track: st.player?.trackId ?? null, pos: st.player?.position ?? null };
    } catch {
      out[name] = { mode: 'ERR', playing: false, track: null, pos: null };
    }
  }
  return out;
}

const line = (s) => Object.entries(s).map(([n, v]) => `${n}:${v.mode}${v.playing ? '+' : '-'}#${v.track}`).join('  ');
const allNone = (s) => Object.values(s).every((v) => v.mode === 'NONE');
const anyGroup = (s) => Object.values(s).some((v) => v.mode !== 'NONE');

async function ensureGroup() {
  let s = await snap();
  if (anyGroup(s)) return s;
  const m = clients.get(MASTER);
  for (let i = 0; i < 3; i++) {
    await m.playDeeplink(DEEPLINK).catch(() => {});
    await m.play().catch(() => {});
    const end = Date.now() + 6000;
    while (Date.now() < end) {
      const st = await m.getState();
      if (st.player?.playing) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    await m.startMultiroom({ timeoutMs: 5000 });
    const until = Date.now() + 15000;
    while (Date.now() < until) {
      s = await snap();
      if (anyGroup(s)) return s;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return s;
}

const pause = (names) => Promise.allSettled(names.map((n) => clients.get(n).pause().catch(() => {})));

async function run(label, action, repauseAt = null) {
  console.log(`\n=== ${label} ===`);
  const before = await ensureGroup();
  console.log('  группа:', line(before));
  const sent = Date.now();
  await action();
  if (repauseAt) {
    setTimeout(() => action(), repauseAt);
  }
  let pausedAt = null;
  let last = '';
  let dissolved = null;
  const end = Date.now() + 25000;
  while (Date.now() < end) {
    const s = await snap();
    const l = line(s);
    if (l !== last) {
      console.log(`  +${((Date.now() - sent) / 1000).toFixed(2)}s  ${l}`);
      last = l;
    }
    if (pausedAt === null && Object.values(s).every((v) => !v.playing)) pausedAt = (Date.now() - sent) / 1000;
    if (allNone(s)) {
      dissolved = (Date.now() - sent) / 1000;
      break;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`  пауза видна через ${pausedAt?.toFixed(2)} с, группа распалась: ${dissolved === null ? 'нет за 25 с' : dissolved.toFixed(2) + ' с'}`);
  return dissolved;
}

(async () => {
  await connectAll();
  const wanted = process.argv.slice(2);
  const tests = wanted.length ? wanted : ['pause_master', 'pause_all', 'pause_slaves', 'pause_master_repause', 'slave_independent'];
  for (const t of tests) {
    if (t === 'pause_master') await run('пауза только мастера', () => pause([MASTER]));
    if (t === 'pause_all') await run('пауза всех (как сейчас)', () => pause([MASTER, ...SLAVES]));
    if (t === 'pause_slaves') await run('пауза только ведомых', () => pause(SLAVES));
    if (t === 'pause_master_repause') await run('пауза мастера + повтор через 6 с', () => pause([MASTER]), 6000);
    if (t === 'slave_independent') {
      console.log('\n=== может ли ведомая играть самостоятельно ===');
      const before = await ensureGroup();
      console.log('  группа:', line(before));
      await clients.get('SberBoom').playDeeplink(OTHER).catch(() => {});
      for (let i = 0; i < 12; i++) {
        console.log(`  +${i * 2}s  ${line(await snap())}`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }
  for (const c of clients.values()) c.close();
})();
