import { SpeakerClient } from '../lib/speaker.js';
import { Store } from '../lib/store.js';
import { mediaPlayerFromState } from '../lib/parsers.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const store = new Store('data/speakers.json');
await store.load();
for (const cfg of store.data.speakers) {
  const c = new SpeakerClient({ host: cfg.host, port: cfg.port, token: cfg.token });
  await c.connect();
  const player = async () => {
    const st = await c.getState();
    let json = null; try { json = JSON.parse(st.raw); } catch {}
    return mediaPlayerFromState(json)?.player ?? null;
  };
  console.log(`\n=== ${cfg.name}: пауза → seek(T) → play → позиция сразу после play ===`);
  await c.play(); await sleep(3000);
  for (let trial = 0; trial < 6; trial++) {
    await c.pause();
    let ok = false;
    for (let i = 0; i < 15; i++) { const p = await player(); if (!p?.playing) { ok = true; break; } await sleep(120); }
    if (!ok) { console.log('  пауза не применена'); continue; }
    let prev = null, stable = null;
    for (let i = 0; i < 8; i++) { const p = await player(); if (p?.playing) { await c.pause(); await sleep(150); continue; } if (prev === p?.position) { stable = p.position; break; } prev = p?.position; await sleep(200); }
    if (stable === null) { console.log('  позиция не стабилизировалась'); continue; }
    const dur = (await player())?.duration ?? 200;
    const T = Math.min(dur - 3, stable + 18);
    await c.seek(T);
    let at = null;
    for (let i = 0; i < 40; i++) { const p = await player(); if (p?.position === T) { at = Date.now(); break; } await sleep(100); }
    if (!at) { console.log(`  seek→${T} не применён`); continue; }
    await c.play();
    const post = await player();
    console.log(`  trial ${trial}: стояла на ${stable}, T=${T}, после play pos=${post?.position} (ошибка ${post?.position - T} c)`);
    await sleep(2500);
  }
  await c.close();
}
process.exit(0);
