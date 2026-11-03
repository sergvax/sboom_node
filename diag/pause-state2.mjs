import { SpeakerClient } from '../lib/speaker.js';
import { Store } from '../lib/store.js';
import { mediaPlayerFromState } from '../lib/parsers.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const store = new Store('data/speakers.json');
await store.load();
const cfg = store.data.speakers.find((s) => s.name === 'SberBoom Mini 2');
const c = new SpeakerClient({ host: cfg.host, port: cfg.port, token: cfg.token });
await c.connect();

const player = async () => {
  const st = await c.getState();
  let json = null; try { json = JSON.parse(st.raw); } catch {}
  const media = mediaPlayerFromState(json);
  return media?.player ?? null;
};

console.log('=== play → pause: переход в paused ===');
await c.play(); await sleep(2500);
console.log('после play:', JSON.stringify(await player()));
const tPause = Date.now();
await c.pause();
for (let i = 0; i < 12; i++) {
  const p = await player();
  console.log(`+${Date.now() - tPause}ms playing=${p?.playing} pos=${p?.position} pending=${p?.playingPending}`);
  if (!p?.playing) break;
  await sleep(250);
}

console.log('\n=== seek на стоящей колонке ===');
await c.pause(); await sleep(1500);
for (const target of [40, 70]) {
  console.log('до seek:', JSON.stringify(await player()));
  const sent = Date.now();
  await c.seek(target);
  let hit = null;
  for (let i = 0; i < 30; i++) {
    const p = await player();
    if (p?.position >= target) { hit = Date.now() - sent; console.log(`seek ${target}: pos=${p.position} playing=${p.playing} через ${hit} ms`); break; }
    await sleep(150);
  }
  if (!hit) console.log(`seek ${target}: не применился за 4.5 c (последняя: ${JSON.stringify(await player())})`);
  await sleep(2500);
  console.log('  +2.5 c:', JSON.stringify(await player()));
}

console.log('\n=== play на стоящей: с текущей позиции или с нуля? ===');
await c.pause(); await sleep(1500);
console.log('до play:', JSON.stringify(await player()));
await c.play();
for (let i = 0; i < 6; i++) { console.log(`+${i*300}ms`, JSON.stringify(await player())); await sleep(300); }
await c.close(); process.exit(0);
