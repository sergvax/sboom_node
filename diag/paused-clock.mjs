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
  return mediaPlayerFromState(json)?.player ?? null;
};

console.log('=== стоит ли позиция на паузе? ===');
await c.pause(); await sleep(1500);
for (let i = 0; i < 8; i++) { const p = await player(); console.log(`+${i*400}ms pos=${p?.position} playing=${p?.playing}`); await sleep(400); }

console.log('\n=== pause → seek(target) → play(): где окажемся? ===');
await c.pause(); await sleep(1500);
const p0 = await player(); console.log('до: pos', p0?.position);
for (const target of [20, 60]) {
  const sent = Date.now();
  await c.seek(target);
  let applied = null;
  for (let i = 0; i < 25; i++) { const p = await player(); if (p?.position >= target) { applied = Date.now()-sent; break; } await sleep(120); }
  console.log(`seek ${target}: применён через ${applied} ms, playing=${(await player())?.playing}`);
  await c.pause(); await sleep(800);   // вернуть в паузу
  const pp = await player();
  console.log(`  после pause: pos=${pp?.position} playing=${pp?.playing}`);
  await c.play();
  for (let i = 0; i < 5; i++) { const p = await player(); console.log(`  play +${i*300}ms pos=${p?.position} playing=${p?.playing}`); await sleep(300); }
  await c.pause(); await sleep(1200);
}
await c.close(); process.exit(0);
