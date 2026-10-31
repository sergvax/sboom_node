import fs from 'node:fs';
import { SpeakerClient } from './lib/speaker.js';
import { OP_MEDIA_COMMAND } from './lib/protocol.js';
import { field } from './lib/tlv.js';

const data = JSON.parse(fs.readFileSync('data/speakers.json', 'utf8'));
const cfgs = data.speakers;
const clients = new Map();

for (const cfg of cfgs) {
  const c = new SpeakerClient({
    host: cfg.host,
    port: cfg.port,
    token: cfg.token,
    clientId: cfg.clientId,
    clientName: cfg.clientName,
  });
  await c.connect();
  clients.set(cfg.name, c);
  c.on('event', (_raw, parsed) => {
    const body = parsed?.[5] ?? parsed?.[4];
    if (body === undefined) return;
    console.log(`  [push ${cfg.name}] ${JSON.stringify(body).slice(0, 400)}`);
  });
}
console.log('все подключены');

async function snap(name) {
  const c = clients.get(name);
  try {
    const st = await c.getState();
    const json = st?.raw ? JSON.parse(st.raw) : null;
    const md = await c.getMetadata();
    const player = json?.background_apps?.find((a) => a?.app_info?.systemName === 'music')?.state?.player;
    return {
      multiroom: json?.multiroom?.mode,
      mrEnabled: json?.multiroom?.enabled,
      sbercast: json?.sbercast,
      stPlaying: player?.playing,
      stPos: player?.position,
      stTitle: player?.info?.title,
      metaPlaying: md?.playing,
      metaPos: md?.position,
      metaTitle: md?.title,
    };
  } catch (e) {
    return { error: e.message };
  }
}

async function all(label) {
  console.log(`\n${label}`);
  for (const cfg of cfgs) console.log(' ', cfg.name, JSON.stringify(await snap(cfg.name)));
}

const master = clients.get('SberBoom');

await all('ДО');
console.log('\n▶ play на SberBoom');
await master.play();
await new Promise((r) => setTimeout(r, 2500));
await all('после play');

console.log('\n★ op=16 action=8 START_MULTIROOM');
await master._fireAndForget(field(OP_MEDIA_COMMAND, 2, field(1, 0, 8)));
await new Promise((r) => setTimeout(r, 8000));
await all('через 8 c после START_MULTIROOM');

console.log('\n⏸ pause везде (возврат в тишину)');
for (const c of clients.values()) await c.pause().catch(() => {});
await new Promise((r) => setTimeout(r, 1500));
await all('после pause');

for (const c of clients.values()) await c.close();
