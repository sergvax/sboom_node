/**
 * A/B: одна пауза против паузы + повтор через 6 с. По 2 повтора каждого.
 */
import fs from 'node:fs';
import { SpeakerClient } from '../lib/speaker.js';
const cfg = JSON.parse(fs.readFileSync('data/speakers.json', 'utf8'));
const DEEPLINK = 'sboom://track/133828181';
const MASTER = 'SberPortal';
const clients = new Map();
for (const sp of cfg.speakers) {
  const c = new SpeakerClient({ host: sp.host, port: sp.port, token: sp.token, clientId: sp.clientId, clientName: sp.clientName });
  await c.connect();
  clients.set(sp.name, c);
}
const modes = async () => {
  const out = {};
  for (const [n, c] of clients) {
    const st = await c.getState();
    out[n] = { mode: st.multiroom?.mode ?? 'NONE', playing: Boolean(st.player?.playing) };
  }
  return out;
};
const str = (m) => Object.entries(m).map(([n, v]) => `${n}:${v.mode}${v.playing ? '+' : '-'}`).join('  ');
const none = (m) => Object.values(m).every((v) => v.mode === 'NONE');
const some = (m) => Object.values(m).some((v) => v.mode !== 'NONE');
async function formGroup() {
  const m = clients.get(MASTER);
  for (let i = 0; i < 4; i++) {
    await m.playDeeplink(DEEPLINK).catch(() => {});
    await m.play().catch(() => {});
    await new Promise((r) => setTimeout(r, 4000));
    await m.startMultiroom({ timeoutMs: 5000 }).catch(() => {});
    const end = Date.now() + 12000;
    while (Date.now() < end) {
      const cur = await modes();
      if (some(cur)) return cur;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return await modes();
}
const pauseAll = () => Promise.allSettled([...clients.values()].map((c) => c.pause().catch(() => {})));

for (const mode of ['single', 'repause']) {
  for (let rep = 1; rep <= 2; rep++) {
    const g = await formGroup();
    console.log(`\n[${mode} rep${rep}] группа: ${str(g)}`);
    const t0 = Date.now();
    await pauseAll();
    if (mode === 'repause') setTimeout(pauseAll, 6000);
    let last = '';
    while (Date.now() - t0 < 30000) {
      const cur = await modes();
      const s = str(cur);
      if (s !== last) { console.log(`  +${((Date.now() - t0) / 1000).toFixed(2)}s  ${s}`); last = s; }
      if (none(cur)) { console.log(`  → распалась за ${((Date.now() - t0) / 1000).toFixed(2)} с`); break; }
      await new Promise((r) => setTimeout(r, 400));
    }
  }
}
for (const c of clients.values()) c.close();
