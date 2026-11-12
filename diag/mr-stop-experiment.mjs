/**
 * Эксперимент: как быстрее распустить нативный мультирум.
 *
 *   node diag/mr-stop-experiment.mjs            # все варианты по очереди
 *   node diag/mr-stop-experiment.mjs pause_all  # только один вариант
 *
 * Варианты:
 *   pause_all        — пауза на всех участниках (текущая реализация)
 *   pause_master     — пауза только на мастере
 *   stop_cmd         — MediaCommand STOP_MULTIROOM (op=16, oneof 3 = Empty)
 *   stop_cmd_field1  — STOP_MULTIROOM как command=3 в поле 1
 *   stop_cmd_both    — оба варианта сразу
 *   stop_cmd_pause   — STOP_MULTIROOM + пауза
 *   star_stop        — StarCommand multi_room_message.stop_multiroom
 *   star_stop_pause  — StarCommand + пауза
 */
import fs from 'node:fs';
import { SpeakerClient } from '../lib/speaker.js';
import { field } from '../lib/tlv.js';
import { OP_MEDIA_COMMAND, STAR_COMMAND_MULTI_ROOM_MESSAGE } from '../lib/protocol.js';

const cfg = JSON.parse(fs.readFileSync('data/speakers.json', 'utf8'));
const EMPTY = Buffer.alloc(0);
const DEEPLINK = 'sboom://track/178895117';
const MASTER_NAME = 'SberPortal';
const t0 = Date.now();
const log = (m) => console.log(`+${((Date.now() - t0) / 1000).toFixed(2)}s  ${m}`);

const clients = new Map();

async function connectAll() {
  for (const sp of cfg.speakers) {
    const c = new SpeakerClient({
      host: sp.host,
      port: sp.port,
      token: sp.token,
      clientId: sp.clientId,
      clientName: sp.clientName,
    });
    await c.connect();
    clients.set(sp.name, c);
  }
}

async function snap() {
  const rows = [];
  for (const [name, c] of clients) {
    try {
      const st = await c.getState();
      rows.push({ name, mode: st.multiroom?.mode ?? 'NONE', playing: Boolean(st.player?.playing) });
    } catch {
      rows.push({ name, mode: 'ERR', playing: false });
    }
  }
  return rows;
}

const grouped = (rows) => rows.some((r) => r.mode !== 'NONE');
const allNone = (rows) => rows.every((r) => r.mode === 'NONE');

/** Дождаться, пока группа соберётся (или timeout). */
async function ensureGroup() {
  let rows = await snap();
  if (grouped(rows)) return rows;
  const master = clients.get(MASTER_NAME) ?? [...clients.values()][0];
  for (let attempt = 0; attempt < 3; attempt++) {
    await master.playDeeplink(DEEPLINK).catch(() => {});
    await master.play().catch(() => {});
    const end = Date.now() + 6000;
    while (Date.now() < end) {
      const st = await master.getState();
      if (st.player?.playing) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    const res = await master.startMultiroom({ timeoutMs: 5000 });
    log(`START_MULTIROOM на ${MASTER_NAME} (попытка ${attempt + 1}): ${JSON.stringify(res)}`);
    const until = Date.now() + 15000;
    while (Date.now() < until) {
      rows = await snap();
      if (grouped(rows)) return rows;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return rows;
}

/** Замер: время от команды до состояния NONE у всех. */
async function measure(label, action) {
  console.log(`\n=== ${label} ===`);
  const before = await ensureGroup();
  console.log('  группа:', before.map((r) => `${r.name}:${r.mode}${r.playing ? '+' : '-'}`).join('  '));
  await action();
  const start = Date.now();
  let last = '';
  let dissolvedAt = null;
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    const rows = await snap();
    const line = rows.map((r) => `${r.name}:${r.mode}${r.playing ? '+' : '-'}`).join('  ');
    if (line !== last) {
      console.log(`  +${((Date.now() - start) / 1000).toFixed(2)}s  ${line}`);
      last = line;
    }
    if (allNone(rows)) {
      dissolvedAt = (Date.now() - start) / 1000;
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log(`  итог: ${dissolvedAt === null ? 'группа не распалась за 20 с' : dissolvedAt.toFixed(2) + ' с'}`);
  // оставить группу собранной для следующего теста
  await ensureGroup();
  return dissolvedAt;
}

const targets = () => [...clients.values()];
const master = () => clients.get(MASTER_NAME) ?? [...clients.values()][0];

const pauseAll = () => Promise.allSettled(targets().map((c) => c.pause().catch(() => {})));
const pauseMaster = () => master().pause().catch(() => {});
const stopCmdCurrent = (c) => c.stopMultiroom({ timeoutMs: 1200 }).catch(() => {});
const stopCmdField1 = (c) =>
  c._request(field(OP_MEDIA_COMMAND, 2, field(1, 0, 3)), 1200).then((raw) => raw.toString('hex')).catch(() => null);
const starStop = (c) => c.stopMultiroomStar({ timeoutMs: 1500 }).catch(() => null);

(async () => {
  await connectAll();
  const wanted = process.argv.slice(2);
  const tests = {
    pause_all: () => pauseAll(),
    pause_master: () => pauseMaster(),
    stop_cmd: () => Promise.all(targets().map(stopCmdCurrent)),
    stop_cmd_field1: () => Promise.all(targets().map(stopCmdField1)),
    stop_cmd_both: async () => {
      await Promise.all(targets().map((c) => Promise.all([stopCmdCurrent(c), stopCmdField1(c)])));
    },
    stop_cmd_pause: async () => {
      await Promise.all(targets().map(stopCmdCurrent));
      await pauseAll();
    },
    star_stop: () => Promise.all(targets().map(starStop)),
    star_stop_pause: async () => {
      await Promise.all(targets().map(starStop));
      await pauseAll();
    },
    pause_slaves_only: () =>
      Promise.allSettled(
        [...clients.entries()].filter(([n]) => n !== MASTER_NAME).map(([, c]) => c.pause().catch(() => {})),
      ),
    mute_all: () => Promise.allSettled(targets().map((c) => c.mute().catch(() => {}))),
    slave_play: () => clients.get('SberBoom')?.playDeeplink('sboom://track/48039222').catch(() => {}),
    seek_end: async () => {
      const st = await master().getState();
      const dur = st.player?.duration ?? 0;
      if (dur) await master().seek(Math.max(0, dur - 3)).catch(() => {});
    },
    slave_start_mr: () => clients.get('SberBoom')?.startMultiroom({ timeoutMs: 3000 }).catch(() => {}),
    pause_all_then_play: async () => {
      await pauseAll();
      await new Promise((r) => setTimeout(r, 2000));
      await master().play().catch(() => {});
    },
  };
  const list = wanted.length ? wanted : Object.keys(tests);
  for (const label of list) await measure(label, tests[label]);
  for (const c of clients.values()) c.close();
})();
