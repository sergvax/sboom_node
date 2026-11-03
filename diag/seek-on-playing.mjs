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

// колонка играет
await c.play(); await sleep(3000);
console.log('=== seek на ИГРАЮЩЕЙ колонке (игнорируется?) ===');
for (const target of [30, 100]) {
  const p0 = await player();
  const sent = Date.now();
  await c.seek(target);
  for (let i = 0; i < 8; i++) {
    const p = await player();
    console.log(`+${Date.now()-sent}ms pos=${p?.position} playing=${p?.playing}`);
    await sleep(300);
  }
  console.log('---');
}

console.log('\n=== setPlaybackSpeed (op=23) работает ли на игре? ===');
const p1 = await player();
console.log('до:', p1?.position, 'speed', p1?.playbackSpeedRate);
await c.setPlaybackSpeed(1.05);
for (let i = 0; i < 6; i++) { const p = await player(); console.log(`+${i*400}ms pos=${p?.position} speed=${p?.playbackSpeedRate}`); await sleep(400); }
await c.setPlaybackSpeed(1);

console.log('\n=== точность позиции: 5 замеров подряд на играющей ===');
for (let i = 0; i < 6; i++) { const p = await player(); console.log(`t=${(Date.now()/1000).toFixed(3)} pos=${p?.position}`); await sleep(200); }
await c.close(); process.exit(0);
