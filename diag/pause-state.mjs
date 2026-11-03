import { SpeakerClient } from '../lib/speaker.js';
import { Store } from '../lib/store.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const store = new Store('data/speakers.json');
await store.load();
const cfg = store.data.speakers.find((s) => s.name === 'SberBoom Mini 2');
const c = new SpeakerClient({ host: cfg.host, port: cfg.port, token: cfg.token });
await c.connect();

console.log('=== play → pause: как быстро прошивка уходит в paused ===');
await c.play(); await sleep(2500);
let s = await c.getState();
console.log('после play:', JSON.stringify(s.player ?? s.media ?? null).slice(0, 300));
await c.pause();
for (let i = 0; i < 10; i++) {
  const st = await c.getState();
  const p = st.player ?? st.media?.player ?? null;
  console.log(`+${i * 300}ms`, p ? `playing=${p.playing} pos=${p.position} pending=${p.playingPending}` : JSON.stringify(st).slice(0,150));
  await sleep(300);
}

console.log('\n=== seek на стоящей колонке ===');
await c.pause(); await sleep(2000);
for (const target of [40, 70]) {
  const before = await c.getState();
  const p0 = before.player ?? before.media?.player;
  console.log(`до seek: pos=${p0?.position} playing=${p0?.playing}`);
  const sent = Date.now();
  await c.seek(target);
  let hit = null;
  for (let i = 0; i < 25; i++) {
    const st = await c.getState();
    const p = st.player ?? st.media?.player;
    if (p?.position >= target) { hit = Date.now() - sent; console.log(`seek ${target}: pos=${p.position} playing=${p.playing} через ${hit} ms`); break; }
    await sleep(150);
  }
  if (!hit) console.log(`seek ${target}: не применился за 3.75 c`);
  await sleep(2000);
  const after = await c.getState();
  const p1 = after.player ?? after.media?.player;
  console.log(`  +2 c: pos=${p1?.position} playing=${p1?.playing}`);
}

console.log('\n=== play на стоящей: продолжает с текущей позиции или с нуля? ===');
await c.pause(); await sleep(2000);
const b = await c.getState(); const bp = b.player ?? b.media?.player;
console.log('до play:', bp?.position, bp?.playing);
await c.play();
for (let i = 0; i < 6; i++) {
  const st = await c.getState(); const p = st.player ?? st.media?.player;
  console.log(`+${i*300}ms pos=${p?.position} playing=${p?.playing}`);
  await sleep(300);
}
await c.close();
process.exit(0);
