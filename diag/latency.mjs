import { SpeakerManager } from '../lib/manager.js';
import { Store } from '../lib/store.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const m = new SpeakerManager({ store: new Store(process.argv[2] || 'data/speakers.json') });
await m.init();
for (const r of m.runtimes.values()) await r.client?.connect().catch(() => {});
await sleep(1500);

for (const r of m.runtimes.values()) {
  if (!r.client?.connected) continue;
  console.log(`\n=== ${r.cfg.name} ===`);
  for (let trial = 0; trial < 3; trial++) {
    await r.client.pause(); await sleep(1200);
    const v0 = await r.pollNow();
    const target = Math.max(5, (v0.position ?? 0) + 10);
    const sentAt = Date.now();
    await r.client.seek(target);
    // ловим момент, когда позиция впервые станет >= target
    let applied = null;
    for (let i = 0; i < 25; i++) {
      const v = await r.pollNow();
      if (v.position !== null && v.position >= target) { applied = Date.now(); break; }
      await sleep(200);
    }
    console.log(`trial ${trial}: sent=${target} applied after ${applied ? Math.round(applied - sentAt) : '—'} ms`);
    await sleep(1500);
  }
}
process.exit(0);
