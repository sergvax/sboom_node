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
  console.log(`\n=== ${cfg.name} ===`);
  for (let trial = 0; trial < 4; trial++) {
    await c.play(); await sleep(2500);
    let p = await player();
    const sentP = Date.now();
    await c.pause();
    // ждём, пока playing=false И позиция перестанет расти
    let prevPos = null, pausedAt = null;
    for (let i = 0; i < 20; i++) {
      p = await player();
      if (!p?.playing) { pausedAt = Date.now(); prevPos = p?.position; break; }
      await sleep(150);
    }
    if (!pausedAt) { console.log('  не удалось поставить на паузу'); continue; }
    // убедиться, что стоит: два замера подряд одинаковая позиция
    let stable = null;
    for (let i = 0; i < 6; i++) {
      const q = await player();
      if (q?.playing) { await c.pause(); await sleep(200); continue; }
      if (stable && q?.position === stable) break;
      stable = q?.position;
      await sleep(200);
    }
    const target = Math.min(180, (stable ?? 0) + 15);
    const sent = Date.now();
    await c.seek(target);
    let applied = null;
    for (let i = 0; i < 30; i++) {
      const q = await player();
      if (q?.position >= target) { applied = Date.now() - sent; break; }
      await sleep(120);
    }
    console.log(`  trial ${trial}: пауза за ${pausedAt - sentP} ms, стоит на ${stable}, seek→${target} применён через ${applied} ms`);
    await sleep(1500);
  }
  await c.close();
}
process.exit(0);
