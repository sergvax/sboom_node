import { SpeakerManager } from '../lib/manager.js';
import { Store } from '../lib/store.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const m = new SpeakerManager({ store: new Store(process.argv[2] || 'data/speakers.json') });
await m.init();
for (const r of m.runtimes.values()) await r.client?.connect().catch(() => {});
await sleep(2000);

const src = [...m.runtimes.values()].find((r) => r.cfg.name === 'SberBoom');
const fol = [...m.runtimes.values()].find((r) => r.cfg.name === 'SberBoom Mini 2');

console.log('=== сырые замеры источника (играет) ===');
await src.client.play(); await sleep(3000);
for (let i = 0; i < 8; i++) {
  const v = await src.pollNow();
  console.log(`src pos=${v.position} playing=${v.playing} buffering=${v.buffering} t=${(Date.now()/1000).toFixed(3)}`);
  await sleep(500);
}

console.log('\n=== seek на ведомой (paused), target = src+3 ===');
await fol.client.pause(); await sleep(800);
const sv = await src.pollNow();
const target = Math.round(sv.position) + 3;
const sentAt = Date.now();
await fol.client.seek(target);
for (let i = 0; i < 12; i++) {
  const v = await fol.pollNow();
  console.log(`+${Date.now() - sentAt}ms pos=${v.position} playing=${v.playing} buffering=${v.buffering} srcPos=${(await src.measure()).position}`);
  await sleep(400);
}

console.log('\n=== seek на ведомой (играет) ===');
await fol.client.play(); await sleep(1500);
const sv2 = await src.pollNow();
const t2 = Math.round(sv2.position) + 3;
const sent2 = Date.now();
await fol.client.seek(t2);
for (let i = 0; i < 12; i++) {
  const v = await fol.pollNow();
  const s = await src.pollNow();
  console.log(`+${Date.now() - sent2}ms folPos=${v.position} playing=${v.playing} srcPos=${s.position}`);
  await sleep(400);
}
process.exit(0);
