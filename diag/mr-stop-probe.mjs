/**
 * Живая диагностика роспуска нативного мультирума (SberCast).
 *
 *   node diag/mr-stop-probe.mjs              # пассивный срез: роли, версии, конфиг
 *   node diag/mr-stop-probe.mjs --group      # собрать группу и замерить роспуск паузой
 */
import fs from 'node:fs';
import { SpeakerClient } from '../lib/speaker.js';
import { field } from '../lib/tlv.js';

const cfg = JSON.parse(fs.readFileSync('data/speakers.json', 'utf8'));
const t0 = Date.now();
const log = (msg) => console.log(`+${((Date.now() - t0) / 1000).toFixed(2)}s  ${msg}`);

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

async function snapshot() {
  const rows = [];
  for (const [name, c] of clients) {
    try {
      const st = await c.getState();
      rows.push({
        name,
        mode: st.multiroom?.mode ?? 'NONE',
        playing: Boolean(st.player?.playing),
        track: st.player?.trackId ?? st.player?.track_id ?? null,
        position: st.player?.position ?? null,
      });
    } catch (err) {
      rows.push({ name, mode: 'ERR', playing: false, track: null, position: null, err: err.message });
    }
  }
  return rows;
}

const allNone = (rows) => rows.every((r) => r.mode === 'NONE');

/** Опрос каждые `interval` ms в течение `ms`. */
async function watch(ms, interval = 400) {
  const timeline = [];
  const end = Date.now() + ms;
  while (Date.now() <= end) {
    const rows = await snapshot();
    timeline.push({
      t: (Date.now() - t0) / 1000,
      line: rows.map((r) => `${r.name}:${r.mode}${r.playing ? '+' : '-'}`).join('  '),
    });
    if (allNone(rows)) return timeline;
    await new Promise((r) => setTimeout(r, interval));
  }
  return timeline;
}


(async () => {
  await connectAll();
  for (const [name, c] of clients) {
    const st = await c.getState();
    console.log(`── ${name}  mode=${st.multiroom?.mode ?? 'NONE'}  playing=${Boolean(st.player?.playing)}  track=${st.player?.trackId ?? ''}`);
    console.log('   state keys :', Object.keys(st).join(', '));
    console.log('   multiroom  :', JSON.stringify(st.multiroom ?? null));
    console.log('   device     :', JSON.stringify(st.device ?? null));
  }
  for (const c of clients.values()) c.close();
})();
