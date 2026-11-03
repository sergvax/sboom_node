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
  console.log(`\n=== ${cfg.name}: seek на играющей ===`);
  for (let trial = 0; trial < 3; trial++) {
    await c.play(); await sleep(2500);
    let p = await player();
    if (!p?.playing) { console.log('  не играет, пропускаем'); continue; }
    const cur = p.position;
    const target = Math.min((p.duration ?? 200) - 3, cur + 12);
    const sent = Date.now();
    await c.seek(target);
    let applied = null, overshoot = null;
    for (let i = 0; i < 40; i++) {
      const q = await player();
      if (q?.position >= target && applied === null) { applied = Date.now() - sent; }
      if (applied !== null && q?.position > target + 2) { overshoot = q.position; break; }
      await sleep(150);
    }
    const fin = await player();
    console.log(`  trial ${trial}: было ${cur}, seek→${target}, применён через ${applied} ms, финальная pos=${fin?.position} playing=${fin?.playing}`);
    await sleep(2000);
  }
  await c.close();
}
process.exit(0);
