import fs from 'node:fs';
import { SpeakerClient } from './lib/speaker.js';
import { OP_MEDIA_COMMAND } from './lib/protocol.js';
import { field } from './lib/tlv.js';

const data = JSON.parse(fs.readFileSync('data/speakers.json', 'utf8'));
const cfgs = data.speakers;
const clients = new Map();

async function connect(cfg) {
  const c = new SpeakerClient({
    host: cfg.host,
    port: cfg.port,
    token: cfg.token,
    clientId: cfg.clientId,
    clientName: cfg.clientName,
  });
  await c.connect();
  clients.set(cfg.name, c);
  return c;
}

async function snapshot(name) {
  const c = clients.get(name);
  try {
    const st = await c.getState();
    const json = st?.raw ? JSON.parse(st.raw) : null;
    const md = await c.getMetadata();
    const playing = json?.background_apps?.find((a) => a?.app_info?.systemName === 'music')?.state?.player;
    return {
      multiroom: json?.multiroom,
      sbercast: json?.sbercast,
      player: playing ? { playing: playing.playing, position: playing.position, title: playing.info?.title } : null,
      meta: md && { title: md.title, playing: md.playing, pos: md.position, dur: md.duration },
    };
  } catch (e) {
    return { error: e.message };
  }
}

const logEvent = (who, raw, parsed) => {
  const body = parsed?.[5] ?? parsed?.[4];
  if (body === undefined) return;
  const text = JSON.stringify(body).slice(0, 500);
  console.log(`  [push ${who}] ${text}`);
};

console.log('Подключаюсь…');
for (const cfg of cfgs) {
  const c = await connect(cfg);
  c.on('event', (raw, parsed) => logEvent(cfg.name, raw, parsed));
  console.log(`  ${cfg.name}: подключена`);
}

console.log('\nСнимок ДО:');
for (const cfg of cfgs) console.log(cfg.name, JSON.stringify(await snapshot(cfg.name)));

const master = clients.get('SberBoom');
console.log('\n=== отправляю op=16 action=8 (START_MULTIROOM) на SberBoom (без play) ===');
await master._fireAndForget(field(OP_MEDIA_COMMAND, 2, field(1, 0, 8)));
await new Promise((r) => setTimeout(r, 6000));

console.log('\nСнимок ПОСЛЕ action=8:');
for (const cfg of cfgs) console.log(cfg.name, JSON.stringify(await snapshot(cfg.name)));

for (const c of clients.values()) await c.close();
