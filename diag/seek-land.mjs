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
  console.log(`\n=== ${cfg.name}: пауза → seek(T) → play, замер позиции сразу после play ===`);
  await c.play(); await sleep(3000);
  for (let trial = 0; trial < 4; trial++) {
    await c.pause();
    let ok = false;
    for (let i = 0; i < 15; i++) { const p = await player(); if (!p?.playing) { ok = true; break; } await sleep(120); }
    if (!ok) { console.log('  пауза не применена'); continue; }
    let cur = (await player())?.position ?? 0;
    const T = Math.min((await player())?.duration ?? 200, cur + 20);
    await c.seek(T);
    // ждём ровно до момента, когда позиция == T
    let applied = null;
    for (let i = 0; i < 40; i++) { const p = await player(); if (p?.position === T) { applied = Date.now(); break; } await sleep(100); }
    if (applied === null) { console.log('  seek не применён'); continue; }
    // позиция стоит? играем ли?
    const pre = await player();
    await c.play();
    const p1 = await player();
    console.log(`  trial ${trial}: T=${T}, playing перед play=${pre?.playing}, сразу после play pos=${p1?.position} (delta ${p1?.position - T})`);
    await sleep(2000);
  }
  await c.close();
}
process.exit(0);
