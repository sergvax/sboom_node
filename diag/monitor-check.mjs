import { SpeakerClient } from '../lib/speaker.js';
import { Store } from '../lib/store.js';
import { mediaPlayerFromState } from '../lib/parsers.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const store = new Store('data/speakers.json');
await store.load();
const clients = [];
for (const cfg of store.data.speakers) {
  const c = new SpeakerClient({ host: cfg.host, port: cfg.port, token: cfg.token });
  await c.connect();
  clients.push({ name: cfg.name, c });
}

const snap = async () => {
  const out = [];
  for (const { name, c } of clients) {
    const st = await c.getState();
    let json = null; try { json = JSON.parse(st.raw); } catch {}
    const p = mediaPlayerFromState(json)?.player;
    out.push({ name, pos: p?.position, playing: p?.playing });
  }
  return out;
};

for (let i = 0; i < 12; i++) {
  const s = await snap();
  const t = new Date().toISOString().slice(11, 19);
  console.log(t, s.map((x) => `${x.name}=${x.pos}${x.playing ? '' : '(пауза)'}`).join('  '));
  await sleep(2000);
}
for (const { c } of clients) await c.close();
process.exit(0);
