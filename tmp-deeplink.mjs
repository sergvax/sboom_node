import fs from 'node:fs';
import { SpeakerClient } from './lib/speaker.js';

const data = JSON.parse(fs.readFileSync('data/speakers.json', 'utf8'));
const cfg = data.speakers.find((s) => s.name === 'SberBoom Mini 2');
const c = new SpeakerClient({ host: cfg.host, port: cfg.port, token: cfg.token, clientId: cfg.clientId, clientName: cfg.clientName });
await c.connect();
console.log('подключена');

for (const url of ['staros://music?tid=132395799&pt=track']) {
  console.log('→', url);
  const res = await c.playDeeplink(url);
  console.log('ответ:', JSON.stringify(res));
}

await new Promise((r) => setTimeout(r, 4000));
const md = await c.getMetadata();
const st = await c.getState();
const json = st?.raw ? JSON.parse(st.raw) : null;
const p = json?.background_apps?.find((a) => a?.app_info?.systemName === 'music')?.state?.player;
console.log('meta:', md && { title: md.title, artists: md.artists, id: md.track_id, playing: md.playing, pos: md.position, dur: md.duration, source: md.media_source, provider: md.provider });
console.log('state player:', p && { playing: p.playing, pos: p.position, title: p.info?.title, trackId: p.info?.trackId });

await c.pause().catch(() => {});
await c.close();
