/**
 * Последняя гипотеза мгновенного выхода: StarCommand 140 (multi_room_message)
 * со stop_multiroom и правильным master_cast_device_id.
 */
import fs from 'node:fs';
import { SpeakerClient } from '../lib/speaker.js';
const cfg = JSON.parse(fs.readFileSync('data/speakers.json', 'utf8'));
const clients = new Map();
for (const sp of cfg.speakers) {
  const c = new SpeakerClient({ host: sp.host, port: sp.port, token: sp.token, clientId: sp.clientId, clientName: sp.clientName });
  await c.connect();
  clients.set(sp.name, c);
}
const master = clients.get('SberPortal');
await master.playDeeplink('sboom://track/133828181');
await master.play();
await master.startMultiroom({ timeoutMs: 5000 });
await new Promise((r) => setTimeout(r, 6000));
const st = await master.getState();
const ids = (st.sbercast?.devices ?? []).map((d) => d.id ?? d);
console.log('cast-устройства:', ids.join(', '));
const snap = async () => {
  const out = [];
  for (const [n, c] of clients) {
    const s = await c.getState();
    out.push(`${n}:${s.multiroom?.mode ?? 'NONE'}${s.player?.playing ? '+' : '-'}`);
  }
  return out.join(' ');
};
for (const id of ids) {
  const reply = await master.stopMultiroomStar({ masterCastDeviceId: id, timeoutMs: 3000 }).catch((e) => ({ error: e.message }));
  await new Promise((r) => setTimeout(r, 3000));
  console.log(`stop_multiroom (masterCastDeviceId=${id}) → ${JSON.stringify(reply)}; состояния: ${await snap()}`);
}
for (const c of clients.values()) c.close();
