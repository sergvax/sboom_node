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
  console.log(`\n=== ${cfg.name}: стоит ли позиция на паузе (10 замеров) ===`);
  await c.pause(); await sleep(2000);
  const arr = [];
  for (let i = 0; i < 10; i++) { const p = await player(); arr.push(`${i*300}:${p?.position}/${p?.playing}`); await sleep(300); }
  console.log('  ' + arr.join(' '));
  await c.close();
}
process.exit(0);
