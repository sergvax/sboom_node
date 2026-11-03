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

// 1) многократный seek на играющей колонке: перемещается ли позиция каждый раз?
await c.play(); await sleep(2000);
console.log('=== 6 seeks на играющей, target растёт ===');
const targets = [50, 80, 110, 140, 170, 190];
for (const t of targets) {
  const sent = Date.now();
  await c.seek(t);
  let seen = [];
  for (let i = 0; i < 12; i++) { const p = await player(); seen.push(`${Date.now()-sent}:${p?.position}`); await sleep(250); }
  console.log(`seek ${t} → ${seen.join(' ')}`);
  await sleep(500);
}

// 2) скорость: измерим реальный темп позиции при rate=1.1 и 0.9
console.log('\n=== реальный темп позиции при playbackSpeedRate ===');
for (const rate of [1, 1.1, 0.9, 1]) {
  await c.setPlaybackSpeed(rate);
  await sleep(1500);
  const samples = [];
  for (let i = 0; i < 20; i++) { const p = await player(); samples.push({ t: Date.now(), pos: p?.position }); await sleep(200); }
  const dt = (samples[samples.length-1].t - samples[0].t)/1000;
  const dp = samples[samples.length-1].pos - samples[0].pos;
  console.log(`rate=${rate}: Δpos=${dp} за ${dt.toFixed(2)} c → темп ${(dp/dt).toFixed(3)}`);
}
await c.setPlaybackSpeed(1);
await c.close(); process.exit(0);
