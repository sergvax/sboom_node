import fs from 'node:fs';
import { SpeakerClient } from './lib/speaker.js';
import { OP_MEDIA_COMMAND } from './lib/protocol.js';
import { field } from './lib/tlv.js';

const data = JSON.parse(fs.readFileSync('data/speakers.json', 'utf8'));
const cfgs = data.speakers;
const clients = new Map();

for (const cfg of cfgs) {
  const c = new SpeakerClient({ host: cfg.host, port: cfg.port, token: cfg.token, clientId: cfg.clientId, clientName: cfg.clientName });
  await c.connect();
  clients.set(cfg.name, c);
  c.on('event', (_raw, parsed) => {
    const keys = Object.keys(parsed).filter((k) => !['1', '2', '3', '6', '7', '10', '11'].includes(k));
    const body = parsed[5] ?? parsed[4];
    if (body !== undefined && !(body && typeof body === 'object' && '16' in body && body[16] === '')) {
      console.log(`  [push ${cfg.name}] keys=${keys.join(',')} ${JSON.stringify(body).slice(0, 300)}`);
    }
  });
}

const master = clients.get('SberBoom');
const snap = async (name) => {
  try {
    const st = await clients.get(name).getState();
    const json = st?.raw ? JSON.parse(st.raw) : null;
    const p = json?.background_apps?.find((a) => a?.app_info?.systemName === 'music')?.state?.player;
    return `${name}: play=${p?.playing ?? '-'} pos=${p?.position ?? '-'} mr=${json?.multiroom?.mode ?? '-'} cast=${(json?.sbercast?.devices || []).length}`;
  } catch (e) {
    return `${name}: ERR ${e.message}`;
  }
};

console.log('старт: понижаю громкость мастера до 25 и включаю play');
await master.setVolume(25);
await master.play();
await new Promise((r) => setTimeout(r, 3000));

console.log('★ action=8');
const t0 = Date.now();
await master._fireAndForget(field(OP_MEDIA_COMMAND, 2, field(1, 0, 8)));

for (let i = 1; i <= 9; i++) {
  await new Promise((r) => setTimeout(r, 10000));
  const line = [];
  for (const cfg of cfgs) line.push(await snap(cfg.name));
  console.log(`+${Math.round((Date.now() - t0) / 1000)}s | ${line.join(' | ')}`);
}

console.log('pause везде, громкость мастера обратно 65');
for (const c of clients.values()) await c.pause().catch(() => {});
await master.setVolume(65);
await new Promise((r) => setTimeout(r, 1500));
for (const cfg of cfgs) console.log(await snap(cfg.name));

for (const c of clients.values()) await c.close();
