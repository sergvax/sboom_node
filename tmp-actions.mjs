import fs from 'node:fs';
import { SpeakerClient } from './lib/speaker.js';

const data = JSON.parse(fs.readFileSync('data/speakers.json', 'utf8'));
const cfg = data.speakers.find((s) => s.name === 'SberBoom Mini 2');
const c = new SpeakerClient({ host: cfg.host, port: cfg.port, token: cfg.token, clientId: cfg.clientId, clientName: cfg.clientName });
await c.connect();

const names = [
  'MULTIROOM', 'MULTI_ROOM', 'START_MULTIROOM', 'MULTIROOM_START', 'MULTI_ROOM_COMMAND',
  'GROUP_MANAGEMENT', 'SET_DEVICE_BACKEND_GROUP', 'GET_DEVICE_BACKEND_GROUP', 'DEVICE_GROUP',
  'START_MULTIROOM_PLAYBACK', 'MUSIC_MULTIROOM',
];
const payloads = [{}, { devices: [] }, { mode: 'MASTER' }];

for (const name of names) {
  for (const payload of payloads) {
    try {
      const res = await c.sendServerAction(name, payload, 3000);
      console.log(`${name} ${JSON.stringify(payload)} → ${JSON.stringify(res).slice(0, 220)}`);
    } catch (e) {
      console.log(`${name} ${JSON.stringify(payload)} → ERR ${e.message}`);
    }
  }
}

await c.close();
