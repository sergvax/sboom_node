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
  console.log(`\n=== ${cfg.name}: play → pause → seek(T) → wait → play → измерить ===`);
  await c.play(); await sleep(2500);
  for (let trial = 0; trial < 3; trial++) {
    await c.pause();
    let paused = false;
    for (let i = 0; i < 15; i++) { const p = await player(); if (!p?.playing) { paused = true; break; } await sleep(150); }
    if (!paused) { console.log('  пауза не сработала'); continue; }
    // убедиться, что стоит: два одинаковых замера
    let pos = null;
    for (let i = 0; i < 8; i++) { const p = await player(); if (p?.playing) { await c.pause(); await sleep(200); continue; } if (pos === p?.position) break; pos = p?.position; await sleep(200); }
    const T = Math.min((await player())?.duration ?? 200, (pos ?? 0) + 15);
    const sent = Date.now();
    await c.seek(T);
    let applied = null;
    for (let i = 0; i < 40; i++) { const p = await player(); if (p?.position >= T) { applied = Date.now() - sent; break; } await sleep(120); }
    // стоит ли на паузе после seek?
    const afterSeek = await player();
    console.log(`  trial ${trial}: стояла на ${pos}, seek→${T} применён через ${applied} ms, playing=${afterSeek?.playing}`);
    if (afterSeek?.playing) { await c.pause(); for (let i=0;i<12;i++){ const p=await player(); if(!p?.playing) break; await sleep(150);} }
    // теперь play и посмотрим, где реально окажемся через 1.5 c
    await c.play();
    const samples = [];
    for (let i = 0; i < 8; i++) { const p = await player(); samples.push(`${i*250}:${p?.position}`); await sleep(250); }
    console.log(`    после play: ${samples.join(' ')}`);
    await sleep(1500);
  }
  await c.close();
}
process.exit(0);
