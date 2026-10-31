import fs from 'node:fs';
import { SpeakerClient } from './lib/speaker.js';
import { decode, field } from './lib/tlv.js';
import { OP_GET_META_DATA } from './lib/protocol.js';

const data = JSON.parse(fs.readFileSync('data/speakers.json', 'utf8'));
const byName = Object.fromEntries(data.speakers.map((s) => [s.name, s]));
const mk = async (name) => {
  const cfg = byName[name];
  const c = new SpeakerClient({ host: cfg.host, port: cfg.port, token: cfg.token, clientId: cfg.clientId, clientName: cfg.clientName });
  await c.connect();
  return c;
};

const a = await mk('SberBoom');
const b = await mk('SberBoom Mini 2');

const metaRequest = () => field(OP_GET_META_DATA, 2, field(1, 2, Buffer.alloc(0)));
const rawMeta = async (c) => {
  const raw = await c._request(metaRequest());
  const s = raw.toString('utf8');
  const i = s.indexOf('"position"');
  return i >= 0 ? s.slice(i, i + 90) : s.slice(0, 120);
};

console.log('позиция ДО (SberBoom):', await rawMeta(a));

await a.setVolume(15);
await b.setVolume(15);

console.log('\ndeeplink на Mini 2');
console.log((await b.playDeeplink('staros://music?tid=132395799&pt=track')).result);
await new Promise((r) => setTimeout(r, 2500));

await a.pause();
await b.pause();
await new Promise((r) => setTimeout(r, 500));
await a.seek(45);
await b.seek(45);
await new Promise((r) => setTimeout(r, 700));

console.log('\nplay одновременно');
const t0 = Date.now();
await Promise.all([a.play(), b.play()]);

for (let i = 0; i < 5; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const [ma, mb] = await Promise.all([rawMeta(a), rawMeta(b)]);
  console.log(`+${Math.round((Date.now() - t0) / 1000)}s`);
  console.log('  A', ma);
  console.log('  B', mb);
}

await Promise.all([a.pause(), b.pause()]);
await a.setVolume(65);
await new Promise((r) => setTimeout(r, 1000));
await Promise.all([a.close(), b.close()]);
